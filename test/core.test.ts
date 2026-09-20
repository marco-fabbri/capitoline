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
