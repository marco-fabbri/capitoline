import type { RequestHandler } from "express";
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from "jose";
import type { Logger } from "../log.js";

export interface AccessOptions {
  teamDomain: string; audience: string; jwks?: ReturnType<typeof createLocalJWKSet>;
  /** What to call each service token in a usage row, by its client id; see `Identity.name`. */
  names?: Record<string, string>;
}

// What a verified token says about who is calling. A service token has no
// email and an empty subject, so without `name` two applications sharing the
// gateway are indistinguishable in the usage table.
//
// `name` is **not** the name typed into the Cloudflare dashboard. The
// service-token JWT carries `common_name`, and what Cloudflare puts there is
// the client id (`<32 hex>.access`); the friendly name stays in the dashboard
// and never reaches the token. Observed 2026-09-23, after a second
// application started calling and `/v1/usage` listed two opaque ids. So the
// id is translated here, through `server.access.callers`, and falls back to
// itself when the host has not named it — an unreadable caller is still a
// correct one.
export interface Identity { email?: string; sub: string; type: "user" | "service"; name?: string }

// A caller is written into every usage row, so what a token can put there is
// bounded here: the longest address an email may have.
const MAX_CALLER = 320;

/**
 * The name a usage row is attributed to, or null when nothing identified the
 * caller — Access verification disabled, or a token with nothing in it.
 *
 * The email first, because that is what an operator reading `/v1/usage`
 * recognises; then the service token's name; the subject last, as an opaque
 * but stable fallback. The parameter is bound to `Identity` so that renaming
 * or dropping one of its fields breaks here instead of silently falling
 * through to the next candidate; the runtime guards stay all the same,
 * because `res.locals` is untyped at runtime and a caller is never worth a
 * crash inside a request.
 */
export function callerOf(identity: Partial<Identity> | undefined | null): string | null {
  if (typeof identity !== "object" || identity === null) return null;
  const { email, name, sub } = identity;
  for (const value of [email, name, sub]) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed !== "") return trimmed.slice(0, MAX_CALLER);
  }
  return null;
}

// One body for every refusal, in the spec 8.3 shape, so the two 401 paths cannot drift.
const DENIED = { error: { message: "missing or invalid Cloudflare Access token", type: "invalid_request_error", code: "unauthorized" } };

// Cloudflare Access signs with RS256 and publishes ES256 keys too; both are
// asymmetric. Pinning them here rules out "none" and HMAC confusion by
// construction instead of by the library's defaults.
const ALGORITHMS = ["RS256", "ES256"];

// Tokens carry iat/nbf/exp; a host whose clock runs a few seconds behind
// Cloudflare would otherwise reject every request with a generic 401.
const CLOCK_TOLERANCE_S = 30;

export function createAccessMiddleware(opts: AccessOptions, log: Logger): RequestHandler {
  if (!opts.teamDomain) throw new Error("Cloudflare Access: teamDomain is required");
  if (!opts.audience) throw new Error("Cloudflare Access: audience is required (server.access.audience)");
  const issuer = `https://${opts.teamDomain}`;
  const jwks = opts.jwks ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  return async (req, res, next) => {
    const header = req.header("Cf-Access-Jwt-Assertion");
    const cookie = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(req.header("cookie") ?? "")?.[1];
    const token = header ?? cookie;
    if (!token) { res.status(401).json(DENIED); return; }
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer, audience: opts.audience, algorithms: ALGORITHMS, clockTolerance: CLOCK_TOLERANCE_S });
      const p = payload as { email?: string; sub?: string; common_name?: string };
      const name = p.common_name === undefined ? undefined : (opts.names?.[p.common_name] ?? p.common_name);
      const identity: Identity = { email: p.email, sub: p.sub ?? "", type: p.common_name ? "service" : "user", name };
      res.locals.identity = identity;
      next();
    } catch (e) {
      log.warn({ err: String(e) }, "access token rejected");
      res.status(401).json(DENIED);
    }
  };
}
