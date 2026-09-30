import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import request from "supertest";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from "jose";

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
import { callerOf, createAccessMiddleware, createAuthMiddleware } from "../src/server/access.js";
import { UsageStore } from "../src/usage/store.js";
import { createLogger } from "../src/log.js";

const team = "example.cloudflareaccess.com", aud = "abc123";
let app: express.Express, jwks: ReturnType<typeof createLocalJWKSet>;
let trusted: PrivateKey; // private half of the key in the JWKS
let other: PrivateKey; // a key that is NOT in the JWKS

const jwt = (claims: object) => new SignJWT({ ...claims }).setProtectedHeader({ alg: "RS256", kid: "k1" });
const sign = (claims: object, o: { aud?: string; iss?: string; exp?: string; key?: PrivateKey } = {}) =>
  jwt(claims).setIssuer(o.iss ?? `https://${team}`).setAudience(o.aud ?? aud).setIssuedAt().setExpirationTime(o.exp ?? "5m").sign(o.key ?? trusted);
const call = (token: string) => request(app).get("/x").set("Cf-Access-Jwt-Assertion", token);

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  trusted = privateKey;
  other = (await generateKeyPair("RS256")).privateKey;
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  jwks = createLocalJWKSet({ keys: [jwk] });
  app = express();
  app.use(createAccessMiddleware({ teamDomain: team, audience: aud, jwks }, createLogger("t")));
  app.get("/x", (_req, res) => res.json({ who: res.locals.identity }));
});

describe("access middleware", () => {
  it("rejects a missing token with the spec 8.3 error shape", async () => {
    const r = await request(app).get("/x");
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: { message: "missing or invalid credentials: an API key (Authorization: Bearer) or a Cloudflare Access token", type: "invalid_request_error", code: "unauthorized" } });
  });
  it("accepts a valid header token and exposes the identity", async () => {
    const r = await call(await sign({ email: "me@example.com", sub: "u1" }));
    expect(r.status).toBe(200); expect(r.body.who).toEqual({ email: "me@example.com", sub: "u1", type: "user" });
  });
  it("accepts a service token via cookie, and keeps the name it carries", async () => {
    const r = await request(app).get("/x").set("Cookie", `CF_Authorization=${await sign({ common_name: "svc", sub: "" })}`);
    expect(r.status).toBe(200); expect(r.body.who).toEqual({ sub: "", type: "service", name: "svc" });
  });
  it("keeps the client id Cloudflare sent, opaque as it is", async () => {
    // Cloudflare puts the **client id** in common_name, not the name typed in
    // the dashboard, so /v1/usage listed two applications under two opaque
    // ids and named neither (observed 2026-09-23). The id is what a usage row
    // stores; naming it happens where the row is read, in /v1/usage, so a
    // token mapped an hour late is readable all the way back.
    const r = await request(app).get("/x").set("Cookie", `CF_Authorization=${await sign({ common_name: "0a0a0a0a.access", sub: "" })}`);
    expect(r.body.who).toEqual({ sub: "", type: "service", name: "0a0a0a0a.access" });
  });
  it("rejects a wrong audience", async () => {
    expect((await call(await sign({ sub: "u1" }, { aud: "other" }))).status).toBe(401);
  });
  it("rejects a token signed by a key that is not in the JWKS", async () => {
    const r = await call(await sign({ sub: "u1" }, { key: other }));
    expect(r.status).toBe(401); expect(r.body.error.code).toBe("unauthorized");
  });
  it("rejects a wrong issuer", async () => {
    expect((await call(await sign({ sub: "u1" }, { iss: "https://evil.cloudflareaccess.com" }))).status).toBe(401);
  });
  it("rejects an expired token", async () => {
    expect((await call(await sign({ sub: "u1" }, { exp: "-1m" }))).status).toBe(401);
  });
  it("tolerates a few seconds of clock skew on nbf", async () => {
    const t = await jwt({ sub: "u1" }).setIssuer(`https://${team}`).setAudience(aud).setNotBefore("5s").setExpirationTime("5m").sign(trusted);
    expect((await call(t)).status).toBe(200);
  });
  it("refuses to start without an audience", () => {
    expect(() => createAccessMiddleware({ teamDomain: team, audience: "", jwks }, createLogger("t"))).toThrow(/audience/);
  });
});

// The name a usage row is attributed to. A service token has no email and an
// empty sub, so its own name is the only thing that tells two applications
// apart; a user token has an email, which is what an operator recognises.
describe("callerOf", () => {
  it("prefers the email, then the service token name, then the subject", () => {
    expect(callerOf({ email: "me@example.com", sub: "u1", type: "user", name: "svc" })).toBe("me@example.com");
    expect(callerOf({ sub: "", type: "service", name: "claude-code" })).toBe("claude-code");
    expect(callerOf({ sub: "u1", type: "user" })).toBe("u1");
  });
  it("is null when there is no identity at all", () => {
    expect(callerOf(undefined)).toBeNull();
    expect(callerOf({})).toBeNull();
    expect(callerOf({ email: "   ", sub: "" })).toBeNull();
  });
  it("bounds what a token can write into the database", () => {
    expect(callerOf({ email: "x".repeat(500), sub: "" })!.length).toBe(320);
  });
});

// The gateway's own identity beside Cloudflare's (design §4): a key it
// issued, sent as `Authorization: Bearer cap_…`, judged before and apart
// from the Access JWT, and the rule for a gateway with no Access in front.
describe("auth middleware: keys and Access together", () => {
  const withKeys = (opts: { access?: boolean } = {}) => {
    const store = new UsageStore(":memory:");
    const a = express();
    a.use(createAuthMiddleware({ access: opts.access ? { teamDomain: team, audience: aud, jwks } : undefined, keys: store }, createLogger("t")));
    a.get("/x", (_req, res) => res.json({ who: res.locals.identity ?? null }));
    return { store, app: a };
  };

  it("accepts a live key and identifies the caller by the key's name", async () => {
    const { store, app: a } = withKeys({ access: true });
    const { key } = store.createKey("app-one", "test");
    const r = await request(a).get("/x").set("Authorization", `Bearer ${key}`);
    expect(r.status).toBe(200);
    expect(r.body.who).toEqual({ type: "key", name: "app-one", sub: "key:app-one" });
    expect(callerOf(r.body.who)).toBe("app-one");
  });

  it("refuses a revoked, unknown or malformed key, even beside a valid Access token", async () => {
    const { store, app: a } = withKeys({ access: true });
    const { key } = store.createKey("old", "test");
    store.revokeKey("old");
    const token = await sign({ email: "a@b.c", sub: "u1" });
    for (const bearer of [key, "cap_nothing", "cap_"]) {
      const r = await request(a).get("/x").set("Authorization", `Bearer ${bearer}`).set("Cf-Access-Jwt-Assertion", token);
      expect(r.status, bearer).toBe(401);
      expect(r.body.error.code).toBe("unauthorized");
    }
    // A bearer that is not one of ours is not a key at all: the Access path
    // decides, as it would for a request with no Authorization header.
    const other = await request(a).get("/x").set("Authorization", "Bearer sk-something-else").set("Cf-Access-Jwt-Assertion", token);
    expect(other.status).toBe(200);
    expect(other.body.who.email).toBe("a@b.c");
  });

  it("keeps the Access path unchanged when no key is presented", async () => {
    const { app: a } = withKeys({ access: true });
    expect((await request(a).get("/x")).status).toBe(401);
    const r = await request(a).get("/x").set("Cf-Access-Jwt-Assertion", await sign({ email: "a@b.c", sub: "u1" }));
    expect(r.status).toBe(200);
    expect(r.body.who.type).toBe("user");
  });

  // Access kept at the edge with a Bypass for /mcp: an OAuth client arrives
  // with no Access token and must get the OAuth challenge, not Access's 401;
  // a request that does carry an Access token still goes through Access.
  it("sends /mcp without any credential to OAuth when OAuth is on, and the rest to Access as before", async () => {
    const store = new UsageStore(":memory:");
    const oauth = { verifyAccessToken: async () => { throw new Error("no"); }, resourceMetadataUrl: "https://gw.example.com/.well-known/oauth-protected-resource/mcp" };
    const a = express();
    a.use(createAuthMiddleware({ access: { teamDomain: team, audience: aud, jwks }, keys: store, oauth }, createLogger("t")));
    a.post("/mcp", (_req, res) => res.json({ who: res.locals.identity ?? null }));
    a.get("/x", (_req, res) => res.json({ who: res.locals.identity ?? null }));
    const bare = await request(a).post("/mcp");
    expect(bare.status).toBe(401);
    expect(bare.headers["www-authenticate"]).toContain("resource_metadata=");
    const viaAccess = await request(a).post("/mcp").set("Cf-Access-Jwt-Assertion", await sign({ email: "a@b.c", sub: "u1" }));
    expect(viaAccess.status).toBe(200);
    const elsewhere = await request(a).get("/x");
    expect(elsewhere.status).toBe(401);
    expect(elsewhere.headers["www-authenticate"]).toBeUndefined();
  });

  it("is open without Access until the first key exists, and closed from then on", async () => {
    const { store, app: a } = withKeys();
    const open = await request(a).get("/x");
    expect(open.status).toBe(200);
    expect(open.body.who).toBeNull();
    const { key } = store.createKey("first", "test");
    expect((await request(a).get("/x")).status).toBe(401);
    expect((await request(a).get("/x").set("Authorization", `Bearer ${key}`)).status).toBe(200);
    // Revoking the last key reopens it: the rule is about live keys.
    store.revokeKey("first");
    expect((await request(a).get("/x")).status).toBe(200);
  });
});
