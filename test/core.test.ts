import { describe, it, expect } from "vitest";
import { Core } from "../src/core/core.js";
import { UsageStore } from "../src/usage/store.js";
import { FakeProvider } from "./fake-provider.js";
import { createLogger } from "../src/log.js";
import type { ProviderEvent } from "../src/core/types.js";

const OK: ProviderEvent[] = [{ type: "text", delta: "hi" }, { type: "done", usage: { input: 3, output: 1 } }];
const req = (model: string) => ({ model, stream: false, messages: [{ role: "user" as const, text: "q" }] });
function make(opts: { now?: () => number; budgets?: Record<string, { window5h: number; window7d: number }> } = {}) {
  const a = new FakeProvider("a", ["a-1", "a-2"], OK, 1);
  const b = new FakeProvider("b", ["b-1"], OK, 2);
  const usage = new UsageStore(":memory:");
  const core = new Core([a, b], usage, { maxWaitMs: 200, budgets: opts.budgets ?? {}, log: createLogger("t"), now: opts.now });
  return { a, b, usage, core };
}
async function drain(it: AsyncIterable<ProviderEvent>) { const out: ProviderEvent[] = []; for await (const e of it) out.push(e); return out; }

describe("Core", () => {
  it("lists every model as available before any health check", () => {
    const { core } = make();
    expect(core.listModels().map((m) => [m.name, m.available])).toEqual([["a-1", true], ["a-2", true], ["b-1", true]]);
  });
  it("routes to the provider owning the model and records usage", async () => {
    const { core, a, usage } = make();
    const ev = await drain(core.execute(req("a-2"), { source: "http" }));
    expect(ev).toEqual(OK);
    expect(a.calls.length).toBe(1);
    expect(usage.totals("a", 60_000)).toEqual({ calls: 1, inputTokens: 3, outputTokens: 1 });
  });
  it("rejects unknown models", async () => {
    const { core } = make();
    await expect(drain(core.execute(req("nope"), { source: "http" }))).rejects.toMatchObject({ kind: "unknown_model" });
  });
  it("marks a provider unavailable after a failed health check and rejects its models", async () => {
    const { core, a } = make();
    a.healthResult = { ok: false, kind: "auth_expired", detail: "expired", checkedAt: 0 };
    await core.checkHealth("a");
    expect(core.listModels().find((m) => m.name === "a-1")).toMatchObject({ available: false, reason: "auth_expired" });
    await expect(drain(core.execute(req("a-1"), { source: "http" }))).rejects.toMatchObject({ kind: "model_unavailable" });
    expect(core.listModels().find((m) => m.name === "b-1")!.available).toBe(true);
  });
  it("queues beyond the concurrency limit and fails with queue_full after maxWait", async () => {
    const { core, a } = make();
    a.delayMs = 50;                                        // 2 events → ~100 ms per call, under the 200 ms max wait
    const first = drain(core.execute(req("a-1"), { source: "http" }));
    await new Promise((r) => setTimeout(r, 10));
    const second = drain(core.execute(req("a-1"), { source: "http" }));
    await expect(first).resolves.toEqual(OK);
    await expect(second).resolves.toEqual(OK);          // waited < 200 ms, then ran
    a.delayMs = 400;                                       // now a call takes ~800 ms: the queued one gives up at 200 ms
    const slow = drain(core.execute(req("a-1"), { source: "http" }));
    await new Promise((r) => setTimeout(r, 10));
    await expect(drain(core.execute(req("a-1"), { source: "http" }))).rejects.toMatchObject({ kind: "queue_full" });
    await slow;
  });
  it("pauses a provider on rate_limited with growing backoff and probes after the pause", async () => {
    let t = 1_000_000;
    const { core, a } = make({ now: () => t });
    a.script = [{ type: "error", kind: "rate_limited", detail: "429" }];
    await drain(core.execute(req("a-1"), { source: "http" }));
    expect(core.providerStates().find((p) => p.id === "a")!.pausedUntil).toBe(t + 60_000);
    await expect(drain(core.execute(req("a-1"), { source: "http" }))).rejects.toMatchObject({ kind: "rate_limited", retryAfterS: 60 });
    t += 61_000;
    a.script = OK;
    expect(await drain(core.execute(req("a-1"), { source: "http" }))).toEqual(OK);   // probe succeeded
    expect(core.providerStates().find((p) => p.id === "a")!.strikes).toBe(0);
  });
  it("pauses only the refusing model when the refusal names it, and keeps the others answering", async () => {
    // The Fable capture (host, 2026-09-21): one model exhausted while the same
    // subscription still answered on the others. Pausing the provider would
    // take the working models down with it.
    let t = 1_000_000;
    const { core, a } = make({ now: () => t });
    a.script = (r) => (r.model === "a-1" ? [{ type: "error", kind: "rate_limited", detail: "reached your a-1 limit", scope: "model" }] : OK);
    await drain(core.execute(req("a-1"), { source: "http" }));
    expect(core.providerStates().find((p) => p.id === "a")).toMatchObject({ pausedUntil: null, strikes: 0 });
    await expect(drain(core.execute(req("a-1"), { source: "http" }))).rejects.toMatchObject({ kind: "rate_limited", retryAfterS: 60 });
    expect(await drain(core.execute(req("a-2"), { source: "http" }))).toEqual(OK);
    expect(core.listModels().map((m) => [m.name, m.available, m.reason])).toEqual([
      ["a-1", false, "rate_limited"], ["a-2", true, undefined], ["b-1", true, undefined],
    ]);
    // The wait a client is told: the model's pause, not the provider's absence of one.
    expect(core.pauseRemainingS("a")).toBeUndefined();
    expect(core.pauseRemainingS("a", "a-1")).toBe(60);
    expect(core.pauseRemainingS("a", "a-2")).toBeUndefined();
    t += 61_000;                                          // the pause has run out: the model is probed again
    a.script = OK;
    expect(await drain(core.execute(req("a-1"), { source: "http" }))).toEqual(OK);
    expect(core.listModels().find((m) => m.name === "a-1")!.available).toBe(true);
  });
  it("grows the model pause with its own strikes and honours a reported reset", async () => {
    let t = 1_000_000;
    const { core, a } = make({ now: () => t });
    a.script = [{ type: "error", kind: "rate_limited", detail: "reached your a-1 limit", scope: "model" }];
    await drain(core.execute(req("a-1"), { source: "http" }));
    t += 61_000;
    await drain(core.execute(req("a-1"), { source: "http" }));
    expect(core.pauseRemainingS("a", "a-1")).toBe(120);    // second strike: 2 minutes
    // An explicit reset replaces the backoff and never shortens a longer pause.
    t += 121_000;
    a.script = [{ type: "error", kind: "rate_limited", detail: "reached your a-1 limit", scope: "model", retryAfterS: 3600 }];
    await drain(core.execute(req("a-1"), { source: "http" }));
    expect(core.pauseRemainingS("a", "a-1")).toBe(3660);
    expect(core.listModels().find((m) => m.name === "a-2")!.available).toBe(true);
  });
  it("never shortens a model pause when a second, shorter refusal lands from a request already in flight", async () => {
    const t = 1_000_000;
    // Concurrency 2: both requests pass the gate before either one fails.
    const p = new FakeProvider("p", ["p-1"], OK, 2);
    p.delayMs = 20;
    p.script = () => [{ type: "error", kind: "rate_limited", detail: "reached your p-1 limit", scope: "model", retryAfterS: p.calls.length === 1 ? 3600 : 30 }];
    const core = new Core([p], new UsageStore(":memory:"), { maxWaitMs: 200, budgets: {}, log: createLogger("t"), now: () => t });
    const long = drain(core.execute(req("p-1"), { source: "http" }));
    await new Promise((r) => setTimeout(r, 5));
    const short = drain(core.execute(req("p-1"), { source: "http" }));
    await long;
    await short;
    expect(core.pauseRemainingS("p", "p-1")).toBe(3660);
  });
  it("rejects a model-paused request that was queued when the pause landed", async () => {
    const { core, a } = make();
    a.delayMs = 30;
    a.script = [{ type: "error", kind: "rate_limited", detail: "reached your a-1 limit", scope: "model" }];
    const first = drain(core.execute(req("a-1"), { source: "http" }));
    await new Promise((r) => setTimeout(r, 10));
    const queued = drain(core.execute(req("a-1"), { source: "http" }));
    await expect(queued).rejects.toMatchObject({ kind: "rate_limited" });
    await first;
    expect(a.calls.length).toBe(1);
    expect(core.providerStates().find((p) => p.id === "a")).toMatchObject({ active: 0, waiting: 0, pausedUntil: null });
  });
  it("invalidates health immediately on auth_expired", async () => {
    const { core, a } = make();
    a.script = [{ type: "error", kind: "auth_expired", detail: "Login expired" }];
    await drain(core.execute(req("a-1"), { source: "http" }));
    expect(core.listModels().find((m) => m.name === "a-1")).toMatchObject({ available: false, reason: "auth_expired" });
  });
  it("stores rate-limit windows and flags over budget at full utilization", async () => {
    const { core, a, usage } = make();
    a.script = [{ type: "rate_limit", fiveHour: { utilization: 1, resetsAt: 5 }, sevenDay: { utilization: 0.2, resetsAt: 9 } }, ...OK];
    await drain(core.execute(req("a-1"), { source: "http" }));
    expect(usage.windows("a").five_hour!.utilization).toBe(1);
    expect(core.listModels().find((m) => m.name === "a-1")).toMatchObject({ overBudget: true, available: true });
  });
  it("keeps over budget from the stored windows when a later event reports only the other window", async () => {
    const { core, a, usage } = make();
    a.script = [{ type: "rate_limit", sevenDay: { utilization: 1, resetsAt: 9 } }, ...OK];
    await drain(core.execute(req("a-1"), { source: "http" }));
    a.script = [{ type: "rate_limit", fiveHour: { utilization: 0.5, resetsAt: 5 } }, ...OK];
    await drain(core.execute(req("a-1"), { source: "http" }));
    expect(usage.windows("a").seven_day!.utilization).toBe(1);
    expect(core.providerStates().find((p) => p.id === "a")!.overBudget).toBe(true);
  });
  it("flags over budget from configured token budgets", async () => {
    const { core } = make({ budgets: { a: { window5h: 3, window7d: 0 } } });
    await drain(core.execute(req("a-1"), { source: "http" }));
    expect(core.listModels().find((m) => m.name === "a-1")).toMatchObject({ overBudget: true, available: true });
  });
  it("rejects a request that was queued when the pause landed", async () => {
    const { core, a } = make();
    a.delayMs = 30;
    a.script = [{ type: "error", kind: "rate_limited", detail: "429" }];
    const first = drain(core.execute(req("a-1"), { source: "http" }));
    await new Promise((r) => setTimeout(r, 10));
    const queued = drain(core.execute(req("a-1"), { source: "http" }));
    await expect(queued).rejects.toMatchObject({ kind: "rate_limited" });
    await first;
    expect(a.calls.length).toBe(1);                       // the queued request never hit the provider
    expect(core.providerStates().find((p) => p.id === "a")).toMatchObject({ active: 0, waiting: 0 });
  });
  it("does not lift an active pause when an in-flight request completes", async () => {
    let t = 1_000_000;
    const { core, b } = make({ now: () => t });
    b.delayMs = 20;
    b.script = () => (b.calls.length === 1 ? [{ type: "error", kind: "rate_limited", detail: "429" }] : OK);
    const limited = drain(core.execute(req("b-1"), { source: "http" }));
    await new Promise((r) => setTimeout(r, 5));
    const fine = drain(core.execute(req("b-1"), { source: "http" }));   // concurrency 2: runs alongside
    expect(core.providerStates().find((p) => p.id === "b")).toMatchObject({ active: 2, waiting: 0 });
    await limited;
    expect(await fine).toEqual(OK);                       // done arrives after the pause was installed
    expect(core.providerStates().find((p) => p.id === "b")).toMatchObject({ pausedUntil: t + 60_000, strikes: 0 });
    await expect(drain(core.execute(req("b-1"), { source: "http" }))).rejects.toMatchObject({ kind: "rate_limited" });
  });
  it("exposes the health classification but never its detail", async () => {
    const { core, a } = make();
    a.healthResult = { ok: false, kind: "cli_crashed", detail: "/Users/someone/.config secret stderr", checkedAt: 0 };
    await core.checkHealth("a");
    const state = core.providerStates().find((p) => p.id === "a")!;
    expect(state.health).toEqual({ ok: false, kind: "cli_crashed", checkedAt: expect.any(Number) });
    expect(state.health).not.toHaveProperty("detail");
    expect(JSON.stringify(core.providerStates())).not.toContain("secret");
  });
  it("rejects a health check for an unknown provider", async () => {
    const { core } = make();
    await expect(core.checkHealth("zzz")).rejects.toMatchObject({ kind: "unknown_model" });
  });
  it("records a client abort as aborted, not as a provider failure", async () => {
    const { core, a, usage } = make();
    const outcomes = () => (usage as unknown as { db: { prepare(q: string): { all(): { outcome: string }[] } } }).db
      .prepare("SELECT outcome FROM calls WHERE provider = 'a' ORDER BY id").all().map((r) => r.outcome);
    const ac = new AbortController();
    ac.abort();
    expect(await drain(core.execute(req("a-1"), { signal: ac.signal, source: "http" }))).toEqual([]);
    for await (const ev of core.execute(req("a-1"), { source: "http" })) { if (ev.type === "text") break; }  // consumer walks away
    a.script = [{ type: "error", kind: "cli_crashed", detail: "boom" }];
    await drain(core.execute(req("a-1"), { source: "http" }));
    expect(outcomes()).toEqual(["aborted", "aborted", "cli_crashed"]);
  });
  it("runs health checks periodically until stopped", async () => {
    const { core, a } = make();
    let checks = 0;
    a.health = async () => { checks++; return { ok: true, checkedAt: Date.now() }; };
    const stop = core.startHealthLoop(10);
    await new Promise((r) => setTimeout(r, 35));
    stop();
    const afterStop = checks;
    expect(afterStop).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 30));
    expect(checks).toBe(afterStop);
  });
});

const IMG: ProviderEvent = { type: "image", mime: "image/jpeg", bytes: Buffer.from("ffd8ffe0", "hex"), width: 1376, height: 768 };
const IMG_OK: ProviderEvent[] = [IMG, { type: "done" }];
const imgReq = (model: string) => ({ model, prompt: "a lighthouse" });
function makeImages(opts: { now?: () => number; imageQuotas?: Record<string, number> } = {}) {
  const c = new FakeProvider("c", ["c-text", { name: "c-image", kind: "image" }], OK, 1);
  c.imageScript = IMG_OK;
  const usage = new UsageStore(":memory:");
  const core = new Core([c], usage, { maxWaitMs: 200, budgets: {}, log: createLogger("t"), now: opts.now, imageQuotas: opts.imageQuotas });
  return { c, usage, core };
}

describe("Core images", () => {
  it("reports the kind of every model", () => {
    const { core } = makeImages();
    expect(core.listModels().map((m) => [m.name, m.kind])).toEqual([["c-text", "text"], ["c-image", "image"]]);
  });
  it("refuses a chat request against an image model with bad_request", async () => {
    const { core, c } = makeImages();
    await expect(drain(core.execute(req("c-image"), { source: "http" }))).rejects.toMatchObject({ kind: "bad_request" });
    expect(c.calls.length).toBe(0);
  });
  it("refuses an image request against a text model with bad_request", async () => {
    const { core, c } = makeImages();
    await expect(drain(core.generateImage(imgReq("c-text"), { source: "http" }))).rejects.toMatchObject({ kind: "bad_request" });
    expect(c.imageCalls.length).toBe(0);
  });
  it("refuses an image request when the provider cannot generate images", async () => {
    const { core, c } = makeImages();
    c.generateImage = undefined;
    await expect(drain(core.generateImage(imgReq("c-image"), { source: "http" }))).rejects.toMatchObject({ kind: "bad_request" });
  });
  it("rejects unknown image models", async () => {
    const { core } = makeImages();
    await expect(drain(core.generateImage(imgReq("nope"), { source: "http" }))).rejects.toMatchObject({ kind: "unknown_model" });
  });
  it("routes an image request to the provider and records usage under the image model", async () => {
    const { core, c, usage } = makeImages();
    const ev = await drain(core.generateImage(imgReq("c-image"), { source: "mcp" }));
    expect(ev).toEqual(IMG_OK);
    expect(c.imageCalls).toEqual([imgReq("c-image")]);
    expect(c.calls.length).toBe(0);
    expect(usage.totals("c", 60_000)).toEqual({ calls: 1, inputTokens: 0, outputTokens: 0 });
    const rows = (usage as unknown as { db: { prepare(q: string): { all(): { model: string; outcome: string; source: string }[] } } }).db
      .prepare("SELECT model, outcome, source FROM calls WHERE provider = 'c'").all();
    expect(rows).toEqual([{ model: "c-image", outcome: "ok", source: "mcp" }]);
  });
  it("pauses until the reported quota reset plus a minute and still counts a strike", async () => {
    let t = 1_000_000;
    const { core, c } = makeImages({ now: () => t });
    c.imageScript = [{ type: "error", kind: "rate_limited", detail: "429", retryAfterS: 442_209 }];
    await drain(core.generateImage(imgReq("c-image"), { source: "http" }));
    expect(core.providerStates().find((p) => p.id === "c")).toMatchObject({ pausedUntil: t + (442_209 + 60) * 1000, strikes: 1 });
    // The wait a client is told is the installed pause, not the CLI's figure.
    expect(core.pauseRemainingS("c")).toBe(442_269);
    expect(core.pauseRemainingS("a")).toBeUndefined();
    await expect(drain(core.generateImage(imgReq("c-image"), { source: "http" }))).rejects.toMatchObject({ kind: "rate_limited", retryAfterS: 442_269 });
    // Chat shares the provider, so the pause holds it too.
    await expect(drain(core.execute(req("c-text"), { source: "http" }))).rejects.toMatchObject({ kind: "rate_limited", retryAfterS: 442_269 });
    t += (442_209 + 61) * 1000;
    expect(core.pauseRemainingS("c")).toBeUndefined();
    c.imageScript = IMG_OK;
    expect(await drain(core.generateImage(imgReq("c-image"), { source: "http" }))).toEqual(IMG_OK);
    expect(core.providerStates().find((p) => p.id === "c")!.strikes).toBe(0);
  });
  it("never shortens an installed pause when a second rate limit lands from a request already in flight", async () => {
    let t = 1_000_000;
    // Concurrency 2: both requests pass the pause gate before either fails.
    const c = new FakeProvider("c", ["c-text", { name: "c-image", kind: "image" }], [{ type: "error", kind: "rate_limited", detail: "429", retryAfterS: 30 }], 2);
    c.imageScript = [{ type: "error", kind: "rate_limited", detail: "429", retryAfterS: 442_209 }];
    c.delayMs = 20;
    const core = new Core([c], new UsageStore(":memory:"), { maxWaitMs: 200, budgets: {}, log: createLogger("t"), now: () => t });
    const long = drain(core.generateImage(imgReq("c-image"), { source: "http" }));
    await new Promise((r) => setTimeout(r, 5));
    const short = drain(core.execute(req("c-text"), { source: "http" }));
    expect(core.providerStates().find((p) => p.id === "c")).toMatchObject({ active: 2, waiting: 0 });
    await long;                                            // installs the multi-day pause first
    await short;                                           // the short reset arrives second and must not win
    expect(core.providerStates().find((p) => p.id === "c")).toMatchObject({ pausedUntil: t + (442_209 + 60) * 1000, strikes: 2 });
    t += 91_000;                                           // past the short reset: still paused
    await expect(drain(core.generateImage(imgReq("c-image"), { source: "http" }))).rejects.toMatchObject({ kind: "rate_limited" });
  });
  it("still pauses for the minute of slack when the reported reset is already in the past", async () => {
    let t = 1_000_000;
    const { core, c } = makeImages({ now: () => t });
    c.imageScript = [{ type: "error", kind: "rate_limited", detail: "429", retryAfterS: -3540 }];
    await drain(core.generateImage(imgReq("c-image"), { source: "http" }));
    expect(core.providerStates().find((p) => p.id === "c")).toMatchObject({ pausedUntil: t + 60_000, strikes: 1 });
    await expect(drain(core.generateImage(imgReq("c-image"), { source: "http" }))).rejects.toMatchObject({ kind: "rate_limited", retryAfterS: 60 });
  });
  it("refuses image requests and marks the image model unavailable after a failed health check", async () => {
    const { core, c } = makeImages();
    c.healthResult = { ok: false, kind: "auth_expired", detail: "expired", checkedAt: 0 };
    await core.checkHealth("c");
    expect(core.listModels().find((m) => m.name === "c-image")).toMatchObject({ available: false, reason: "auth_expired" });
    await expect(drain(core.generateImage(imgReq("c-image"), { source: "http" }))).rejects.toMatchObject({ kind: "model_unavailable" });
    expect(c.imageCalls.length).toBe(0);
  });
  it("stores rate-limit windows reported on the image path", async () => {
    const { core, c, usage } = makeImages();
    c.imageScript = [{ type: "rate_limit", fiveHour: { utilization: 0.4, resetsAt: 5 }, sevenDay: { utilization: 1, resetsAt: 9 } }, ...IMG_OK];
    await drain(core.generateImage(imgReq("c-image"), { source: "http" }));
    expect(usage.windows("c").five_hour!.utilization).toBe(0.4);
    expect(usage.windows("c").seven_day!.utilization).toBe(1);
    expect(core.listModels().find((m) => m.name === "c-image")).toMatchObject({ overBudget: true, available: true });
  });
  it("honours an explicit retry-after on the chat path as well", async () => {
    let t = 1_000_000;
    const { core, a } = make({ now: () => t });
    a.script = [{ type: "error", kind: "rate_limited", detail: "429", retryAfterS: 300 }];
    await drain(core.execute(req("a-1"), { source: "http" }));
    expect(core.providerStates().find((p) => p.id === "a")).toMatchObject({ pausedUntil: t + 360_000, strikes: 1 });
  });
  it("keeps the backoff when the rate limit carries no retry-after", async () => {
    let t = 1_000_000;
    const { core, c } = makeImages({ now: () => t });
    c.imageScript = [{ type: "error", kind: "rate_limited", detail: "429" }];
    await drain(core.generateImage(imgReq("c-image"), { source: "http" }));
    expect(core.providerStates().find((p) => p.id === "c")).toMatchObject({ pausedUntil: t + 60_000, strikes: 1 });
  });
  it("shares the provider's concurrency slot between chat and images", async () => {
    const { core, c } = makeImages();
    c.delayMs = 400;                                       // a chat call now takes ~800 ms: the image gives up at 200 ms
    const slow = drain(core.execute(req("c-text"), { source: "http" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(core.providerStates().find((p) => p.id === "c")).toMatchObject({ active: 1, waiting: 0 });
    await expect(drain(core.generateImage(imgReq("c-image"), { source: "http" }))).rejects.toMatchObject({ kind: "queue_full" });
    await slow;
    expect(c.imageCalls.length).toBe(0);
  });
  it("records a client abort of an image request as aborted", async () => {
    const { core, usage } = makeImages();
    const ac = new AbortController();
    ac.abort();
    expect(await drain(core.generateImage(imgReq("c-image"), { signal: ac.signal, source: "http" }))).toEqual([]);
    const rows = (usage as unknown as { db: { prepare(q: string): { all(): { outcome: string }[] } } }).db
      .prepare("SELECT outcome FROM calls WHERE provider = 'c'").all().map((r) => r.outcome);
    expect(rows).toEqual(["aborted"]);
  });
  it("counts a generated image against the provider's image quota window", async () => {
    let t = 1_000_000;
    const { core } = makeImages({ now: () => t, imageQuotas: { c: 12 } });
    expect(core.listModels().find((m) => m.name === "c-image")!.quota).toEqual({ used: 0, limit: 12, windowStartedAt: null, resetAt: null });
    expect(core.listModels().find((m) => m.name === "c-text")!.quota).toBeUndefined();
    await drain(core.generateImage(imgReq("c-image"), { source: "http" }));
    const opened = t;
    t += 3600_000;
    await drain(core.generateImage(imgReq("c-image"), { source: "http" }));
    expect(core.listModels().find((m) => m.name === "c-image")!.quota).toEqual({ used: 2, limit: 12, windowStartedAt: opened, resetAt: null });
    expect(core.providerStates().find((p) => p.id === "c")!.imageQuota).toEqual({ used: 2, limit: 12, windowStartedAt: opened, resetAt: null });
    // Five hours after the first generation the window has rolled over it.
    t = opened + 5 * 3600_000 + 1;
    expect(core.providerStates().find((p) => p.id === "c")!.imageQuota).toMatchObject({ used: 1, windowStartedAt: opened + 3600_000 });
  });
  it("reports no limit when no image quota is configured, and no quota at all for a provider without image models", () => {
    const { core } = makeImages();
    expect(core.listModels().find((m) => m.name === "c-image")!.quota).toEqual({ used: 0, limit: null, windowStartedAt: null, resetAt: null });
    const { core: textOnly } = make();
    expect(textOnly.providerStates().map((p) => p.imageQuota)).toEqual([null, null]);
    expect(textOnly.listModels().every((m) => m.quota === undefined)).toBe(true);
  });
  it("sets the quota reset from the reported retry-after and drops it once the reset has passed", async () => {
    let t = 1_000_000;
    const { core, c } = makeImages({ now: () => t, imageQuotas: { c: 12 } });
    // The multi-day quota: the reset instant is what a client must be shown.
    c.imageScript = [{ type: "error", kind: "rate_limited", detail: "429", retryAfterS: 442_209 }];
    await drain(core.generateImage(imgReq("c-image"), { source: "http" }));
    const resetAt = t + 442_209 * 1000;
    expect(core.listModels().find((m) => m.name === "c-image")!.quota).toEqual({ used: 0, limit: 12, windowStartedAt: null, resetAt });
    expect(core.providerStates().find((p) => p.id === "c")!.imageQuota!.resetAt).toBe(resetAt);
    t = resetAt + 1;
    expect(core.providerStates().find((p) => p.id === "c")!.imageQuota!.resetAt).toBeNull();
  });
  it("never shortens the image quota reset when a second, shorter 429 lands from a request already in flight", async () => {
    const t = 1_000_000;
    // Concurrency 2: both image runs pass the pause gate before either fails.
    const c = new FakeProvider("c", ["c-text", { name: "c-image", kind: "image" }], OK, 2);
    c.delayMs = 20;
    const core = new Core([c], new UsageStore(":memory:"), { maxWaitMs: 200, budgets: {}, log: createLogger("t"), now: () => t, imageQuotas: { c: 12 } });
    c.imageScript = [{ type: "error", kind: "rate_limited", detail: "429", retryAfterS: 442_209 }];
    const long = drain(core.generateImage(imgReq("c-image"), { source: "http" }));
    await new Promise((r) => setTimeout(r, 5));
    c.imageScript = [{ type: "error", kind: "rate_limited", detail: "429", retryAfterS: 600 }];   // the short window, reported second
    const short = drain(core.generateImage(imgReq("c-image"), { source: "http" }));
    await long;
    await short;
    expect(core.providerStates().find((p) => p.id === "c")!.imageQuota!.resetAt).toBe(t + 442_209 * 1000);
  });
  it("leaves the image quota reset alone when only the chat path is rate limited", async () => {
    const t = 1_000_000;
    const { core, c } = makeImages({ now: () => t, imageQuotas: { c: 12 } });
    c.script = [{ type: "error", kind: "rate_limited", detail: "429", retryAfterS: 300 }];
    await drain(core.execute(req("c-text"), { source: "http" }));
    expect(core.providerStates().find((p) => p.id === "c")!.imageQuota!.resetAt).toBeNull();
  });
});
