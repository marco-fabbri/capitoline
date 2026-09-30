import type { RequestHandler } from "express";
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from "jose";
import type { Logger } from "../log.js";

export interface AccessOptions {
  teamDomain: string; audience: string; jwks?: ReturnType<typeof createLocalJWKSet>;
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
// id is what a usage row stores, always, and `server.access.callers` gives it
// a readable name where `/v1/usage` reports it. Translating on the way in
// instead would freeze each row under whatever name was configured when it
// was written: the rows app-one wrote in the hour before its id was mapped
// would have stayed opaque for ever, and renaming an application would leave
// its past under the old name.
export interface Identity { email?: string; sub: string; type: "user" | "service" | "key"; name?: string }

/** What the auth middleware needs from the store: the gateway's own keys (src/usage/store.ts). */
export interface KeyAuthenticator { authenticateKey(key: string): { name: string } | null; hasKeys(): boolean }

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
const DENIED = { error: { message: "missing or invalid credentials: an API key (Authorization: Bearer) or a Cloudflare Access token", type: "invalid_request_error", code: "unauthorized" } };

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
      const identity: Identity = { email: p.email, sub: p.sub ?? "", type: p.common_name ? "service" : "user", name: p.common_name };
      res.locals.identity = identity;
      next();
    } catch (e) {
      log.warn({ err: String(e) }, "access token rejected");
      res.status(401).json(DENIED);
    }
  };
}

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * The gateway's two identities, in one middleware (design §4): a key it
 * issued itself, sent as `Authorization: Bearer cap_…` — the header every
 * OpenAI client already sends — or the Cloudflare Access JWT the edge adds,
 * when Access is configured. A request that presents one of our keys is
 * judged on that key alone: a wrong key is refused even if a valid Access
 * token rides along, since a client sending both has a broken configuration
 * and should learn it. With no Access configured the gateway is open until
 * the first key exists (a developer machine), and closed from then on: the
 * first key is the decision that this gateway has callers to tell apart.
 */
/**
 * OAuth for the MCP endpoint (src/server/oauth.ts): the verifier of the tokens
 * it issues, and the metadata URL an unauthenticated /mcp call is pointed at.
 */
export interface OAuthResource {
  verifyAccessToken(token: string): Promise<{ extra?: Record<string, unknown> }>;
  resourceMetadataUrl: string;
}

export function createAuthMiddleware(opts: { access?: AccessOptions; keys: KeyAuthenticator; oauth?: OAuthResource }, log: Logger): RequestHandler {
  const access = opts.access ? createAccessMiddleware(opts.access, log) : undefined;
  const oauth = opts.oauth;
  // A 401 on /mcp tells an OAuth client where to sign in (RFC 9728): without
  // the pointer, Claude on the web has no way to find the authorization server.
  const refuseMcp = (res: Parameters<RequestHandler>[1], error?: string): void => {
    res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${oauth!.resourceMetadataUrl}"${error ? `, error="${error}"` : ""}`);
    res.status(401).json(DENIED);
  };
  return (req, res, next) => {
    const bearer = BEARER.exec(req.header("authorization") ?? "")?.[1];
    const mcp = oauth !== undefined && req.path === "/mcp";
    // An OAuth token stands in for the key its owner signed in with, on the
    // resource it was issued for and nowhere else: the HTTP API takes keys.
    if (bearer !== undefined && bearer.startsWith("capo_at_") && oauth) {
      if (!mcp) { res.status(401).json(DENIED); return; }
      oauth.verifyAccessToken(bearer).then((info) => {
        const name = typeof info.extra?.keyName === "string" ? info.extra.keyName : undefined;
        if (!name) { refuseMcp(res, "invalid_token"); return; }
        res.locals.identity = { type: "key", name, sub: `key:${name}` } satisfies Identity;
        next();
      }, () => { log.warn("oauth token rejected"); refuseMcp(res, "invalid_token"); });
      return;
    }
    if (bearer !== undefined && bearer.startsWith("cap_")) {
      const key = opts.keys.authenticateKey(bearer);
      if (!key) { log.warn("api key rejected"); res.status(401).json(DENIED); return; }
      res.locals.identity = { type: "key", name: key.name, sub: `key:${key.name}` } satisfies Identity;
      next();
      return;
    }
    // /mcp with no credential at all, when OAuth is on: the OAuth challenge,
    // unless the request carries what Cloudflare Access adds. With Access at
    // the edge and a Bypass for /mcp, that is how an OAuth client gets past
    // the gateway's own Access check to the challenge it needs.
    const accessCredential = req.header("cf-access-jwt-assertion") !== undefined || /(?:^|;\s*)CF_Authorization=/.test(req.header("cookie") ?? "");
    if (mcp && !accessCredential && (access || opts.keys.hasKeys())) { refuseMcp(res); return; }
    if (access) { access(req, res, next); return; }
    if (opts.keys.hasKeys()) { res.status(401).json(DENIED); return; }
    next();
  };
}
