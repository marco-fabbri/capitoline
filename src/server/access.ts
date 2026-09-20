import type { RequestHandler } from "express";
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from "jose";
import type { Logger } from "../log.js";

export interface AccessOptions { teamDomain: string; audience: string; jwks?: ReturnType<typeof createLocalJWKSet> }

export function createAccessMiddleware(opts: AccessOptions, log: Logger): RequestHandler {
  const issuer = `https://${opts.teamDomain}`;
  const jwks = opts.jwks ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  return async (req, res, next) => {
    const header = req.header("Cf-Access-Jwt-Assertion");
    const cookie = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(req.header("cookie") ?? "")?.[1];
    const token = header ?? cookie;
    if (!token) { res.status(401).json({ error: { message: "missing or invalid Cloudflare Access token", code: "unauthorized" } }); return; }
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer, audience: opts.audience });
      const p = payload as { email?: string; sub?: string; common_name?: string };
      res.locals.identity = { email: p.email, sub: p.sub ?? "", type: p.common_name ? "service" : "user" };
      next();
    } catch (e) {
      log.warn({ err: String(e) }, "access token rejected");
      res.status(401).json({ error: { message: "missing or invalid Cloudflare Access token", code: "unauthorized" } });
    }
  };
}
