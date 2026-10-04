import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import type { RequestHandler } from "express";
import { createApp } from "../src/server/app.js";
import { Core } from "../src/core/core.js";
import { UsageStore } from "../src/usage/store.js";
import { ConversationStore } from "../src/conversations/store.js";
import { createLogger } from "../src/log.js";
import type { ProviderEvent } from "../src/core/types.js";
import { FakeProvider } from "./fake-provider.js";

// The operator's side of /v1/admin: what the dashboard reads and does, and so
// what curl can. Reads, and the few actions that are state and not
// configuration. Every route is the administrators' alone.
const OK: ProviderEvent[] = [{ type: "text", delta: "ok" }, { type: "done", usage: { input: 3, output: 2 } }];
const drain = async (it: AsyncIterable<unknown>) => { for await (const _ of it) { /* run it */ } };

let core: Core, usage: UsageStore, conversations: ConversationStore, provider: FakeProvider, app: ReturnType<typeof createApp>;
let notified: string[];
let t: number;

const asHeader: RequestHandler = (req, res, next) => {
  res.locals.identity = { type: "key", name: req.header("x-test-caller") ?? "operator", sub: "key:x" };
  next();
};
const get = (path: string, caller = "operator") => request(app).get(`/v1/admin${path}`).set("x-test-caller", caller);
const post = (path: string, body: object = {}) => request(app).post(`/v1/admin${path}`).set("x-test-caller", "operator").send(body);
const del = (path: string) => request(app).delete(`/v1/admin${path}`).set("x-test-caller", "operator");

beforeEach(() => {
  t = Date.UTC(2026, 9, 3, 12, 0);
  provider = new FakeProvider("a", ["a-1", "a-2", { name: "a-image", kind: "image" }], OK, 2);
  usage = new UsageStore(":memory:");
  core = new Core([provider], usage, { maxWaitMs: 1_000, budgets: {}, log: createLogger("t"), now: () => t });
  conversations = new ConversationStore(":memory:", 30);
  notified = [];
  app = createApp(core, { log: createLogger("t"), access: asHeader, identity: { store: usage, admins: ["operator"], ops: {
    core, usage, conversations, notify: async (m) => { notified.push(m); return true; }, config: () => ({ server: { port: 8080 } }),
  } } });
});

describe("the operator's routes under /v1/admin", () => {
  it("are the administrators' alone", async () => {
    for (const path of ["/whoami", "/usage", "/deliberations", "/pauses", "/conversations", "/config"]) {
      expect((await get(path, "app-one")).status, path).toBe(403);
    }
    expect((await get("/whoami")).body).toEqual({ admin: "operator" });
  });

  it("reports usage by day, caller, model and outcome, and refuses a range it does not serve", async () => {
    await drain(core.execute({ model: "a-1", messages: [{ role: "user", text: "q" }], stream: false }, { source: "http", caller: "app-one" }));
    await drain(core.execute({ model: "a-1", messages: [{ role: "user", text: "q" }], stream: false }, { source: "http", caller: "app-one" }));
    const r = await get("/usage?days=7");
    expect(r.body.days).toBe(7);
    expect(r.body.rows).toEqual([{ day: "2026-10-03", caller: "app-one", provider: "a", model: "a-1", outcome: "ok", calls: 2, inputTokens: 6, outputTokens: 4 }]);
    expect((await get("/usage?days=0")).status).toBe(400);
    expect((await get("/usage?days=1.5")).status).toBe(400);
  });

  it("lists the pauses, installs one by hand on a model or a provider, and lifts it", async () => {
    expect((await get("/pauses")).body).toEqual({ pauses: [] });
    const made = await post("/pauses", { provider: "a", model: "a-1", minutes: 30 });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ provider: "a", scope: "text:a-1", models: ["a-1"], until: t + 30 * 60_000 });
    expect(core.listModels().filter((m) => !m.available).map((m) => m.name)).toEqual(["a-1"]);
    // Kept like any pause: a restart finds it.
    expect(usage.pauses(t).map((p) => p.model)).toEqual(["text:a-1"]);
    expect((await del("/pauses/a?scope=text%3Aa-1")).body).toEqual({ provider: "a", scope: "text:a-1", lifted: true });
    expect(core.listModels().every((m) => m.available)).toBe(true);
    expect(usage.pauses(t)).toEqual([]);
    expect((await del("/pauses/a?scope=text%3Aa-1")).status).toBe(404);

    expect((await post("/pauses", { provider: "a", minutes: 10 })).body).toMatchObject({ provider: "a", scope: null });
    expect(core.listModels().some((m) => m.available)).toBe(false);
    expect((await del("/pauses/a")).status).toBe(200);
    expect((await post("/pauses", { provider: "a", minutes: 0 })).status).toBe(400);
    expect((await post("/pauses", { provider: "nobody", minutes: 5 })).status).toBe(400);
    expect((await post("/pauses", { provider: "a", model: "nothing", minutes: 5 })).status).toBe(400);
  });

  it("lifts a pause a refusal installed", async () => {
    provider.script = [{ type: "error", kind: "rate_limited", detail: "429", retryAfterS: 3600 }];
    await drain(core.execute({ model: "a-1", messages: [{ role: "user", text: "q" }], stream: false }, { source: "http" })).catch(() => undefined);
    expect((await get("/pauses")).body.pauses).toHaveLength(1);
    expect((await del("/pauses/a")).status).toBe(200);
    provider.script = OK;
    await drain(core.execute({ model: "a-1", messages: [{ role: "user", text: "q" }], stream: false }, { source: "http" }));
  });

  it("runs a health check and a catalog check now, and sends a test notification", async () => {
    const before = provider.healthCalls;
    const r = await post("/health-check", { provider: "a" });
    expect(r.body.providers[0]).toMatchObject({ id: "a", health: { ok: true } });
    expect(provider.healthCalls).toBe(before + 1);
    expect((await post("/health-check", { provider: "nobody" })).status).toBe(400);
    expect((await post("/catalog-check")).status).toBe(200);
    expect((await post("/notify-test")).body).toEqual({ delivered: true });
    expect(notified[0]).toMatch(/test notification, asked for by operator/);
  });

  it("counts kept conversations per owner without their text, and deletes an owner's", async () => {
    conversations.save({ id: "resp_1", previousId: null, owner: "app-one", model: "a-1", input: [{ role: "user", text: "a secret" }], output: "kept" });
    conversations.save({ id: "resp_2", previousId: "resp_1", owner: "app-one", model: "a-1", input: [{ role: "user", text: "more" }], output: "kept" });
    const r = await get("/conversations");
    expect(r.body.owners).toHaveLength(1);
    expect(r.body.owners[0]).toMatchObject({ owner: "app-one", threads: 1, turns: 2 });
    expect(JSON.stringify(r.body)).not.toContain("secret");
    expect((await del("/conversations/app-one")).body).toEqual({ owner: "app-one", deleted: 1 });
    expect((await get("/conversations")).body.owners).toEqual([]);
    expect((await del("/conversations/app-one")).status).toBe(404);
  });

  it("lists deliberations and one's calls, and returns the configuration it was given", async () => {
    usage.record({ provider: "a", model: "a-1", inputTokens: 5, outputTokens: 1, durationMs: 10, outcome: "ok", source: "http", ts: t, caller: "app-one", deliberation: "d-1", council: "capitoline-fast" });
    usage.record({ provider: "a", model: "a-2", inputTokens: 7, outputTokens: 2, durationMs: 12, outcome: "timeout", source: "http", ts: t + 5, caller: "app-one", deliberation: "d-1", council: "capitoline-fast" });
    const list = await get("/deliberations");
    expect(list.body.deliberations).toEqual([{ id: "d-1", council: "capitoline-fast", startedAt: t, endedAt: t + 5, calls: 2, ok: 1, inputTokens: 12, outputTokens: 3, caller: "app-one" }]);
    const one = await get("/deliberations/d-1");
    expect(one.body.calls.map((c: { model: string; outcome: string }) => [c.model, c.outcome])).toEqual([["a-1", "ok"], ["a-2", "timeout"]]);
    expect((await get("/deliberations/none")).status).toBe(404);
    expect((await get("/config")).body).toEqual({ server: { port: 8080 } });
  });
});
