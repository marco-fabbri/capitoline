import { describe, it, expect } from "vitest";
import request from "supertest";
import type { RequestHandler } from "express";
import { createApp } from "../src/server/app.js";
import { createUiRouter } from "../src/server/ui.js";
import { Core } from "../src/core/core.js";
import { UsageStore } from "../src/usage/store.js";
import { createLogger } from "../src/log.js";
import { FakeProvider } from "./fake-provider.js";

// The operator's page (/ui): three static files with nothing in them, served
// without a credential under a policy that lets them load only each other.
const deny: RequestHandler = (_req, res) => { res.status(401).json({ error: { code: "unauthorized" } }); };
function make(ui: boolean) {
  const core = new Core([new FakeProvider("a", ["a-1"], [])], new UsageStore(":memory:"), { maxWaitMs: 100, budgets: {}, log: createLogger("t") });
  return createApp(core, { log: createLogger("t"), access: deny, ...(ui ? { ui: createUiRouter() } : {}) });
}

describe("/ui", () => {
  it("serves the page and its two files without a credential, and nothing else", async () => {
    const app = make(true);
    const page = await request(app).get("/ui/");
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toMatch(/text\/html/);
    expect(page.text).toContain('<script src="app.js">');
    expect((await request(app).get("/ui/app.js")).headers["content-type"]).toMatch(/javascript/);
    expect((await request(app).get("/ui/style.css")).headers["content-type"]).toMatch(/text\/css/);
    expect((await request(app).get("/ui")).headers.location).toBe("/ui/");
    // Anything else under /ui falls through to the door like every other path.
    expect((await request(app).get("/ui/secrets.txt")).status).toBe(401);
    expect((await request(app).get("/v1/models")).status).toBe(401);
  });

  it("lets the page load only its own files and talk only to its own origin", async () => {
    const page = await request(make(true)).get("/ui/");
    const csp = page.headers["content-security-policy"];
    for (const rule of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "form-action 'none'"]) expect(csp).toContain(rule);
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    // No inline script or style, which the policy would refuse anyway.
    expect(page.text).not.toMatch(/<script(?![^>]*src=)/);
    expect(page.text).not.toMatch(/<style|style="/);
  });

  it("is not there unless it was asked for", async () => {
    expect((await request(make(false)).get("/ui/")).status).toBe(401);
  });
});
