import { randomBytes, randomUUID } from "node:crypto";
import express, { type Response, type Router } from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidGrantError, InvalidTargetError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Logger } from "../log.js";
import type { OAuthTokenRow } from "../usage/store.js";

/**
 * OAuth for the MCP clients that cannot hold a key: Claude on the web, Desktop
 * and mobile reach a remote MCP server from Anthropic's cloud and authenticate
 * with OAuth only (claude.com/docs/connectors/building/authentication). The
 * authorization server itself is the MCP SDK's (`mcpAuthRouter`: discovery,
 * client registration, PKCE, the token endpoint); this is the provider it
 * calls, and what it adds is the one decision the SDK leaves open — who may
 * sign in.
 *
 * The answer is the gateway's own keys. Signing in is pasting a key once on
 * Capitoline's own page; the tokens the client gets are bound to that key's
 * name, so every call is recorded under it, the admins list applies to it
 * unchanged, and revoking the key ends every token it stood behind. No
 * account, no password: the key stays the identity, a token only stands in
 * for it where a key cannot be carried.
 *
 * A token is good for `/mcp` only, the resource it was issued for (the MCP
 * authorization spec binds tokens to their resource); the HTTP API keeps
 * taking keys.
 */
export const ACCESS_PREFIX = "capo_at_";
const REFRESH_PREFIX = "capo_rt_";
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 24 * 3600;
const CODE_TTL_MS = 5 * 60_000;
const PENDING_TTL_MS = 10 * 60_000;
// Wrong keys a pending sign-in may take before it is dropped: the key is 256
// random bits, so this bounds noise, not a search.
const MAX_ATTEMPTS = 5;

/** What the provider needs of the usage store. */
export interface OAuthStore {
  authenticateKey(key: string): { name: string } | null;
  isLiveKey(name: string): boolean;
  saveOAuthClient(clientId: string, metadata: string): void;
  oauthClient(clientId: string): string | null;
  saveOAuthToken(token: string, t: OAuthTokenRow, now?: number): void;
  oauthToken(token: string): OAuthTokenRow | null;
  deleteOAuthToken(token: string): boolean;
}

interface Pending { client: OAuthClientInformationFull; params: AuthorizationParams; expiresAt: number; attempts: number }
interface Code { clientId: string; redirectUri: string; codeChallenge: string; resource: string; scopes: string[]; keyName: string; expiresAt: number }

const token = (prefix: string): string => prefix + randomBytes(32).toString("base64url");

export class KeyOAuthProvider implements OAuthServerProvider {
  private readonly pending = new Map<string, Pending>();
  private readonly codes = new Map<string, Code>();
  readonly clientsStore: OAuthRegisteredClientsStore;

  constructor(
    private readonly store: OAuthStore,
    /** The MCP endpoint's URL: the one resource these tokens are for. */
    readonly resource: URL,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.clientsStore = {
      getClient: (id) => {
        const json = store.oauthClient(id);
        return json === null ? undefined : (JSON.parse(json) as OAuthClientInformationFull);
      },
      // The SDK's registration handler names the client before this is called
      // (clientIdGeneration, on by default); the type allows a store that
      // names it itself, so one is made here if none came.
      registerClient: (registering) => {
        const given = registering as Partial<OAuthClientInformationFull>;
        const client = { ...registering, client_id: given.client_id ?? randomUUID(), client_id_issued_at: given.client_id_issued_at ?? Math.floor(this.now() / 1000) } as OAuthClientInformationFull;
        store.saveOAuthClient(client.client_id, JSON.stringify(client));
        log.info({ clientId: client.client_id, name: client.client_name ?? null, redirects: client.redirect_uris }, "oauth client registered");
        return client;
      },
    };
  }

  // A `resource` the client names must be ours: a token asked for another
  // resource is a token this gateway has no business issuing.
  private ownResource(resource: URL | undefined): string {
    if (resource !== undefined && resource.href !== this.resource.href) throw new InvalidTargetError(`this server issues tokens for ${this.resource.href} only`);
    return this.resource.href;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.ownResource(params.resource);
    this.sweep();
    const id = token("");
    this.pending.set(id, { client, params, expiresAt: this.now() + PENDING_TTL_MS, attempts: 0 });
    sendPage(res, 200, signInPage(client, params.redirectUri, id));
  }

  /** The sign-in form's target: a key for the pending request, or a refusal. */
  signIn(requestId: string, key: string | undefined, deny: boolean, res: Response): void {
    const p = this.pending.get(requestId);
    if (!p || p.expiresAt <= this.now()) {
      this.pending.delete(requestId);
      sendPage(res, 400, messagePage("This sign-in has expired. Start again from the application that sent you here."));
      return;
    }
    if (deny) {
      this.pending.delete(requestId);
      redirect(res, p.params.redirectUri, { error: "access_denied", state: p.params.state });
      return;
    }
    const found = key ? this.store.authenticateKey(key.trim()) : null;
    if (!found) {
      p.attempts++;
      this.log.warn({ clientId: p.client.client_id, attempts: p.attempts }, "oauth sign-in with a key that is not valid");
      if (p.attempts >= MAX_ATTEMPTS) {
        this.pending.delete(requestId);
        sendPage(res, 400, messagePage("Too many keys that are not valid. Start again from the application that sent you here."));
        return;
      }
      sendPage(res, 401, signInPage(p.client, p.params.redirectUri, requestId, "That is not a valid key of this gateway."));
      return;
    }
    this.pending.delete(requestId);
    const code = token("");
    this.codes.set(code, {
      clientId: p.client.client_id, redirectUri: p.params.redirectUri, codeChallenge: p.params.codeChallenge,
      resource: this.resource.href, scopes: p.params.scopes ?? [], keyName: found.name, expiresAt: this.now() + CODE_TTL_MS,
    });
    this.log.info({ clientId: p.client.client_id, key: found.name }, "oauth sign-in");
    redirect(res, p.params.redirectUri, { code, state: p.params.state });
  }

  private liveCode(client: OAuthClientInformationFull, code: string): Code {
    const c = this.codes.get(code);
    if (!c || c.expiresAt <= this.now() || c.clientId !== client.client_id) throw new InvalidGrantError("the authorization code is not valid");
    return c;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.liveCode(client, code).codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const c = this.liveCode(client, code);
    // Spent on the first attempt, right or wrong: a code is good once.
    this.codes.delete(code);
    // The SDK leaves these two to the provider (RFC 6749 §4.1.3, RFC 8707).
    if (redirectUri !== undefined && redirectUri !== c.redirectUri) throw new InvalidGrantError("redirect_uri does not match the authorization request");
    if (this.ownResource(resource) !== c.resource) throw new InvalidGrantError("resource does not match the authorization request");
    if (!this.store.isLiveKey(c.keyName)) throw new InvalidGrantError("the key this sign-in used has been revoked");
    return this.issue(c.keyName, client.client_id, c.scopes);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const r = this.store.oauthToken(refreshToken);
    if (!r || r.kind !== "refresh" || r.clientId !== client.client_id || r.expiresAt <= this.now()) throw new InvalidGrantError("the refresh token is not valid");
    this.ownResource(resource);
    if (!this.store.isLiveKey(r.keyName)) { this.store.deleteOAuthToken(refreshToken); throw new InvalidGrantError("the key behind this token has been revoked"); }
    if (scopes && scopes.some((s) => !r.scopes.includes(s))) throw new InvalidGrantError("a refresh cannot widen the scopes");
    // Rotated, as OAuth 2.1 requires for a public client: the old one dies in
    // the same response that hands out the new one.
    this.store.deleteOAuthToken(refreshToken);
    return this.issue(r.keyName, client.client_id, scopes ?? r.scopes);
  }

  async verifyAccessToken(accessToken: string): Promise<AuthInfo> {
    const r = this.store.oauthToken(accessToken);
    if (!r || r.kind !== "access" || r.expiresAt <= this.now() || !this.store.isLiveKey(r.keyName)) throw new InvalidTokenError("the access token is not valid");
    return { token: accessToken, clientId: r.clientId, scopes: r.scopes, expiresAt: Math.floor(r.expiresAt / 1000), resource: r.resource ? new URL(r.resource) : undefined, extra: { keyName: r.keyName } };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    // RFC 7009: an unknown token, or someone else's, is answered as revoked.
    const r = this.store.oauthToken(request.token);
    if (r && r.clientId === client.client_id) this.store.deleteOAuthToken(request.token);
  }

  private issue(keyName: string, clientId: string, scopes: string[]): OAuthTokens {
    const now = this.now();
    const access = token(ACCESS_PREFIX), refresh = token(REFRESH_PREFIX);
    // The same clock for the expiry and for the store's pruning of expired
    // tokens, or a token could be pruned the moment it is saved.
    this.store.saveOAuthToken(access, { kind: "access", keyName, clientId, resource: this.resource.href, scopes, expiresAt: now + ACCESS_TTL_S * 1000 }, now);
    this.store.saveOAuthToken(refresh, { kind: "refresh", keyName, clientId, resource: this.resource.href, scopes, expiresAt: now + REFRESH_TTL_S * 1000 }, now);
    return { access_token: access, token_type: "bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, ...(scopes.length ? { scope: scopes.join(" ") } : {}) };
  }

  private sweep(): void {
    const now = this.now();
    for (const [k, p] of this.pending) if (p.expiresAt <= now) this.pending.delete(k);
    for (const [k, c] of this.codes) if (c.expiresAt <= now) this.codes.delete(k);
  }
}

export interface OAuthServer {
  router: Router;
  provider: KeyOAuthProvider;
  /** Where an unauthenticated /mcp call is told to look (RFC 9728, the 401's resource_metadata). */
  resourceMetadataUrl: string;
}

/** The authorization server and the sign-in page, mounted at the application root. */
export function createOAuthServer(store: OAuthStore, publicUrl: string, log: Logger, now?: () => number): OAuthServer {
  const issuer = new URL(publicUrl);
  const resource = new URL("/mcp", issuer);
  const provider = new KeyOAuthProvider(store, resource, log, now);
  const router = express.Router();
  router.use(mcpAuthRouter({ provider, issuerUrl: issuer, resourceServerUrl: resource, resourceName: "Capitoline" }));
  router.post("/oauth/login", express.urlencoded({ extended: false, limit: "8kb" }), (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
    provider.signIn(str(body.request) ?? "", str(body.key), body.action === "deny", res);
  });
  return { router, provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource) };
}

// ---- The two pages. Plain HTML, nothing loaded from anywhere: everything the
// client registered is escaped, since registration is open to anyone.

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function sendPage(res: Response, status: number, html: string): void {
  res.status(status)
    .setHeader("Content-Type", "text/html; charset=utf-8")
    .setHeader("Cache-Control", "no-store")
    .setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'")
    .setHeader("X-Frame-Options", "DENY")
    .setHeader("Referrer-Policy", "no-referrer")
    .send(html);
}

function redirect(res: Response, to: string, params: Record<string, string | undefined>): void {
  const url = new URL(to);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  res.setHeader("Cache-Control", "no-store");
  res.redirect(302, url.href);
}

const PAGE_STYLE = "body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#222}"
  + "input[type=password]{width:100%;padding:.5rem;font-family:monospace}button{padding:.5rem 1rem;margin:.75rem .5rem 0 0}"
  + ".host{font-weight:bold;font-size:1.1rem}.warn{background:#fff3cd;padding:.5rem}.err{color:#a00}";

function frame(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${esc(title)}</title><style>${PAGE_STYLE}</style></head><body>${body}</body></html>`;
}

function signInPage(client: OAuthClientInformationFull, redirectUri: string, requestId: string, error?: string): string {
  const host = new URL(redirectUri).host;
  const hostname = new URL(redirectUri).hostname;
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  const name = client.client_name ? esc(client.client_name) : "An application";
  return frame("Sign in to Capitoline", `<h1>Sign in to Capitoline</h1>`
    + `<p>${name} asks to use this gateway's MCP tools on your behalf. After you sign in you will be sent to:</p>`
    + `<p class="host">${esc(host)}</p>`
    + (loopback ? `<p class="warn">That is an address on your own computer: any program running there could be the one asking. Go on only if you started this from an application you trust.</p>` : "")
    + `<p>Paste a key of this gateway. Its calls will be recorded under that key's name, and revoking the key ends this access.</p>`
    + (error ? `<p class="err">${esc(error)}</p>` : "")
    + `<form method="post" action="/oauth/login"><input type="hidden" name="request" value="${esc(requestId)}">`
    + `<input type="password" name="key" autocomplete="off" placeholder="cap_…" autofocus>`
    + `<div><button type="submit" name="action" value="allow">Sign in</button><button type="submit" name="action" value="deny">Refuse</button></div></form>`);
}

function messagePage(text: string): string {
  return frame("Capitoline", `<h1>Capitoline</h1><p>${esc(text)}</p>`);
}
