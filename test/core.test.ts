import { describe, it, expect } from "vitest";
import { Core, type AvailabilityEvent } from "../src/core/core.js";
import { UsageStore } from "../src/usage/store.js";
import { FakeProvider } from "./fake-provider.js";
import { createLogger } from "../src/log.js";
import { CLIENT_MESSAGE, type ProviderEvent } from "../src/core/types.js";
import { Council, type CouncilEvent } from "../src/council/council.js";
import type { CouncilConfig, Deliberation, Seat } from "../src/council/types.js";

const OK: ProviderEvent[] = [{ type: "text", delta: "hi" }, { type: "done", usage: { input: 3, output: 1 } }];
const req = (model: string) => ({ model, stream: false, messages: [{ role: "user" as const, text: "q" }] });
function make(opts: { now?: () => number; budgets?: Record<string, { window5h: number; window7d: number }>; usage?: UsageStore } = {}) {
  const a = new FakeProvider("a", ["a-1", "a-2"], OK, 1);
  const b = new FakeProvider("b", ["b-1"], OK, 2);
  // A store passed in is how a restart is played: a second Core over the very
  // same database, as the service gets after a bounce.
  const usage = opts.usage ?? new UsageStore(":memory:");
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
  it("neither pauses nor strikes a provider that answered busy", async () => {
    // The capture of 2026-09-22 read as rate_limited, because the rate pattern
    // listed `capacity`: the whole provider went down for a minute, with the
    // strike counter advanced, while its other seat was answering fine.
    const t = 1_000_000;
    const { core, a } = make({ now: () => t });
    a.script = [{ type: "error", kind: "busy", detail: "UNAVAILABLE (code 503): No capacity available" }];
    await drain(core.execute(req("a-1"), { source: "http" }));
    expect(core.providerStates().find((p) => p.id === "a")).toMatchObject({ pausedUntil: null, strikes: 0 });
    expect(core.pauseRemainingS("a", "a-1")).toBeUndefined();
    // Nothing is held back: the next request goes straight through.
    a.script = OK;
    expect(await drain(core.execute(req("a-1"), { source: "http" }))).toEqual(OK);
    expect(core.listModels().every((m) => m.available)).toBe(true);
  });
  it("darkens every gateway name of a refused model, not the one that called", async () => {
    // Since the ladder shipped, two names resolve to one CLI id:
    // `antigravity-gemini-pro` at the default effort *is* `gemini-3.1-pro-high`, which
    // `antigravity-gemini-pro-high` names outright. Keyed by the gateway name, the
    // second alias spent a call rediscovering the same exhausted model.
    let t = 1_000_000;
    const p = new FakeProvider("antigravity", ["pro", "pro-high", "flash"], OK, 2);
    p.aliases = { pro: "gemini-3.1-pro-high", "pro-high": "gemini-3.1-pro-high" };
    const core = new Core([p], new UsageStore(":memory:"), { maxWaitMs: 200, budgets: {}, log: createLogger("t"), now: () => t });
    p.script = [{ type: "error", kind: "rate_limited", detail: "reached your limit", scope: "model", retryAfterS: 3600 }];
    await drain(core.execute(req("pro"), { source: "http" }));
    const calls = p.calls.length;

    // The alias is refused from the state, with no second call spent on it.
    await expect(drain(core.execute(req("pro-high"), { source: "http" }))).rejects.toMatchObject({ kind: "rate_limited", retryAfterS: 3660 });
    expect(p.calls.length).toBe(calls);
    expect(core.listModels().map((m) => [m.name, m.available])).toEqual([["pro", false], ["pro-high", false], ["flash", true]]);
    // A model of the same provider on another id is untouched, and so is the provider.
    p.script = OK;
    expect(await drain(core.execute(req("flash"), { source: "http" }))).toEqual(OK);
    expect(core.providerStates()[0]).toMatchObject({ pausedUntil: null, strikes: 0 });

    // And one success on either name clears it for both.
    t += 3_661_000;
    expect(await drain(core.execute(req("pro-high"), { source: "http" }))).toEqual(OK);
    expect(core.pauseRemainingS("antigravity", "pro")).toBeUndefined();
  });
  it("keeps one provider's pause off another provider serving an id of the same name", async () => {
    // `claude-sonnet-4-6` is served by Anthropic and by Antigravity, on two
    // different subscriptions: the provider is part of the key for this reason.
    const t = 1_000_000;
    const anthropic = new FakeProvider("claude", ["sonnet"], OK, 1);
    const google = new FakeProvider("antigravity", ["antigravity-sonnet"], OK, 1);
    anthropic.aliases = { sonnet: "claude-sonnet-4-6" };
    google.aliases = { "antigravity-sonnet": "claude-sonnet-4-6" };
    const core = new Core([anthropic, google], new UsageStore(":memory:"), { maxWaitMs: 200, budgets: {}, log: createLogger("t"), now: () => t });
    anthropic.script = [{ type: "error", kind: "rate_limited", detail: "reached your limit", scope: "model" }];
    await drain(core.execute(req("sonnet"), { source: "http" }));
    expect(core.listModels().map((m) => [m.name, m.available])).toEqual([["sonnet", false], ["antigravity-sonnet", true]]);
  });
  it("translates a pause row an older build wrote under the gateway name", async () => {
    // The column holds a CLI id since the key moved off the gateway name
    // (2026-09-22). Dropping the older shape instead of translating it lost a
    // real five-day image pause on the first restart after that change, and
    // the next image request would have spent one generation of a weekly
    // quota of 58 to rediscover a refusal that was written in the table.
    const t = 1_000_000;
    const usage = new UsageStore(":memory:");
    usage.setPause("antigravity", "pro", t + 3_600_000, 2, t);              // the old, gateway-name shape
    const p = new FakeProvider("antigravity", ["pro", "flash"], OK, 1);
    p.aliases = { pro: "gemini-3.1-pro-high" };
    const core = new Core([p], usage, { maxWaitMs: 200, budgets: {}, log: createLogger("t"), now: () => t });
    core.restorePauses();
    expect(core.pauseRemainingS("antigravity", "pro")).toBe(3600);
    expect(core.listModels()).toEqual([
      expect.objectContaining({ name: "pro", available: false, reason: "rate_limited" }),
      expect.objectContaining({ name: "flash", available: true }),
    ]);
    // Rewritten in the store under the id, with its strikes, so the next start
    // finds the new shape and the translation runs once.
    // The column holds a scope: the CLI id qualified by the kind of request.
    expect(usage.pauses(t)).toEqual([{ provider: "antigravity", model: "text:gemini-3.1-pro-high", until: t + 3_600_000, strikes: 2, announcedAt: null }]);
  });
  it("drops a restored pause whose row names neither a CLI id nor a model still declared", async () => {
    const t = 1_000_000;
    const usage = new UsageStore(":memory:");
    usage.setPause("antigravity", "a-model-that-was-removed", t + 3_600_000, 1, t);
    const p = new FakeProvider("antigravity", ["pro"], OK, 1);
    p.aliases = { pro: "gemini-3.1-pro-high" };
    const core = new Core([p], usage, { maxWaitMs: 200, budgets: {}, log: createLogger("t"), now: () => t });
    core.restorePauses();
    expect(core.listModels()).toEqual([expect.objectContaining({ name: "pro", available: true })]);
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
  // The twin of the test above, in model scope: the danger is the same one,
  // and since the pause is now on disk a lifted one is not repaired by the
  // next restart either.
  it("does not lift an active model pause when an in-flight request completes", async () => {
    const t = 1_000_000;
    const usage = new UsageStore(":memory:");
    const { core, b } = make({ now: () => t, usage });
    b.delayMs = 20;
    b.script = () => (b.calls.length === 1
      ? [{ type: "error", kind: "rate_limited", detail: "reached your b-1 limit", scope: "model", retryAfterS: 3600 }]
      : OK);
    const limited = drain(core.execute(req("b-1"), { source: "http" }));
    await new Promise((r) => setTimeout(r, 5));
    const fine = drain(core.execute(req("b-1"), { source: "http" }));   // concurrency 2: runs alongside
    await limited;
    expect(await fine).toEqual(OK);                       // done arrives after the model pause was installed
    expect(core.pauseRemainingS("b", "b-1")).toBe(3660);
    // The row stands with it, and carries the strikes the success zeroed.
    expect(usage.pauses(t)).toEqual([{ provider: "b", model: "text:b-1", until: t + 3_660_000, strikes: 0, announcedAt: null }]);
    await expect(drain(core.execute(req("b-1"), { source: "http" }))).rejects.toMatchObject({ kind: "rate_limited" });
    usage.close();
  });

  it("restores a provider pause and its strikes over a restart on the same store", async () => {
    let t = 1_000_000;
    const usage = new UsageStore(":memory:");
    const first = make({ now: () => t, usage });
    first.a.script = [{ type: "error", kind: "rate_limited", detail: "429", retryAfterS: 3600 }];
    await drain(first.core.execute(req("a-1"), { source: "http" }));
    expect(first.core.providerStates().find((p) => p.id === "a")).toMatchObject({ pausedUntil: t + 3_660_000, strikes: 1 });

    const second = make({ now: () => t, usage });          // the process restarts
    expect(second.core.providerStates().find((p) => p.id === "a")).toMatchObject({ pausedUntil: null, strikes: 0 });
    second.core.restorePauses();
    expect(second.core.providerStates().find((p) => p.id === "a")).toMatchObject({ pausedUntil: t + 3_660_000, strikes: 1 });
    await expect(drain(second.core.execute(req("a-1"), { source: "http" }))).rejects.toMatchObject({ kind: "rate_limited", retryAfterS: 3660 });
    expect(second.a.calls.length).toBe(0);                 // no call spent rediscovering a refusal already known

    // The strikes came back with the pause: the next refusal doubles the
    // backoff instead of starting over at one minute.
    t += 3_661_000;
    second.a.script = [{ type: "error", kind: "rate_limited", detail: "429" }];
    await drain(second.core.execute(req("a-1"), { source: "http" }));
    expect(second.core.providerStates().find((p) => p.id === "a")).toMatchObject({ pausedUntil: t + 120_000, strikes: 2 });
    usage.close();
  });

  it("ignores a pause that has already expired and deletes its row", () => {
    const t = 1_000_000;
    const usage = new UsageStore(":memory:");
    usage.setPause("a", null, t - 1, 4, t - 60_000);
    usage.setPause("a", "a-1", t - 1, 2, t - 60_000);
    const { core } = make({ now: () => t, usage });
    core.restorePauses();
    expect(core.providerStates().find((p) => p.id === "a")).toMatchObject({ pausedUntil: null, strikes: 0 });
    expect(core.listModels().find((m) => m.name === "a-1")).toMatchObject({ available: true, reason: undefined });
    expect(usage.pauses(t - 120_000)).toEqual([]);         // dropped from the table, not merely filtered
    usage.close();
  });

  it("clears the stored pause when the model answers again", async () => {
    let t = 1_000_000;
    const usage = new UsageStore(":memory:");
    const { core, a } = make({ now: () => t, usage });
    a.script = [{ type: "error", kind: "rate_limited", detail: "reached your a-1 limit", scope: "model" }];
    await drain(core.execute(req("a-1"), { source: "http" }));
    expect(usage.pauses(t)).toEqual([{ provider: "a", model: "text:a-1", until: t + 60_000, strikes: 1, announcedAt: null }]);
    t += 61_000;
    a.script = OK;
    expect(await drain(core.execute(req("a-1"), { source: "http" }))).toEqual(OK);
    expect(core.pauseRemainingS("a", "a-1")).toBeUndefined();
    expect(usage.pauses(t)).toEqual([]);                   // the row goes with the memory
    usage.close();
  });

  it("restores a provider pause and a model pause of the same provider together", async () => {
    let t = 1_000_000;
    const usage = new UsageStore(":memory:");
    const first = make({ now: () => t, usage });
    first.a.script = (r) => (r.model === "a-1"
      ? [{ type: "error", kind: "rate_limited", detail: "reached your a-1 limit", scope: "model", retryAfterS: 3600 }]
      : [{ type: "error", kind: "rate_limited", detail: "429" }]);
    await drain(first.core.execute(req("a-1"), { source: "http" }));   // the model alone
    await drain(first.core.execute(req("a-2"), { source: "http" }));   // then the whole provider

    const second = make({ now: () => t, usage });
    second.core.restorePauses();
    expect(second.core.pauseRemainingS("a")).toBe(60);
    expect(second.core.pauseRemainingS("a", "a-1")).toBe(3660);        // the longer of the two holds the model
    expect(second.core.pauseRemainingS("a", "a-2")).toBe(60);
    t += 61_000;                                                       // the provider is free again, the model is not
    expect(await drain(second.core.execute(req("a-2"), { source: "http" }))).toEqual(OK);
    await expect(drain(second.core.execute(req("a-1"), { source: "http" }))).rejects.toMatchObject({ kind: "rate_limited", retryAfterS: 3599 });
    usage.close();
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
  it("pauses only the health model when the probe is refused for that model alone", async () => {
    // The probe runs one model (health_model). The very same CLI answer pauses
    // that model alone when it comes from a client request, so it must not
    // take the provider down when it comes from the probe: the other models
    // would go 404 in /v1/models until this one's limit expires, and the loop
    // would renew the verdict every round.
    let t = 1_000_000;
    const { core, a } = make({ now: () => t });
    a.healthResult = { ok: false, kind: "rate_limited", detail: "reached your a-1 limit", scope: "model", model: "a-1", checkedAt: 0 };
    await core.checkHealth("a");
    expect(core.providerStates().find((p) => p.id === "a")).toMatchObject({ health: null, pausedUntil: null });
    expect(core.listModels().map((m) => [m.name, m.available, m.reason])).toEqual([
      ["a-1", false, "rate_limited"], ["a-2", true, undefined], ["b-1", true, undefined],
    ]);
    expect(await drain(core.execute(req("a-2"), { source: "http" }))).toEqual(OK);
    await expect(drain(core.execute(req("a-1"), { source: "http" }))).rejects.toMatchObject({ kind: "rate_limited" });
    t += 61_000;                                          // the model's own pause runs out like any other
    a.healthResult = { ok: true, checkedAt: 0 };
    expect(core.listModels().find((m) => m.name === "a-1")!.available).toBe(true);
  });
  // A probe is a real call, so a pause is as binding on it as on a client
  // request. This is what makes restorePauses() before the first check
  // (main.ts) worth the ordering: without the skip the startup spends the
  // refusal all over again, and every hourly round after it.
  it("skips the probe of a paused provider and checks again once the pause ends", async () => {
    let t = 1_000_000;
    const { core, a } = make({ now: () => t });
    a.script = [{ type: "error", kind: "rate_limited", detail: "429", retryAfterS: 3600 }];
    await drain(core.execute(req("a-1"), { source: "http" }));
    await core.checkHealth("a");
    expect(a.healthCalls).toBe(0);
    // The health on record is untouched: the pause alone is what makes the
    // models unavailable, and a verdict nobody took must not be invented.
    expect(core.providerStates().find((p) => p.id === "a")!.health).toBeNull();
    t += 3_661_000;
    await core.checkHealth("a");
    expect(a.healthCalls).toBe(1);
    expect(core.providerStates().find((p) => p.id === "a")!.health).toMatchObject({ ok: true });
  });
  it("skips the probe when the model it runs is paused, and probes the other providers", async () => {
    let t = 1_000_000;
    const { core, a, b } = make({ now: () => t });
    a.healthModel = "a-1";
    a.script = [{ type: "error", kind: "rate_limited", detail: "reached your a-1 limit", scope: "model" }];
    await drain(core.execute(req("a-1"), { source: "http" }));
    await core.checkHealth();
    expect(a.healthCalls).toBe(0);
    expect(b.healthCalls).toBe(1);                        // one provider's pause stops one provider's probe
    t += 61_000;
    await core.checkHealth("a");
    expect(a.healthCalls).toBe(1);
  });
  it("still probes when the paused model is not the one the probe runs", async () => {
    // The probe says something about the models that still answer, and a
    // provider whose health went stale would take them all down with it.
    const t = 1_000_000;
    const { core, a } = make({ now: () => t });
    a.healthModel = "a-2";
    a.script = [{ type: "error", kind: "rate_limited", detail: "reached your a-1 limit", scope: "model" }];
    await drain(core.execute(req("a-1"), { source: "http" }));
    await core.checkHealth("a");
    expect(a.healthCalls).toBe(1);
  });
  it("still marks the provider when a rate limit carries no model attribution", async () => {
    const { core, a } = make();
    a.healthResult = { ok: false, kind: "rate_limited", detail: "usage limit reached", checkedAt: 0 };
    await core.checkHealth("a");
    expect(core.listModels().filter((m) => m.provider === "a").map((m) => m.available)).toEqual([false, false]);
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
  it("does not take a text model down with an exhausted image quota on the same id", async () => {
    // `antigravity-image` and `antigravity-gemini-flash-low` are one CLI id,
    // `gemini-3.8-flash-low`, and two different quotas: image generation has
    // its own 12-per-5-hours and 58-per-7-days windows while the text models
    // answer from another allowance (spike §8). Keyed by the id alone, the
    // five-day image refusal of 2026-09-22 took the text model with it on the
    // restart of the 23rd, and with it the third rung of `capitoline-gemini`.
    const t = 1_000_000;
    const c = new FakeProvider("c", ["c-text", { name: "c-image", kind: "image" }], OK, 1);
    c.aliases = { "c-text": "gemini-3.8-flash-low", "c-image": "gemini-3.8-flash-low" };
    c.imageScript = [{ type: "error", kind: "rate_limited", detail: "exhausted your capacity", scope: "model", retryAfterS: 432_000 }];
    const usage = new UsageStore(":memory:");
    const core = new Core([c], usage, { maxWaitMs: 200, budgets: {}, log: createLogger("t"), now: () => t });

    await drain(core.generateImage(imgReq("c-image"), { source: "http" }));
    expect(core.listModels().map((m) => [m.name, m.available])).toEqual([["c-text", true], ["c-image", false]]);
    // A restart still says when the image model returns: the reset is read
    // back from the pause, a minute of slack included.
    const c2 = new FakeProvider("c", ["c-text", { name: "c-image", kind: "image" }], OK, 1);
    c2.aliases = c.aliases;
    const restarted = new Core([c2], usage, { maxWaitMs: 200, budgets: {}, log: createLogger("t"), now: () => t });
    restarted.restorePauses();
    expect(restarted.listModels().find((m) => m.name === "c-image")!.quota!.resetAt).toBe(t + 432_060_000);
    // And the text model really answers, rather than merely being listed.
    expect(await drain(core.execute(req("c-text"), { source: "http" }))).toEqual(OK);
    expect(core.providerStates()[0]).toMatchObject({ pausedUntil: null, strikes: 0 });
    // The stored scope says which quota it was, so a restart keeps them apart.
    expect(usage.pauses(t)).toEqual([{ provider: "c", model: "image:gemini-3.8-flash-low", until: t + 432_060_000, strikes: 1, announcedAt: null }]);
  });
  it("records the image model a refusal names, so /v1/usage can date a change of it", async () => {
    // A successful generation names only the agent; the quota refusal's body
    // names the model inside the tool. Recorded on the refused row, it shows
    // in the model identities under the gateway name that asked.
    const t = 1_000_000;
    const c = new FakeProvider("c", ["c-text", { name: "c-image", kind: "image" }], OK, 1);
    c.imageScript = [{ type: "error", kind: "rate_limited", detail: "quota", scope: "model", retryAfterS: 3600, cliModelId: "gemini-3.1-flash-image" }];
    const usage = new UsageStore(":memory:");
    const core = new Core([c], usage, { maxWaitMs: 200, budgets: {}, log: createLogger("t"), now: () => t });
    await drain(core.generateImage(imgReq("c-image"), { source: "http" }));
    expect(usage.modelIdentities(3600_000, t)).toEqual([{ model: "c-image", cliModelId: "gemini-3.1-flash-image", calls: 1, firstAt: t, lastAt: t }]);
  });
  it("brings an image pause back across a restart without touching the text model", () => {
    const t = 1_000_000;
    const usage = new UsageStore(":memory:");
    usage.setPause("c", "image:gemini-3.8-flash-low", t + 432_000_000, 1, t);
    const c = new FakeProvider("c", ["c-text", { name: "c-image", kind: "image" }], OK, 1);
    c.aliases = { "c-text": "gemini-3.8-flash-low", "c-image": "gemini-3.8-flash-low" };
    const core = new Core([c], usage, { maxWaitMs: 200, budgets: {}, log: createLogger("t"), now: () => t });
    core.restorePauses();
    expect(core.listModels().map((m) => [m.name, m.available])).toEqual([["c-text", true], ["c-image", false]]);
  });
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

// --- Virtual models (task 5) ---------------------------------------------
//
// A council is asked for in `model` like every other model, so the routing is
// Core's business; what the council does with the question is council.test.ts.
// The two seats and the judge below are the repository's panel in miniature:
// enough to seat a quorum, and small enough that taking one provider down
// breaks it.
const VSEATS: Seat[] = [
  { family: "anthropic", models: ["claude-opus", "claude-sonnet"] },
  { family: "openai", models: ["codex-astra"] },
];
const VJUDGE: Seat = { family: "anthropic", models: ["claude-haiku"] };
const VCFG: CouncilConfig = { seats: VSEATS, judge: VJUDGE, judgeAllowMember: false, judgeBlind: true, minMembers: 2, ranking: true, stageTimeoutS: 5 };

/** A deliberation detail with nothing in it: the routing carries it whole and never reads it. */
const DETAIL: Deliberation = {
  deliberationId: "d-1", strategyVersion: 1, shape: "ranked", members: [], lost: [], rankings: [], aggregate: [],
  judge: { model: "a-2", blind: true }, calls: 2,
};
const answered: CouncilEvent[] = [{ type: "text", delta: "the synthesis" }, { type: "done", usage: { input: 6, output: 2 }, detail: DETAIL }];
/** A run that replays a fixed list of events and records the question it was given. */
function fakeRun(events: CouncilEvent[], seen: string[] = []) {
  const run = async function* (question: string): AsyncIterable<CouncilEvent> { seen.push(question); yield* events; };
  return { run, seen };
}

describe("Core virtual models", () => {
  it("routes a request for a virtual model to its run and to no provider", async () => {
    const { core, a, b } = make();
    const { run, seen } = fakeRun(answered);
    core.registerVirtual("capitoline", run);
    expect(await drain(core.execute(req("capitoline"), { source: "http" }))).toEqual([
      { type: "text", delta: "the synthesis" }, { type: "done", usage: { input: 6, output: 2 } },
    ]);
    expect(seen).toEqual(["q"]);
    expect([a.calls.length, b.calls.length]).toEqual([0, 0]);
  });

  it("hands the run the whole conversation as one question, the system message included", async () => {
    const { core } = make();
    const { run, seen } = fakeRun(answered);
    core.registerVirtual("capitoline", run);
    await drain(core.execute({
      model: "capitoline", stream: false,
      messages: [{ role: "system", text: "Answer in French" }, { role: "user", text: "why?" }, { role: "assistant", text: "because" }, { role: "user", text: "and?" }],
    }, { source: "http" }));
    // The council has no system-prompt channel of its own — its prompts are the
    // strategy (§12.8) — so a client's system message is folded into the
    // question rather than dropped in silence.
    expect(seen[0]).toBe("Answer in French\n\nUser: why?\n\nAssistant: because\n\nUser: and?");
  });

  it("takes no provider slot of its own: its members take them, one by one", async () => {
    const { core, a, usage } = make();
    a.delayMs = 20;                                    // 2 events → ~40 ms per call, two calls well inside the 200 ms max wait
    core.registerVirtual("capitoline", async function* (question, ctx) {
      // Two members on the same provider, which offers one slot. Had the
      // council request taken that slot for itself, the first member would sit
      // on the queue until maxWait and come back queue_full: this passing is
      // what "the queue stays honest" means.
      for (const model of ["a-1", "a-2"]) {
        for await (const _ev of core.execute({ model, stream: false, messages: [{ role: "user", text: question }] }, { ...ctx, deliberation: "d-1" })) { /* drained */ }
      }
      yield* answered;
    });
    expect(await drain(core.execute(req("capitoline"), { source: "http" }))).toEqual([
      { type: "text", delta: "the synthesis" }, { type: "done", usage: { input: 6, output: 2 } },
    ]);
    expect(a.calls.map((c) => c.model)).toEqual(["a-1", "a-2"]);
    // The rows are the members', under the real models that served them, tied
    // together by the deliberation (§12.7). The council itself is no provider
    // and writes none.
    expect(usage.totals("a", 60_000).calls).toBe(2);
    expect(usage.totals("capitoline", 60_000).calls).toBe(0);
    expect(usage.deliberationTotals("d-1").calls).toBe(2);
  });

  it("keeps the progress for a transport that can render it and drops it for one that cannot", async () => {
    const { core } = make();
    const progress: CouncilEvent = { type: "progress", stage: "answers", done: 0, total: 2 };
    core.registerVirtual("capitoline", fakeRun([progress, ...answered]).run);
    const events: CouncilEvent[] = [];
    for await (const ev of core.deliberate(req("capitoline"), { source: "http" })) events.push(ev);
    expect(events).toEqual([progress, ...answered]);
    // An ordinary completion has nowhere to put "2/4 answers", so execute()
    // carries the text and the usage and nothing else.
    expect((await drain(core.execute(req("capitoline"), { source: "http" }))).map((e) => e.type)).toEqual(["text", "done"]);
  });

  it("reports the council's failure as an error of the same kind", async () => {
    const { core } = make();
    const failed: CouncilEvent[] = [{ type: "error", kind: "queue_full", detail: "no member answered: queue_full" }];
    core.registerVirtual("capitoline", fakeRun(failed).run);
    // queue_full and model_unavailable are not ErrorKinds: a council that ends
    // on one must still reach the client as a 503 or a 404, not as a 502.
    await expect(drain(core.execute(req("capitoline"), { source: "http" }))).rejects.toMatchObject({ kind: "queue_full" });
    const events: CouncilEvent[] = [];
    for await (const ev of core.deliberate(req("capitoline"), { source: "http" })) events.push(ev);
    expect(events).toEqual(failed);      // the event form is left whole for the transports
  });

  it("refuses what a council has no channel for, before a single call is spent", async () => {
    const { core } = make();
    const { run, seen } = fakeRun(answered);
    core.registerVirtual("capitoline", run);
    // The OpenAI conversion puts an image in `attachments` and leaves only the
    // text of the message behind, so a message that is an image and nothing
    // else would reach the panel as the empty question: nine real calls on
    // three subscriptions, on nothing, with the image seen by nobody.
    const withImage = { ...req("capitoline"), messages: [{ role: "user" as const, text: "" }], attachments: [{ mime: "image/png", bytes: Buffer.from("x") }] };
    await expect(drain(core.execute(withImage, { source: "http" }))).rejects.toMatchObject({ kind: "bad_request" });
    // The empty question in its own right: every seat would be asked nothing,
    // and the ranking stage would rank the answers to it.
    const empty = { ...req("capitoline"), messages: [{ role: "user" as const, text: "   " }] };
    await expect(drain(core.execute(empty, { source: "http" }))).rejects.toMatchObject({ kind: "bad_request" });
    const deliberating = (async () => { for await (const _ev of core.deliberate(empty, { source: "http" })) { /* never reached */ } })();
    await expect(deliberating).rejects.toMatchObject({ kind: "bad_request" });
    expect(seen).toEqual([]);                          // the deliberation never started
  });

  it("answers a failed council with the sentence of its kind and none of its account", async () => {
    const { core } = make();
    const detail = "no member answered: anthropic claude-opus rate_limited, claude-sonnet rate_limited; openai codex-astra rate_limited";
    core.registerVirtual("capitoline", fakeRun([{ type: "error", kind: "rate_limited", detail }]).run);
    // Which chains were refused and for what is the log's business and the
    // `capitoline` field's (§12.6): a 4xx/5xx body of this gateway carries the
    // fixed sentence of the kind, whatever model was asked for.
    await expect(drain(core.execute(req("capitoline"), { source: "http" })))
      .rejects.toMatchObject({ kind: "rate_limited", message: CLIENT_MESSAGE.rate_limited });
  });

  it("refuses a name a provider already serves, and the same name twice", () => {
    const { core } = make();
    const { run } = fakeRun(answered);
    expect(() => core.registerVirtual("a-1", run)).toThrow(/a-1/);
    core.registerVirtual("capitoline", run);
    expect(() => core.registerVirtual("capitoline", run)).toThrow(/capitoline/);
  });

  it("refuses an image request for a council, and a deliberation for a provider model", async () => {
    const { core } = make();
    core.registerVirtual("capitoline", fakeRun(answered).run);
    await expect(drain(core.generateImage({ model: "capitoline", prompt: "a lighthouse" }, { source: "http" }))).rejects.toMatchObject({ kind: "bad_request" });
    // The other way round: a provider model is no council, and a transport
    // that asked for its deliberation asked the wrong question.
    const deliberating = (async () => { for await (const _ev of core.deliberate(req("a-1"), { source: "http" })) { /* never reached */ } })();
    await expect(deliberating).rejects.toMatchObject({ kind: "bad_request" });
  });
});

/** Core, two providers holding the panel's models, and the council over them: the wiring main.ts builds. */
function makeSeated() {
  const claude = new FakeProvider("claude", ["claude-opus", "claude-sonnet", "claude-haiku"], OK, 2);
  const codex = new FakeProvider("codex", ["codex-astra"], OK, 1);
  const usage = new UsageStore(":memory:");
  const core = new Core([claude, codex], usage, { maxWaitMs: 200, budgets: {}, log: createLogger("t") });
  const council = new Council("capitoline", VCFG, core, createLogger("t"));
  core.registerVirtual("capitoline", (question, ctx) => council.deliberate(question, ctx), (models) => council.seatable(models));
  return { core, claude, codex, usage, council };
}

describe("Core council availability", () => {
  it("lists a council as a model of its own while the quorum of its seats can be filled", () => {
    const { core } = makeSeated();
    expect(core.listModels().find((m) => m.name === "capitoline")).toEqual({
      name: "capitoline", provider: "capitoline", kind: "council", available: true, overBudget: false,
    });
    // It is the last of the list, after the real models: the ones it is seated from.
    expect(core.listModels().at(-1)!.name).toBe("capitoline");
  });

  it("reports the council unavailable, with the reason, once the quorum cannot be filled", async () => {
    const { core, codex } = makeSeated();
    codex.healthResult = { ok: false, kind: "auth_expired", detail: "expired", checkedAt: 0 };
    await core.checkHealth("codex");
    const listed = core.listModels().find((m) => m.name === "capitoline")!;
    expect(listed.available).toBe(false);
    // The reason is a count and a quorum, never a provider's own words: this
    // travels to the client in /v1/models.
    expect(listed.reason).toMatch(/1 of 2 seats/);
    expect(listed.reason).toMatch(/quorum/);
    expect(listed.reason).not.toMatch(/expired/);
  });

  it("refuses a request for a council whose quorum cannot be filled", async () => {
    const { core, claude, codex } = makeSeated();
    codex.healthResult = { ok: false, kind: "auth_expired", detail: "expired", checkedAt: 0 };
    await core.checkHealth("codex");
    // The same refusal guarded() gives for a real model whose provider is
    // down, and the one /v1/models and /health have already published: with
    // one seat left the council would otherwise spend a call and hand back a
    // single model's answer under its own name (§12.5, spec 6.1).
    await expect(drain(core.execute(req("capitoline"), { source: "http" }))).rejects.toMatchObject({ kind: "model_unavailable" });
    const deliberating = (async () => { for await (const _ev of core.deliberate(req("capitoline"), { source: "http" })) { /* never reached */ } })();
    await expect(deliberating).rejects.toMatchObject({ kind: "model_unavailable" });
    expect(claude.calls.length).toBe(0);
  });

  it("seats a council from the real models alone, never from another council", () => {
    const { core, council } = makeSeated();
    const seen: string[][] = [];
    core.registerVirtual("capitoline-2", (q, ctx) => council.deliberate(q, ctx), (models) => {
      seen.push(models.map((m) => m.name));
      return council.seatable(models);
    });
    core.listModels();
    expect(seen[0]).toEqual(["claude-opus", "claude-sonnet", "claude-haiku", "codex-astra"]);
  });
});

// What server.notify is told about providers and models going away and coming
// back (docs/deploy.md §7.2). The listener stands in for the notifier.
describe("availability notices", () => {
  function makeTold(now: () => number, usage = new UsageStore(":memory:"), listen = true) {
    const a = new FakeProvider("a", ["a-1", "a-2"], OK, 1);
    const b = new FakeProvider("b", ["b-1"], OK, 2);
    const told: AvailabilityEvent[] = [];
    const core = new Core([a, b], usage, { maxWaitMs: 200, budgets: {}, log: createLogger("t"), now, onAvailability: listen ? (e) => told.push(e) : undefined });
    return { a, b, usage, core, told };
  }
  const quota = (retryAfterS: number, scope?: "model"): ProviderEvent[] => [{ type: "error", kind: "rate_limited", detail: "quota", retryAfterS, ...(scope ? { scope } : {}) }];

  it("tells a quota pause when it starts, and nothing for the backoff after a refusal with no reset", async () => {
    let t = 1_000_000;
    const { a, b, core, told } = makeTold(() => t);
    a.script = quota(7200);
    await drain(core.execute(req("a-1"), { source: "http" }));
    b.script = [{ type: "error", kind: "rate_limited", detail: "429" }];
    await drain(core.execute(req("b-1"), { source: "http" }));
    expect(told).toEqual([{ kind: "paused", provider: "a", scope: null, until: t + 7_260_000 }]);
  });

  it("tells the end of a quota pause that stood an hour or more, and not of a shorter one", async () => {
    let t = 1_000_000;
    const { a, b, core, told } = makeTold(() => t);
    a.script = quota(7200);
    await drain(core.execute(req("a-1"), { source: "http" }));
    b.script = quota(600);
    await drain(core.execute(req("b-1"), { source: "http" }));
    core.sweepPauses();
    expect(told.map((e) => e.kind)).toEqual(["paused", "paused"]);
    t += 7_261_000;
    core.sweepPauses();
    core.sweepPauses();
    expect(told.slice(2)).toEqual([{ kind: "resumed", provider: "a", scope: null, pausedMs: 7_260_000 }]);
  });

  it("names the model when the quota was the model's own", async () => {
    let t = 1_000_000;
    const { a, core, told } = makeTold(() => t);
    a.script = quota(7200, "model");
    await drain(core.execute(req("a-1"), { source: "http" }));
    expect(told).toEqual([{ kind: "paused", provider: "a", scope: "text:a-1", until: t + 7_260_000 }]);
  });

  it("does not tell a pause twice across a restart, and tells its end, even one that came while stopped", async () => {
    let t = 1_000_000;
    const usage = new UsageStore(":memory:");
    const first = makeTold(() => t, usage);
    first.a.script = quota(7200);
    await drain(first.core.execute(req("a-1"), { source: "http" }));
    expect(usage.pauses(t)[0].announcedAt).toBe(t);
    // Restarted while the pause stands: nothing new, then its end at the sweep.
    const second = makeTold(() => t, usage);
    second.core.restorePauses();
    expect(second.told).toEqual([]);
    t += 7_261_000;
    second.core.sweepPauses();
    expect(second.told).toEqual([{ kind: "resumed", provider: "a", scope: null, pausedMs: 7_260_000 }]);
    // Restarted after it ran out, with nobody watching: told at the restore.
    first.b.script = quota(7200);
    await drain(first.core.execute(req("b-1"), { source: "http" }));
    t += 7_261_000;
    const third = makeTold(() => t, usage);
    third.core.restorePauses();
    expect(third.told).toEqual([{ kind: "resumed", provider: "b", scope: null, pausedMs: 7_260_000 }]);
  });

  it("tells a run of refusals with no reset once it has lasted an hour, and its end", async () => {
    let t = 1_000_000;
    const { a, usage, core, told } = makeTold(() => t);
    const bare: ProviderEvent[] = [{ type: "error", kind: "rate_limited", detail: "You've reached your limit", scope: "model" }];
    usage.setWindow("a", "seven_day", { utilization: 0.4, resetsAt: Math.floor((t + 5 * 86_400_000) / 1000) }, t);
    a.script = bare;
    await drain(core.execute(req("a-1"), { source: "http" }));
    t += 10 * 60_000;                          // the backoff has passed; refused again, still under the hour
    await drain(core.execute(req("a-1"), { source: "http" }));
    expect(told).toEqual([]);
    t += 55 * 60_000;                          // refused again, 65 minutes after the first
    await drain(core.execute(req("a-1"), { source: "http" }));
    expect(told).toEqual([{ kind: "refusing", provider: "a", scope: "text:a-1", refusedMs: 65 * 60_000, weeklyResetAt: Math.floor((1_000_000 + 5 * 86_400_000) / 1000) * 1000 }]);
    t += 40 * 60_000;                          // told once, however long it goes on
    await drain(core.execute(req("a-1"), { source: "http" }));
    expect(told).toHaveLength(1);
    t += 3 * 3600_000;
    a.script = OK;                             // and its return
    await drain(core.execute(req("a-1"), { source: "http" }));
    expect(told[1]).toEqual({ kind: "resumed", provider: "a", scope: "text:a-1", pausedMs: (65 + 40 + 180) * 60_000 });
    // A fresh run of refusals starts its own hour.
    a.script = bare;
    await drain(core.execute(req("a-1"), { source: "http" }));
    expect(told).toHaveLength(2);
  });

  it("records nothing as announced when nobody listens", async () => {
    let t = 1_000_000;
    const { a, core, usage } = makeTold(() => t, new UsageStore(":memory:"), false);
    a.script = quota(7200);
    await drain(core.execute(req("a-1"), { source: "http" }));
    expect(usage.pauses(t)[0].announcedAt).toBeNull();
  });

  it("tells a provider signing out once, from a request or a probe, and signing back in", async () => {
    let t = 1_000_000;
    const { a, b, core, told } = makeTold(() => t);
    a.script = [{ type: "error", kind: "auth_expired", detail: "Login expired" }];
    await drain(core.execute(req("a-1"), { source: "http" }));
    a.healthResult = { ok: false, kind: "auth_expired", checkedAt: 0 };
    await core.checkHealth("a");
    a.healthResult = { ok: true, checkedAt: 0 };
    await core.checkHealth("a");
    b.healthResult = { ok: false, kind: "auth_expired", checkedAt: 0 };
    await core.checkHealth("b");
    await core.checkHealth("b");
    expect(told).toEqual([
      { kind: "signed_out", provider: "a" },
      { kind: "signed_in", provider: "a" },
      { kind: "signed_out", provider: "b" },
    ]);
  });
});

// One failed token renewal looks like a sign-out to a probe; the next probe
// finds the provider signed in. A healthy provider gets a second probe first.
describe("a healthy provider's first auth_expired probe", () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  function makeRecheck() {
    const a = new FakeProvider("a", ["a-1"], OK);
    const told: AvailabilityEvent[] = [];
    const core = new Core([a], new UsageStore(":memory:"), { maxWaitMs: 100, budgets: {}, log: createLogger("t"), onAvailability: (e) => told.push(e), authRecheckMs: 20 });
    return { a, core, told };
  }
  const available = (core: Core) => core.listModels().find((m) => m.name === "a-1")!.available;

  it("is not believed: the provider stays available, nothing is told, and a good second probe closes it", async () => {
    const { a, core, told } = makeRecheck();
    await core.checkHealth("a");
    a.healthResult = { ok: false, kind: "auth_expired", checkedAt: 0 };
    await core.checkHealth("a");
    expect(available(core)).toBe(true);
    a.healthResult = { ok: true, checkedAt: 0 };
    await wait(80);
    await core.idle();
    expect(a.healthCalls).toBe(3);
    expect(available(core)).toBe(true);
    expect(told).toEqual([]);
  });

  // The same doubt for a probe that got no answer in time or whose CLI ended
  // badly: one slow answer must not take a provider that is answering out.
  it("holds for a slow or crashed probe too, and for nothing that has its own handling", async () => {
    for (const kind of ["timeout", "cli_crashed", "bad_output"] as const) {
      const { a, core, told } = makeRecheck();
      await core.checkHealth("a");
      a.healthResult = { ok: false, kind, checkedAt: 0 };
      await core.checkHealth("a");
      expect(available(core), kind).toBe(true);
      a.healthResult = { ok: true, checkedAt: 0 };
      await wait(80);
      await core.idle();
      expect(a.healthCalls, kind).toBe(3);
      expect(available(core), kind).toBe(true);
      expect(told, kind).toEqual([]);
    }
    // Said twice, it is believed.
    const { a, core } = makeRecheck();
    await core.checkHealth("a");
    a.healthResult = { ok: false, kind: "timeout", checkedAt: 0 };
    await core.checkHealth("a");
    await wait(80);
    await core.idle();
    expect(a.healthCalls).toBe(3);
    expect(available(core)).toBe(false);
  });

  it("is believed when the second probe says the same, once", async () => {
    const { a, core, told } = makeRecheck();
    await core.checkHealth("a");
    a.healthResult = { ok: false, kind: "auth_expired", checkedAt: 0 };
    await core.checkHealth("a");
    await wait(80);
    await core.idle();
    expect(a.healthCalls).toBe(3);
    expect(available(core)).toBe(false);
    expect(told).toEqual([{ kind: "signed_out", provider: "a" }]);
  });

  it("holds for a request too: the provider stays in, and the confirming probe decides", async () => {
    const { a, core, told } = makeRecheck();
    await core.checkHealth("a");
    a.script = [{ type: "error", kind: "auth_expired", detail: "Login expired" }];
    expect(await drain(core.execute(req("a-1"), { source: "http" }))).toMatchObject([{ type: "error", kind: "auth_expired" }]);
    expect(await drain(core.execute(req("a-1"), { source: "http" }))).toMatchObject([{ type: "error", kind: "auth_expired" }]);
    expect(available(core)).toBe(true);     // not out on a request's word
    expect(told).toEqual([]);
    await wait(80);                          // the probe finds it signed in
    await core.idle();
    expect(a.healthCalls).toBe(2);           // one confirming probe for the two refusals
    expect(available(core)).toBe(true);
    expect(told).toEqual([]);

    a.healthResult = { ok: false, kind: "auth_expired", checkedAt: 0 };
    expect(await drain(core.execute(req("a-1"), { source: "http" }))).toMatchObject([{ type: "error", kind: "auth_expired" }]);
    await wait(80);                          // this time the probe agrees
    await core.idle();
    expect(available(core)).toBe(false);
    expect(told).toEqual([{ kind: "signed_out", provider: "a" }]);
  });

  it("is believed at once at startup, and never probed again after a cancel", async () => {
    const first = makeRecheck();
    first.a.healthResult = { ok: false, kind: "auth_expired", checkedAt: 0 };
    await first.core.checkHealth("a");
    expect(first.told).toEqual([{ kind: "signed_out", provider: "a" }]);
    const { a, core } = makeRecheck();
    await core.checkHealth("a");
    a.healthResult = { ok: false, kind: "auth_expired", checkedAt: 0 };
    await core.checkHealth("a");
    core.cancelAuthRechecks();
    await wait(80);
    expect(a.healthCalls).toBe(2);
  });
});

// Images a request carries: refused for a CLI that takes text only, never
// written into its sandbox and silently ignored as they were before.
describe("images in Core", () => {
  const img = { mime: "image/png", bytes: Buffer.from("png") };
  it("refuses them for a model whose CLI takes text only, before any call", async () => {
    const { core, a } = make();
    a.acceptsAttachments = false;
    await expect(drain(core.execute({ ...req("a-1"), attachments: [img] }, { source: "http" }))).rejects.toMatchObject({ kind: "bad_request", message: expect.stringMatching(/cannot take images/) });
    expect(a.calls).toHaveLength(0);
  });
  it("hands them to a model that takes them, within the limits", async () => {
    const { core, b } = make();
    await drain(core.execute({ ...req("b-1"), attachments: [img] }, { source: "http" }));
    expect(b.calls[0].attachments).toEqual([img]);
    await expect(drain(core.execute({ ...req("b-1"), attachments: Array(17).fill(img) }, { source: "http" }))).rejects.toMatchObject({ kind: "bad_request", message: expect.stringMatching(/at most 16/) });
    await expect(drain(core.execute({ ...req("b-1"), attachments: [{ mime: "text/plain", bytes: Buffer.from("x") }] }, { source: "http" }))).rejects.toMatchObject({ kind: "bad_request" });
    expect(b.calls).toHaveLength(1);
  });
});
