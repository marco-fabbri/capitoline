import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { createApp } from "../src/server/app.js";
import { createAuthMiddleware } from "../src/server/access.js";
import { createFailureThrottle } from "../src/server/throttle.js";
import { Core } from "../src/core/core.js";
import { UsageStore } from "../src/usage/store.js";
import { createLogger } from "../src/log.js";
import { FakeProvider } from "./fake-provider.js";

// The brake on wrong credentials for /v1/admin (src/server/throttle.ts): an
// address that keeps being refused is told to wait, and a live key never is.
describe("the failure throttle", () => {
  function mini(now: () => number) {
    const app = express();
    app.use(createFailureThrottle({ limit: 3, windowMs: 60_000, now, hasLiveKey: (req) => req.header("authorization") === "Bearer good" }));
    app.get("/x", (req, res) => { res.status(req.header("authorization") === "Bearer good" ? 200 : 401).json({}); });
    return app;
  }

  it("answers 429 after the limit, says when to come back, and forgets with the window", async () => {
    let t = 1_000_000;
    const app = mini(() => t);
    for (let i = 0; i < 3; i++) expect((await request(app).get("/x")).status).toBe(401);
    const held = await request(app).get("/x");
    expect(held.status).toBe(429);
    expect(held.headers["retry-after"]).toBe("60");
    expect(held.body.error.code).toBe("rate_limited");
    t += 61_000;
    expect((await request(app).get("/x")).status).toBe(401);
  });

  it("never holds back a live key, and counts each forwarded address apart", async () => {
    const app = mini(() => 1_000_000);
    for (let i = 0; i < 3; i++) await request(app).get("/x").set("X-Forwarded-For", "203.0.113.9");
    expect((await request(app).get("/x").set("X-Forwarded-For", "203.0.113.9")).status).toBe(429);
    expect((await request(app).get("/x").set("X-Forwarded-For", "203.0.113.9").set("Authorization", "Bearer good")).status).toBe(200);
    // Another address behind the same proxy is not held for the first one's refusals.
    expect((await request(app).get("/x").set("X-Forwarded-For", "198.51.100.7")).status).toBe(401);
  });
});

describe("/v1/admin behind the throttle", () => {
  it("holds an address that keeps presenting wrong keys, and lets the administrator through", async () => {
    const usage = new UsageStore(":memory:");
    const admin = usage.createKey("operator", "test").key;
    const core = new Core([new FakeProvider("a", ["a-1"], [])], usage, { maxWaitMs: 100, budgets: {}, log: createLogger("t") });
    const app = createApp(core, { log: createLogger("t"), access: createAuthMiddleware({ keys: usage }, createLogger("t")), keys: usage, identity: { store: usage, admins: ["operator"] } });
    for (let i = 0; i < 10; i++) expect((await request(app).get("/v1/admin/keys").set("Authorization", `Bearer cap_wrong${i}`)).status).toBe(401);
    expect((await request(app).get("/v1/admin/keys").set("Authorization", "Bearer cap_wrong")).status).toBe(429);
    expect((await request(app).get("/v1/admin/keys").set("Authorization", `Bearer ${admin}`)).status).toBe(200);
    // Only the administrators' routes are braked: the API keeps its own answers.
    expect((await request(app).get("/v1/models").set("Authorization", "Bearer cap_wrong")).status).toBe(401);
  });
});
