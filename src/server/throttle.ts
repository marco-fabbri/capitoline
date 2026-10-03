import type { Request, RequestHandler } from "express";

/**
 * A brake on wrong credentials for the administrators' routes.
 *
 * A key cannot be guessed, so this closes no hole: it keeps a sweep of guesses
 * from filling the journal and from being free. An address that was refused
 * (401 or 403) `limit` times within `windowMs` is answered 429 until the
 * window has moved past those refusals. A request that carries a live key is
 * never held back, whatever its address did before: an operator behind the
 * same address as a guesser is not locked out with it.
 *
 * In memory and per process, which is enough for what it is. The address is
 * the socket's, or the one a proxy on this host says it forwarded for.
 */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const MAX_TRACKED = 10_000;

export function clientAddress(req: Request): string {
  const socket = req.socket.remoteAddress ?? "unknown";
  if (!LOOPBACK.has(socket)) return socket;   // a header from a remote socket is only a claim
  const forwarded = req.header("cf-connecting-ip") ?? req.header("x-forwarded-for")?.split(",")[0];
  return forwarded?.trim() || socket;
}

export function createFailureThrottle(opts: { limit?: number; windowMs?: number; hasLiveKey?: (req: Request) => boolean; now?: () => number } = {}): RequestHandler {
  const limit = opts.limit ?? 10, windowMs = opts.windowMs ?? 5 * 60_000, now = opts.now ?? Date.now;
  const failures = new Map<string, number[]>();
  const recent = (address: string): number[] => {
    const kept = (failures.get(address) ?? []).filter((t) => t > now() - windowMs);
    if (kept.length === 0) failures.delete(address); else failures.set(address, kept);
    return kept;
  };
  return (req, res, next) => {
    const address = clientAddress(req);
    const seen = recent(address);
    if (seen.length >= limit && !opts.hasLiveKey?.(req)) {
      const retry = Math.max(1, Math.ceil((seen[0] + windowMs - now()) / 1000));
      res.status(429).setHeader("Retry-After", String(retry));
      res.json({ error: { message: "too many refused attempts from this address: try again later", type: "invalid_request_error", code: "rate_limited" } });
      return;
    }
    res.on("finish", () => {
      if (res.statusCode !== 401 && res.statusCode !== 403) return;
      if (failures.size >= MAX_TRACKED && !failures.has(address)) failures.clear();   // a flood of addresses: start over rather than grow
      failures.set(address, [...recent(address), now()]);
    });
    next();
  };
}
