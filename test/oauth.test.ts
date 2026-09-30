import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import request from "supertest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server/app.js";
import { createAuthMiddleware } from "../src/server/access.js";
import { createOAuthServer } from "../src/server/oauth.js";
import { createMcpHandler } from "../src/mcp/server.js";
import { Core } from "../src/core/core.js";
import { UsageStore } from "../src/usage/store.js";
import { createLogger } from "../src/log.js";
import { FakeProvider } from "./fake-provider.js";

// OAuth for MCP clients that cannot hold a key (src/server/oauth.ts), end to
// end over HTTP, the way Claude on the web goes through it: discovery, client
// registration, the sign-in page with a gateway key, the code for tokens with
// PKCE, the token on /mcp, rotation, and revocation through the key.
const PUBLIC = "https://gw.example.com";
const RESOURCE = `${PUBLIC}/mcp`;
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "a-code-verifier-that-is-long-enough-for-pkce-0123456789";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

let usage: UsageStore, provider: FakeProvider, app: ReturnType<typeof createApp>, key: string;
let t = 1_790_000_000_000;

function build(oauthOn = true) {
  usage = new UsageStore(":memory:");
  key = usage.createKey("claude-web", "test").key;
  provider = new FakeProvider("claude", ["claude-opus"], [{ type: "text", delta: "answer" }, { type: "done", usage: { input: 5, output: 1 } }]);
  const core = new Core([provider], usage, { maxWaitMs: 100, budgets: {}, log: createLogger("t") });
  const oauth = oauthOn ? createOAuthServer(usage, PUBLIC, createLogger("t"), () => t) : undefined;
  const access = createAuthMiddleware({ keys: usage, oauth: oauth ? { verifyAccessToken: (tok) => oauth.provider.verifyAccessToken(tok), resourceMetadataUrl: oauth.resourceMetadataUrl } : undefined }, createLogger("t"));
  app = createApp(core, { log: createLogger("t"), access, mcp: createMcpHandler(core, createLogger("t")), keys: usage, oauth: oauth?.router, identity: { store: usage, admins: [] } });
}

async function register(): Promise<string> {
  const r = await request(app).post("/register").send({ redirect_uris: [CALLBACK], token_endpoint_auth_method: "none", client_name: "Claude <script>" });
  expect(r.status).toBe(201);
  return r.body.client_id as string;
}

function authorizeQuery(clientId: string, extra: Record<string, string> = {}) {
  return { response_type: "code", client_id: clientId, redirect_uri: CALLBACK, code_challenge: CHALLENGE, code_challenge_method: "S256", state: "st-1", resource: RESOURCE, ...extra };
}

async function signIn(clientId: string, withKey = () => key): Promise<string> {
  const page = await request(app).get("/authorize").query(authorizeQuery(clientId));
  expect(page.status).toBe(200);
  const id = /name="request" value="([^"]+)"/.exec(page.text)![1];
  const r = await request(app).post("/oauth/login").type("form").send({ request: id, key: withKey(), action: "allow" });
  expect(r.status).toBe(302);
  const to = new URL(r.headers.location);
  expect(to.origin + to.pathname).toBe(CALLBACK);
  expect(to.searchParams.get("state")).toBe("st-1");
  return to.searchParams.get("code")!;
}

async function exchange(clientId: string, code: string, extra: Record<string, string> = {}) {
  return request(app).post("/token").type("form").send({ grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id: clientId, redirect_uri: CALLBACK, resource: RESOURCE, ...extra });
}

describe("OAuth for MCP clients", () => {
  beforeEach(() => build());

  it("publishes the discovery documents Claude reads", async () => {
    const prm = await request(app).get("/.well-known/oauth-protected-resource/mcp");
    expect(prm.status).toBe(200);
    expect(prm.body.resource).toBe(RESOURCE);
    expect(prm.body.authorization_servers[0]).toBe(`${PUBLIC}/`);
    const as = await request(app).get("/.well-known/oauth-authorization-server");
    expect(as.body).toMatchObject({ registration_endpoint: `${PUBLIC}/register`, token_endpoint: `${PUBLIC}/token`, code_challenge_methods_supported: ["S256"] });
    expect(as.body.token_endpoint_auth_methods_supported).toContain("none");
  });

  it("answers an unauthenticated /mcp with the pointer to its metadata", async () => {
    const r = await request(app).post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(r.status).toBe(401);
    expect(r.headers["www-authenticate"]).toBe(`Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("signs in with a gateway key on a page that shows where it sends you, escaping what the client registered", async () => {
    const clientId = await register();
    const page = await request(app).get("/authorize").query(authorizeQuery(clientId));
    expect(page.text).toContain("claude.ai");
    expect(page.text).toContain("Claude &lt;script&gt;");
    expect(page.text).not.toContain("<script>");
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    const id = /name="request" value="([^"]+)"/.exec(page.text)![1];
    const wrong = await request(app).post("/oauth/login").type("form").send({ request: id, key: "cap_not-a-key", action: "allow" });
    expect(wrong.status).toBe(401);
    expect(wrong.text).toContain("not a valid key");
    const denied = await request(app).post("/oauth/login").type("form").send({ request: id, key: "", action: "deny" });
    expect(new URL(denied.headers.location).searchParams.get("error")).toBe("access_denied");
    const again = await request(app).post("/oauth/login").type("form").send({ request: id, key, action: "allow" });
    expect(again.status).toBe(400); // the request was spent by the refusal
  });

  it("exchanges the code once, with the right verifier and redirect, for tokens good on /mcp only", async () => {
    const clientId = await register();
    const badVerifier = await exchange(clientId, await signIn(clientId), { code_verifier: "x".repeat(50) });
    expect(badVerifier.body.error).toBe("invalid_grant");
    const badRedirect = await exchange(clientId, await signIn(clientId), { redirect_uri: "https://claude.ai/elsewhere" });
    expect(badRedirect.body.error).toBe("invalid_grant");
    const code = await signIn(clientId);
    const tokens = await exchange(clientId, code);
    expect(tokens.status).toBe(200);
    expect(tokens.body).toMatchObject({ token_type: "bearer", expires_in: 3600 });
    expect(tokens.body.access_token).toMatch(/^capo_at_/);
    expect(tokens.body.refresh_token).toMatch(/^capo_rt_/);
    expect((await exchange(clientId, code)).body.error).toBe("invalid_grant");
    // The HTTP API keeps taking keys.
    const v1 = await request(app).get("/v1/models").set("Authorization", `Bearer ${tokens.body.access_token}`);
    expect(v1.status).toBe(401);
  });

  it("serves the MCP tools on the token, recorded under the key's name", async () => {
    const clientId = await register();
    const tokens = (await exchange(clientId, await signIn(clientId))).body;
    const server: Server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    try {
      const url = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`);
      const c = new Client({ name: "t", version: "0" });
      await c.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } }));
      const r = await c.callTool({ name: "ask_model", arguments: { model: "claude-opus", prompt: "q" } });
      expect(r.isError).toBeFalsy();
      await c.close();
    } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
    expect(usage.callers(24 * 3600_000).map((c) => c.caller)).toContain("claude-web");
  });

  it("rotates the refresh token, and a revoked key ends every token it stood behind", async () => {
    const clientId = await register();
    const first = (await exchange(clientId, await signIn(clientId))).body;
    const refresh = (body: Record<string, string>) => request(app).post("/token").type("form").send({ grant_type: "refresh_token", client_id: clientId, ...body });
    const second = await refresh({ refresh_token: first.refresh_token });
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).not.toBe(first.refresh_token);
    expect((await refresh({ refresh_token: first.refresh_token })).body.error).toBe("invalid_grant");
    usage.revokeKey("claude-web");
    const mcp = await request(app).post("/mcp").set("Authorization", `Bearer ${second.body.access_token}`).send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(mcp.status).toBe(401);
    expect(mcp.headers["www-authenticate"]).toContain('error="invalid_token"');
    expect((await refresh({ refresh_token: second.body.refresh_token })).body.error).toBe("invalid_grant");
  });

  it("lets an access token expire after an hour", async () => {
    const clientId = await register();
    const tokens = (await exchange(clientId, await signIn(clientId))).body;
    t += 3601_000;
    const mcp = await request(app).post("/mcp").set("Authorization", `Bearer ${tokens.access_token}`).send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(mcp.status).toBe(401);
  });

  it("refuses a token asked for another resource", async () => {
    const clientId = await register();
    const page = await request(app).get("/authorize").query(authorizeQuery(clientId, { resource: "https://other.example.com/mcp" }));
    expect(page.status).toBe(302);
    expect(new URL(page.headers.location).searchParams.get("error")).toBe("invalid_target");
  });
});

describe("without OAuth configured", () => {
  beforeEach(() => build(false));
  it("serves no discovery and sends no challenge", async () => {
    expect((await request(app).get("/.well-known/oauth-authorization-server")).status).not.toBe(200);
    const r = await request(app).post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(r.status).toBe(401);
    expect(r.headers["www-authenticate"]).toBeUndefined();
  });
});

describe("/health on a gateway reachable from outside", () => {
  beforeEach(() => build());
  it("tells the host itself and a caller with a key everything, anyone else only that it is up", async () => {
    const local = await request(app).get("/health");
    expect(local.body.providers).toBeDefined();
    const outside = await request(app).get("/health").set("Cf-Connecting-Ip", "203.0.113.9");
    expect(outside.body).toEqual({ ok: true });
    const forwarded = await request(app).get("/health").set("X-Forwarded-For", "203.0.113.9");
    expect(forwarded.body).toEqual({ ok: true });
    const keyed = await request(app).get("/health").set("Cf-Connecting-Ip", "203.0.113.9").set("Authorization", `Bearer ${key}`);
    expect(keyed.body.providers).toBeDefined();
  });
});

afterEach(() => { t = 1_790_000_000_000; });
