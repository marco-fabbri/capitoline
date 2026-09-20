import type { RequestHandler } from "express";
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from "jose";
import type { Logger } from "../log.js";

export interface AccessOptions { teamDomain: string; audience: string; jwks?: ReturnType<typeof createLocalJWKSet> }

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
      res.locals.identity = { email: p.email, sub: p.sub ?? "", type: p.common_name ? "service" : "user" };
      next();
    } catch (e) {
      log.warn({ err: String(e) }, "access token rejected");
      res.status(401).json(DENIED);
    }
  };
}
