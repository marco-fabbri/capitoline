import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import request from "supertest";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from "jose";

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
import { callerOf, createAccessMiddleware } from "../src/server/access.js";
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
    expect(r.body).toEqual({ error: { message: "missing or invalid Cloudflare Access token", type: "invalid_request_error", code: "unauthorized" } });
  });
  it("accepts a valid header token and exposes the identity", async () => {
    const r = await call(await sign({ email: "me@example.com", sub: "u1" }));
    expect(r.status).toBe(200); expect(r.body.who).toEqual({ email: "me@example.com", sub: "u1", type: "user" });
  });
  it("accepts a service token via cookie, and keeps the name it carries", async () => {
    const r = await request(app).get("/x").set("Cookie", `CF_Authorization=${await sign({ common_name: "svc", sub: "" })}`);
    expect(r.status).toBe(200); expect(r.body.who).toEqual({ sub: "", type: "service", name: "svc" });
  });
  it("calls a service token by the name the host gave its client id", async () => {
    // Cloudflare puts the **client id** in common_name, not the name typed in
    // the dashboard, so /v1/usage listed two applications under two opaque
    // ids and named neither (observed 2026-09-23). The host maps them.
    const named = express();
    named.use(createAccessMiddleware({ teamDomain: team, audience: aud, jwks, names: { "0a0a0a0a.access": "app-one" } }, createLogger("t")));
    named.get("/x", (_req, res) => res.json({ who: res.locals.identity }));
    const r = await request(named).get("/x").set("Cookie", `CF_Authorization=${await sign({ common_name: "0a0a0a0a.access", sub: "" })}`);
    expect(r.body.who).toEqual({ sub: "", type: "service", name: "app-one" });

    // An id the host has not named keeps the id: unreadable, still correct,
    // and never null, because a row that cannot be attributed is a worse
    // outcome than one attributed to something opaque.
    const other = await request(named).get("/x").set("Cookie", `CF_Authorization=${await sign({ common_name: "unmapped.access", sub: "" })}`);
    expect(other.body.who).toEqual({ sub: "", type: "service", name: "unmapped.access" });
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
