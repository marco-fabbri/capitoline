import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import request from "supertest";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from "jose";

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
import { createAccessMiddleware } from "../src/server/access.js";
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
  it("accepts a service token via cookie", async () => {
    const r = await request(app).get("/x").set("Cookie", `CF_Authorization=${await sign({ common_name: "svc", sub: "" })}`);
    expect(r.status).toBe(200); expect(r.body.who.type).toBe("service");
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
