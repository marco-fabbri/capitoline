import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import request from "supertest";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from "jose";
import { createAccessMiddleware } from "../src/server/access.js";
import { createLogger } from "../src/log.js";

const team = "example.cloudflareaccess.com", aud = "abc123";
let app: express.Express, sign: (claims: object, opts?: { aud?: string; iss?: string }) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  sign = (claims, o = {}) => new SignJWT({ ...claims }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(o.iss ?? `https://${team}`).setAudience(o.aud ?? aud).setIssuedAt().setExpirationTime("5m").sign(privateKey);
  app = express();
  app.use(createAccessMiddleware({ teamDomain: team, audience: aud, jwks }, createLogger("t")));
  app.get("/x", (_req, res) => res.json({ who: res.locals.identity }));
});

describe("access middleware", () => {
  it("rejects a missing token", async () => {
    const r = await request(app).get("/x");
    expect(r.status).toBe(401); expect(r.body.error.code).toBe("unauthorized");
  });
  it("accepts a valid header token and exposes the identity", async () => {
    const r = await request(app).get("/x").set("Cf-Access-Jwt-Assertion", await sign({ email: "me@example.com", sub: "u1" }));
    expect(r.status).toBe(200); expect(r.body.who).toEqual({ email: "me@example.com", sub: "u1", type: "user" });
  });
  it("accepts a service token via cookie", async () => {
    const r = await request(app).get("/x").set("Cookie", `CF_Authorization=${await sign({ common_name: "svc", sub: "" })}`);
    expect(r.status).toBe(200); expect(r.body.who.type).toBe("service");
  });
  it("rejects a wrong audience", async () => {
    expect((await request(app).get("/x").set("Cf-Access-Jwt-Assertion", await sign({ sub: "u1" }, { aud: "other" }))).status).toBe(401);
  });
});
