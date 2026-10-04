import { describe, expect, it } from "vitest";
import { Core } from "../src/core/core.js";
import { UsageStore } from "../src/usage/store.js";
import { createLogger } from "../src/log.js";
import { FakeProvider } from "./fake-provider.js";
import { Council, type CouncilCore, type CouncilEvent } from "../src/council/council.js";
import type { CouncilConfig, Deliberation, Seat } from "../src/council/types.js";
import type { InternalRequest, ProviderEvent } from "../src/core/types.js";

// Compile-time only, erased whole (a type alias emits nothing): the real Core
// must satisfy the slice of it the council asks for. `CouncilCore` exists so
// the engine can be tested without a Core at all, and it is worth nothing if
// the Core the service actually builds stops fitting it — which is exactly
// what task 5 will hand the council.
type IsCouncilCore<T extends CouncilCore> = T;
type _CoreFits = IsCouncilCore<Core>;

const QUESTION = "Should a gateway retry a refused call?";

// One answer per model, and never a model name inside one: the answers are
// rendered into the ranking and synthesis prompts, and one test asserts that no
// prompt the council sends carries a model name (the panel is blind).
const ANSWERS: Record<string, string> = {
  "claude-fable": "Retry once, and only on a refusal the state did not predict.",
  "claude-opus": "A single retry is the most a deliberation can afford.",
  "claude-sonnet": "Retrying twice turns one slow question into four calls.",
  "claude-haiku": "Retry on quota, give up on a crash.",
  "codex-astra": "Retry on quota; a crash is not a quota.",
  "codex-sol": "One step down the chain, then give up the seat.",
  "antigravity-pro": "It depends whether the refusal is about the model or the subscription.",
  "antigravity-flash": "Retry, but bound the whole thing by a deadline.",
  "antigravity-oss": "No: a failed call is evidence the seat is gone.",
};
const SYNTHESIS = "Retry exactly once, and only when the refusal was not already known.";

// The stage a prompt belongs to, read from the prompts the engine actually
// sends. A fake panel has to answer stage 2 in JSON and stage 3 in prose, and
// the only thing that tells them apart is the text of the prompt — which is
// also how this file notices if a stage stops using the prompt it should.
const RANKING_MARK = "Reply with JSON only";
const SYNTHESIS_MARK = "You are writing the final answer";
type Stage = "answers" | "rankings" | "synthesis";
function stageOf(prompt: string): Stage {
  if (prompt.includes(RANKING_MARK)) return "rankings";
  if (prompt.includes(SYNTHESIS_MARK)) return "synthesis";
  return "answers";
}

// A ranking of exactly the labels the prompt showed, worst first, so the
// aggregate is predictable whatever the seeded shuffle did: the last label
// shown (the highest letter) is everybody's rank 1.
function rankingReply(prompt: string): string {
  const shown = [...prompt.matchAll(/^(Response [A-Z]+):$/gm)].map((m) => m[1]);
  return JSON.stringify(shown.map((label, i) => ({ label, rank: shown.length - i, reason: "reversed, so the aggregate is predictable" })));
}

const SEATS: Seat[] = [
  { family: "anthropic", models: ["claude-fable", "claude-opus", "claude-sonnet"] },
  { family: "openai", models: ["codex-astra", "codex-sol"] },
  { family: "google", models: ["antigravity-pro", "antigravity-flash"] },
  { family: "open-weights", models: ["antigravity-oss"] },
];
// The repository's own judge chain: claude-haiku closes it because it sits in
// no seat, so a blind judge always has a model of its own left.
const JUDGE: Seat = { family: "anthropic", models: ["claude-opus", "claude-sonnet", "claude-haiku"] };
const CFG: CouncilConfig = { seats: SEATS, judge: JUDGE, judgeAllowMember: false, judgeBlind: true, minMembers: 2, ranking: true, stageTimeoutS: 5 };

const fail = (kind: "rate_limited" | "cli_crashed" | "auth_expired", scope?: "model", retryAfterS?: number): ProviderEvent[] =>
  [{ type: "error", kind, detail: `${kind} from the fake`, ...(scope ? { scope } : {}), ...(retryAfterS !== undefined ? { retryAfterS } : {}) }];

// A provider detail as a real one is: `cli-provider` puts the last two
// thousand characters of the CLI's stderr in it. Nothing carrying this string
// may appear in anything the council hands a client — the `Deliberation` goes
// into the `capitoline` field of an ordinary response, and the error event
// becomes the client's error.
const SENTINEL = "SECRET-STDERR";
const leaky = (kind: "rate_limited" | "cli_crashed"): ProviderEvent[] =>
  [{ type: "error", kind, detail: `${SENTINEL}: Traceback (most recent call last) ...` }];

interface PanelOptions {
  /**
   * Per model: what the fake answers instead of the default, at every stage.
   * A function is called per request, which is how a model that fails once and
   * then answers is written.
   */
  overrides?: Record<string, ProviderEvent[] | ((req: InternalRequest) => ProviderEvent[])>;
  /** Models that answer the ranking stage with something no parser can trust. */
  badRanking?: string[];
  cfg?: Partial<CouncilConfig>;
  /** The busy backoff in milliseconds; a test that means to watch the wait sets it. */
  busyRetryMs?: number;
}

// A real Core over fake providers, which is the point: every member call has to
// go through Core.execute(), so the queue, the pauses and the usage rows apply
// to a council member exactly as to a direct request.
function panel(opts: PanelOptions = {}) {
  const overrides = new Map(Object.entries(opts.overrides ?? {}));
  const reply = (req: InternalRequest): ProviderEvent[] => {
    const over = overrides.get(req.model);
    if (over) return typeof over === "function" ? over(req) : over;
    const prompt = req.messages[0].text;
    const stage = stageOf(prompt);
    const broken = stage === "rankings" && (opts.badRanking ?? []).includes(req.model);
    const text = broken ? "I would rather not put a number on it." : stage === "rankings" ? rankingReply(prompt) : stage === "synthesis" ? SYNTHESIS : ANSWERS[req.model];
    return [{ type: "text", delta: text }, { type: "done", usage: { input: 10, output: 2 } }];
  };
  const claude = new FakeProvider("claude", ["claude-fable", "claude-opus", "claude-sonnet", "claude-haiku"], reply, 1);
  const codex = new FakeProvider("codex", ["codex-astra", "codex-sol"], reply, 1);
  // Two slots, as config/capitoline.yaml gives Antigravity: it serves two seats.
  const antigravity = new FakeProvider("antigravity", ["antigravity-pro", "antigravity-flash", "antigravity-oss"], reply, 2);
  const store = new UsageStore(":memory:");
  const core = new Core([claude, codex, antigravity], store, { maxWaitMs: 500, budgets: {}, log: createLogger("t") });
  // A millisecond of busy backoff, not five seconds: the wait is a real timer
  // and every test that never meets a busy provider would otherwise pay for it.
  const council = new Council("capitoline", { ...CFG, ...opts.cfg }, core, createLogger("t"), opts.busyRetryMs ?? 1);
  const calls = () => [...claude.calls, ...codex.calls, ...antigravity.calls];
  return {
    claude, codex, antigravity, store, core, council, calls,
    prompts: () => calls().map((c) => c.messages[0].text),
    promptsOf: (stage: Stage) => calls().map((c) => c.messages[0].text).filter((p) => stageOf(p) === stage),
    /** The models called, optionally only in one stage: the same model can serve a seat in stage 1 and the judge in stage 3. */
    modelsAsked: (stage?: Stage) => calls().filter((c) => stage === undefined || stageOf(c.messages[0].text) === stage).map((c) => c.model),
    rows: () => ["claude", "codex", "antigravity"].reduce((n, id) => n + store.totals(id, 3600_000).calls, 0),
  };
}

async function run(it: AsyncIterable<CouncilEvent>): Promise<CouncilEvent[]> {
  const out: CouncilEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}
const textOf = (events: CouncilEvent[]): string => events.filter((e) => e.type === "text").map((e) => e.delta).join("");
const detailOf = (events: CouncilEvent[]): Deliberation => {
  const done = events.find((e) => e.type === "done");
  if (done === undefined) throw new Error(`no done event: ${JSON.stringify(events)}`);
  return done.detail;
};

describe("Council", () => {
  it("runs nine calls in three stages and reports the deliberation", async () => {
    const p = panel();
    const events = await run(p.council.deliberate(QUESTION, { source: "http" }));

    expect(textOf(events)).toBe(SYNTHESIS);
    const d = detailOf(events);
    expect(d.members.map((m) => [m.family, m.model])).toEqual([
      ["anthropic", "claude-fable"], ["openai", "codex-astra"], ["google", "antigravity-pro"], ["open-weights", "antigravity-oss"],
    ]);
    expect(d.members.map((m) => m.answer)).toEqual(d.members.map((m) => ANSWERS[m.model]));
    expect([...d.members.map((m) => m.label)].sort()).toEqual(["Response A", "Response B", "Response C", "Response D"]);
    expect(d.lost).toEqual([]);
    expect(d.rankings.map((r) => r.by)).toEqual(["claude-fable", "codex-astra", "antigravity-pro", "antigravity-oss"]);
    // Every member ranked the labels worst first, so the last one shown wins.
    expect(d.aggregate).toEqual([
      { label: "Response D", averageRank: 1, votes: 4 },
      { label: "Response C", averageRank: 2, votes: 4 },
      { label: "Response B", averageRank: 3, votes: 4 },
      { label: "Response A", averageRank: 4, votes: 4 },
    ]);
    expect(d.judge).toEqual({ model: "claude-opus", blind: true });
    expect(d.shape).toBe("ranked");
    expect(d.strategyVersion).toBeGreaterThanOrEqual(1);

    // Nine calls, nine rows: the accounting of §12.7 only holds because every
    // one of them went through Core.execute().
    expect(d.calls).toBe(9);
    expect(p.calls()).toHaveLength(9);
    expect(p.rows()).toBe(9);
    const done = events.find((e) => e.type === "done")!;
    expect(done.usage).toEqual({ input: 90, output: 18 });

    // One progress event per stage start, one per completion.
    expect(events.filter((e) => e.type === "progress").map((e) => [e.stage, e.done, e.total])).toEqual([
      ["answers", 0, 4], ["answers", 1, 4], ["answers", 2, 4], ["answers", 3, 4], ["answers", 4, 4],
      ["rankings", 0, 4], ["rankings", 1, 4], ["rankings", 2, 4], ["rankings", 3, 4], ["rankings", 4, 4],
      ["synthesis", 0, 1], ["synthesis", 1, 1],
    ]);
  });

  // The `-fast` shape: the same four seats, stage 2 skipped. Five calls
  // instead of nine for a question that does not need the panel's own verdict
  // on its answers, which is a flag and not another strategy (plan
  // 2026-09-22-council-variants, design §12.1).
  it("runs five calls in two stages when the council is configured without a ranking", async () => {
    const p = panel({ cfg: { ranking: false } });
    const events = await run(p.council.deliberate(QUESTION, { source: "http" }));
    const d = detailOf(events);

    expect(textOf(events)).toBe(SYNTHESIS);
    expect(d.members.map((m) => m.model)).toEqual(["claude-fable", "codex-astra", "antigravity-pro", "antigravity-oss"]);
    // Four answers and the synthesis: five calls, five rows. The accounting of
    // §12.7 is the whole point of the shape.
    expect(d.calls).toBe(5);
    expect(p.calls()).toHaveLength(5);
    expect(p.rows()).toBe(5);
    expect(p.promptsOf("rankings")).toEqual([]);
    expect(d.rankings).toEqual([]);
    expect(d.aggregate).toEqual([]);
    // No ranking progress either: a client that renders the stages must not be
    // shown one that never runs.
    expect(events.filter((e) => e.type === "progress").map((e) => [e.stage, e.done, e.total])).toEqual([
      ["answers", 0, 4], ["answers", 1, 4], ["answers", 2, 4], ["answers", 3, 4], ["answers", 4, 4],
      ["synthesis", 0, 1], ["synthesis", 1, 1],
    ]);
    // The labels are still assigned and the judge is still blind: anonymity is
    // what the judge reads the answers under, and it does not depend on stage 2.
    expect([...d.members.map((m) => m.label)].sort()).toEqual(["Response A", "Response B", "Response C", "Response D"]);
    expect(d.judge).toEqual({ model: "claude-opus", blind: true });
  });

  // The request's effort is the shape (design §12.9): `low` is the five-call
  // council, `high` the nine-call one, and every other value resolves to the
  // nearer of the two by the rule a model's effort follows, ties upward — so
  // `medium` is the full council, as is no effort at all.
  it("takes the request's effort as its shape: low skips the ranking, medium and high run it", async () => {
    const low = panel();
    const lowEvents = await run(low.council.deliberate(QUESTION, { source: "http" }, "low"));
    expect(textOf(lowEvents)).toBe(SYNTHESIS);
    expect(detailOf(lowEvents)).toMatchObject({ shape: "fast", calls: 5, rankings: [], aggregate: [] });
    expect(low.promptsOf("rankings")).toEqual([]);
    expect(lowEvents.filter((e) => e.type === "progress" && e.stage === "rankings")).toEqual([]);

    const medium = panel();
    const d = detailOf(await run(medium.council.deliberate(QUESTION, { source: "http" }, "medium")));
    expect(d.shape).toBe("ranked");
    expect(d.calls).toBe(9);
    expect(medium.promptsOf("rankings")).toHaveLength(4);
  });

  // `ranking: false` pins the shape: the configuration, not the request,
  // decided it, and Core never hands such a council an effort. Even if one
  // arrived, `high` could not switch a stage on that the council does not have.
  it("stays pinned to the fast shape whatever the effort when configured without a ranking", async () => {
    const p = panel({ cfg: { ranking: false } });
    const d = detailOf(await run(p.council.deliberate(QUESTION, { source: "http" }, "high")));
    expect(d.shape).toBe("fast");
    expect(d.calls).toBe(5);
    expect(p.promptsOf("rankings")).toEqual([]);
  });

  it("says which shape ran, next to the aggregate a degraded panel still reports", async () => {
    const fast = detailOf(await run(panel({ cfg: { ranking: false } }).council.deliberate(QUESTION, { source: "http" })));
    expect(fast.shape).toBe("fast");
    expect(fast.aggregate).toEqual([]);
    // The other way of losing every vote: a full panel where no member's
    // ranking could be parsed. `rankings` is empty here too, but the aggregate
    // is not — it is seeded with the labels, so the four answers are still
    // named to the judge and to the client, each with `votes: 0`. That is the
    // difference this test pins: an empty `aggregate` is never a degraded
    // panel that ranked, so `shape` is not there to rescue an ambiguity but to
    // state the council's shape instead of leaving it to be read off votes.
    const broken = panel({ badRanking: ["claude-fable", "codex-astra", "antigravity-pro", "antigravity-oss"] });
    const d = detailOf(await run(broken.council.deliberate(QUESTION, { source: "http" })));
    expect(d.shape).toBe("ranked");
    expect(d.rankings).toEqual([]);
    expect(d.aggregate).toEqual([
      { label: "Response A", averageRank: 0, votes: 0 },
      { label: "Response B", averageRank: 0, votes: 0 },
      { label: "Response C", averageRank: 0, votes: 0 },
      { label: "Response D", averageRank: 0, votes: 0 },
    ]);
    expect(d.calls).toBe(9);
  });

  it("gives the judge of a fast council the answers with no ranking section at all", async () => {
    const p = panel({ cfg: { ranking: false } });
    const d = detailOf(await run(p.council.deliberate(QUESTION, { source: "http" })));
    const synthesis = p.promptsOf("synthesis")[0];
    for (const m of d.members) { expect(synthesis).toContain(m.label); expect(synthesis).toContain(m.answer); }
    // Not an empty ranking, and not a word about one: no ranking happened, and
    // a judge told the panel ranked the answers would weigh a vote that was
    // never cast.
    expect(synthesis).not.toContain("The panel's ranking");
    expect(synthesis).not.toMatch(/rank/i);
  });

  it("keeps the quorum in a fast council: one answer is returned as it is, unsynthesised", async () => {
    // min_members keeps its meaning without stage 2: below it there is still
    // nothing to synthesize, so the single answer is returned as its member
    // wrote it and no judge is called.
    const p = panel({ cfg: { ranking: false }, overrides: {
      "codex-astra": fail("cli_crashed"), "codex-sol": fail("cli_crashed"),
      "antigravity-pro": fail("cli_crashed"), "antigravity-oss": fail("cli_crashed"),
    } });
    const events = await run(p.council.deliberate(QUESTION, { source: "http" }));
    const d = detailOf(events);
    expect(textOf(events)).toBe(ANSWERS["claude-fable"]);
    expect(d.shape).toBe("fast");
    expect(d.judge.model).toBe("");
    expect(p.promptsOf("synthesis")).toEqual([]);
  });

  it("keeps the deliberation blind: no prompt names a model, and only the others' labels are shown", async () => {
    const p = panel();
    const events = await run(p.council.deliberate(QUESTION, { source: "http" }));
    const seated = detailOf(events).members.map((m) => m.model);
    for (const prompt of p.prompts()) {
      for (const model of [...seated, "claude-opus", "claude-haiku"]) expect(prompt).not.toContain(model);
    }
    // Stage 1 knows nothing of the panel at all.
    for (const prompt of p.promptsOf("answers")) expect(prompt).not.toContain("Response ");
    // Stage 2 and 3 carry labels and nothing else.
    for (const prompt of [...p.promptsOf("rankings"), ...p.promptsOf("synthesis")]) {
      expect([...prompt.matchAll(/^(Response [A-Z]+):$/gm)]).toHaveLength(4);
    }
  });

  it("skips a member paused before the start and seats the next of its chain", async () => {
    const p = panel();
    // A pause a previous process installed, read back exactly as a restart does.
    const now = Date.now();
    p.store.setPause("claude", "claude-fable", now + 3600_000, 1, now);
    p.core.restorePauses();

    const d = detailOf(await run(p.council.deliberate(QUESTION, { source: "http" })));
    expect(d.members[0]).toMatchObject({ family: "anthropic", model: "claude-opus" });
    expect(d.members[0].fellBackFrom).toEqual(["claude-fable (rate_limited)"]);
    expect(p.modelsAsked()).not.toContain("claude-fable");
    // The judge is seated apart from the members: claude-opus is taken, so it
    // walks down its own chain.
    expect(d.judge.model).toBe("claude-sonnet");
    expect(d.lost).toEqual([]);
  });

  it("steps a seat down once after an unforeseen refusal, and no further", async () => {
    const p = panel({ overrides: { "claude-fable": fail("rate_limited", "model"), "claude-opus": fail("rate_limited", "model") } });
    const events = await run(p.council.deliberate(QUESTION, { source: "http" }));
    const d = detailOf(events);

    expect([...p.modelsAsked("answers")].sort()).toEqual(["antigravity-oss", "antigravity-pro", "claude-fable", "claude-opus", "codex-astra"]);
    expect(p.modelsAsked("answers")).not.toContain("claude-sonnet");   // the one retry is spent, not the chain
    // The seat is gone, but the judge's own chain steps around the model the
    // refusal just paused, which is the state doing its work.
    expect(d.judge.model).toBe("claude-sonnet");
    expect(d.members.map((m) => m.family)).toEqual(["openai", "google", "open-weights"]);
    // The kind alone, never the provider's words — and both models the seat
    // walked, so the operator reads two falls and not one.
    expect(d.lost).toEqual([{ family: "anthropic", model: "claude-opus", reason: "rate_limited", fellBackFrom: ["claude-fable (rate_limited)"] }]);
    expect(textOf(events)).toBe(SYNTHESIS);
  });

  it("seats the model the step-down lands on, and records where it came from", async () => {
    const p = panel({ overrides: { "claude-fable": fail("rate_limited", "model") } });
    const d = detailOf(await run(p.council.deliberate(QUESTION, { source: "http" })));
    expect(d.members[0]).toMatchObject({ family: "anthropic", model: "claude-opus", answer: ANSWERS["claude-opus"] });
    expect(d.members[0].fellBackFrom).toEqual(["claude-fable (rate_limited)"]);
    expect(d.lost).toEqual([]);
    expect(d.calls).toBe(10);                                  // nine plus the refused one
  });

  it("loses a seat that times out, declares it, and deliberates with the rest", async () => {
    const p = panel({ cfg: { stageTimeoutS: 0.1 } });
    p.antigravity.delayMs = 300;                                       // both Antigravity seats overrun
    const events = await run(p.council.deliberate(QUESTION, { source: "http" }));
    const d = detailOf(events);
    expect(d.members.map((m) => m.family)).toEqual(["anthropic", "openai"]);
    expect(d.lost.map((l) => [l.family, l.model, l.reason.split(":")[0]])).toEqual([
      ["google", "antigravity-pro", "timeout"], ["open-weights", "antigravity-oss", "timeout"],
    ]);
    expect(textOf(events)).toBe(SYNTHESIS);
    expect(d.aggregate.map((a) => a.votes)).toEqual([2, 2]);
  });

  it("returns the single answer as it is when the panel falls below the quorum", async () => {
    const p = panel({ overrides: {
      "codex-astra": fail("cli_crashed"), "codex-sol": fail("cli_crashed"),
      "antigravity-pro": fail("cli_crashed"), "antigravity-oss": fail("cli_crashed"),
    } });
    const events = await run(p.council.deliberate(QUESTION, { source: "http" }));
    expect(textOf(events)).toBe(ANSWERS["claude-fable"]);
    const d = detailOf(events);
    expect(d.members.map((m) => m.model)).toEqual(["claude-fable"]);
    expect(d.rankings).toEqual([]);
    expect(d.aggregate).toEqual([]);
    expect(d.judge.model).toBe("");                            // nobody synthesised a single opinion
    expect(d.lost).toHaveLength(3);
    expect(p.promptsOf("rankings")).toEqual([]);
    expect(p.promptsOf("synthesis")).toEqual([]);
  });

  it("errors with the kind of the failure that speaks for the panel when nobody answered", async () => {
    const p = panel({ overrides: {
      "claude-fable": fail("auth_expired"), "claude-opus": fail("cli_crashed"),
      "codex-astra": fail("cli_crashed"), "antigravity-pro": fail("cli_crashed"), "antigravity-oss": fail("cli_crashed"),
    } });
    const events = await run(p.council.deliberate(QUESTION, { source: "http" }));
    expect(events.find((e) => e.type === "done")).toBeUndefined();
    const err = events.find((e) => e.type === "error");
    expect(err?.kind).toBe("auth_expired");                    // the only kind the client can do anything about
    expect(err?.detail).toContain("no member answered");
  });

  it("seats the judge apart from the members by default, and among them when the option is on", async () => {
    const now = Date.now();
    for (const allow of [false, true]) {
      const p = panel({ cfg: { judgeAllowMember: allow } });
      p.store.setPause("claude", "claude-fable", now + 3600_000, 1, now);
      p.core.restorePauses();
      const d = detailOf(await run(p.council.deliberate(QUESTION, { source: "http" })));
      expect(d.members[0].model).toBe("claude-opus");
      expect(d.judge.model).toBe(allow ? "claude-opus" : "claude-sonnet");
    }
  });

  it("un-blinds the judge when it is configured to see, and says so in the deliberation", async () => {
    const p = panel({ cfg: { judgeBlind: false } });
    const d = detailOf(await run(p.council.deliberate(QUESTION, { source: "http" })));
    expect(d.judge.blind).toBe(false);
    const synthesis = p.promptsOf("synthesis")[0];
    for (const m of d.members) expect(synthesis).toContain(`${m.label} (${m.model})`);
  });

  it("keeps a member's answer when its ranking cannot be parsed, and counts the rest", async () => {
    const p = panel({ badRanking: ["antigravity-oss"] });
    const events = await run(p.council.deliberate(QUESTION, { source: "http" }));
    const d = detailOf(events);
    expect(d.members.map((m) => m.model)).toContain("antigravity-oss");        // the answer stays
    expect(d.rankings.map((r) => r.by)).toEqual(["claude-fable", "codex-astra", "antigravity-pro"]);
    expect(d.aggregate.every((a) => a.votes === 3)).toBe(true);        // three votes, four labels
    expect(d.aggregate).toHaveLength(4);
    expect(textOf(events)).toBe(SYNTHESIS);
  });

  it("keeps the provider's own detail out of the deliberation and out of every error", async () => {
    // A seat lost mid-flight: the detail is the CLI's stderr, the reason is the kind.
    const one = panel({ overrides: { "claude-fable": leaky("cli_crashed") } });
    const d = detailOf(await run(one.council.deliberate(QUESTION, { source: "http" })));
    expect(d.lost).toEqual([{ family: "anthropic", model: "claude-fable", reason: "cli_crashed" }]);
    expect(JSON.stringify(d)).not.toContain(SENTINEL);

    // Nobody answered: the error is built from the same reasons.
    const none = panel({ overrides: Object.fromEntries(
      ["claude-fable", "codex-astra", "antigravity-pro", "antigravity-oss"].map((m) => [m, leaky("cli_crashed")])) });
    const err = (await run(none.council.deliberate(QUESTION, { source: "http" }))).find((e) => e.type === "error");
    expect(err?.detail).toContain("no member answered");
    expect(err?.detail).not.toContain(SENTINEL);

    // And the judge, which is the one failure that reaches a client after the
    // answer was promised.
    const judge = panel({ overrides: { "claude-opus": leaky("cli_crashed") } });
    const judgeErr = (await run(judge.council.deliberate(QUESTION, { source: "http" }))).find((e) => e.type === "error");
    expect(judgeErr).toEqual({ type: "error", kind: "cli_crashed", detail: "the judge failed: cli_crashed" });
  });

  it("lets a judge that crashed step down once onto another provider, and only then", async () => {
    // The chain crosses providers: claude-opus, then antigravity-flash, which
    // sits in no seat of this panel because antigravity-pro answered first.
    const judge: Seat = { family: "best-available", models: ["claude-opus", "antigravity-flash", "claude-haiku"] };
    for (const failure of [fail("cli_crashed"), [{ type: "done", usage: { input: 1, output: 0 } }] as ProviderEvent[]]) {
      const p = panel({ cfg: { judge }, overrides: { "claude-opus": failure } });
      const events = await run(p.council.deliberate(QUESTION, { source: "http" }));
      const d = detailOf(events);
      expect(d.judge.model).toBe("antigravity-flash");
      expect(textOf(events)).toBe(SYNTHESIS);
      expect(p.modelsAsked("synthesis")).toEqual(["claude-opus", "antigravity-flash"]);
      expect(d.calls).toBe(10);
    }
    // The same crash with the next judge on the same CLI is the error it was:
    // the repository's own chain here is claude-opus, claude-sonnet, claude-haiku.
    const same = panel({ overrides: { "claude-opus": fail("cli_crashed") } });
    const err = (await run(same.council.deliberate(QUESTION, { source: "http" }))).find((e) => e.type === "error");
    expect(err).toEqual({ type: "error", kind: "cli_crashed", detail: "the judge failed: cli_crashed" });
    expect(same.modelsAsked("synthesis")).toEqual(["claude-opus"]);
  });

  it("reports the failure a client can act on, not the one whose seat comes first", async () => {
    const p = panel({ overrides: {
      "codex-astra": fail("rate_limited", "model", 1200), "codex-sol": fail("rate_limited", "model", 1200),
      "antigravity-pro": fail("cli_crashed"), "antigravity-oss": fail("cli_crashed"),
    } });
    // The anthropic seat is the first declared and is empty by state, which
    // would speak as model_unavailable: a 404 with no Retry-After, for a panel
    // whose openai seat was refused on quota.
    p.claude.healthResult = { ok: false, checkedAt: 0 };
    await p.core.checkHealth("claude");
    const err = (await run(p.council.deliberate(QUESTION, { source: "http" }))).find((e) => e.type === "error");
    expect(err?.kind).toBe("rate_limited");
    // With the kind travels the wait the refusal named: a council has no
    // provider of its own for the server to ask `pauseRemainingS` about, so
    // without this the 429 would carry the fixed default of `httpStatus`
    // whatever the subscription said (app.ts).
    expect(err?.retryAfterS).toBe(1200);
  });

  it("attributes every call of a deliberation to the caller that asked for it", async () => {
    const p = panel();
    const d = detailOf(await run(p.council.deliberate(QUESTION, { source: "http", caller: "tester@example" })));
    expect(d.calls).toBe(9);
    expect(p.store.callers(3600_000).find((c) => c.caller === "tester@example")?.calls).toBe(9);
    expect(p.store.callers(3600_000).find((c) => c.caller === null)).toBeUndefined();
  });

  it("ties the nine usage rows together with a deliberation identifier", async () => {
    const p = panel();
    const first = detailOf(await run(p.council.deliberate(QUESTION, { source: "http" })));
    expect(first.deliberationId).toMatch(/^[0-9a-f-]{36}$/);
    // §12.7: the cost of one question, summed across the six models that served it.
    expect(p.store.deliberationTotals(first.deliberationId)).toEqual({ calls: 9, inputTokens: 90, outputTokens: 18 });
    // And under the council's own name, which the real models' rows would not say.
    expect(p.store.deliberations(5).find((d) => d.id === first.deliberationId)).toMatchObject({ council: "capitoline", calls: 9, ok: 9 });
    const second = detailOf(await run(p.council.deliberate(QUESTION, { source: "http" })));
    expect(second.deliberationId).not.toBe(first.deliberationId);
    expect(p.store.deliberationTotals(first.deliberationId).calls).toBe(9);
  });

  it("tells each member which answer is its own, and tells no other member that label", async () => {
    const p = panel();
    const d = detailOf(await run(p.council.deliberate(QUESTION, { source: "http" })));
    const rankings = p.calls().filter((c) => stageOf(c.messages[0].text) === "rankings");
    expect(rankings).toHaveLength(4);
    for (const m of d.members) {
      const own = `One of them, ${m.label}, is your own answer`;
      const mine = rankings.filter((c) => c.model === m.model);
      expect(mine).toHaveLength(1);
      expect(mine[0].messages[0].text).toContain(own);
      for (const other of rankings.filter((c) => c.model !== m.model)) expect(other.messages[0].text).not.toContain(own);
    }
  });

  it("returns the best-ranked answer when no judge can be seated, instead of losing eight calls", async () => {
    // The judge's whole chain sits in a seat, and the judge may not be a member.
    const p = panel({ cfg: { judge: { family: "anthropic", models: ["claude-fable"] } } });
    const events = await run(p.council.deliberate(QUESTION, { source: "http" }));
    const d = detailOf(events);
    expect(d.judge).toEqual({ model: "", blind: true });
    const top = d.members.find((m) => m.label === d.aggregate[0].label)!;
    expect(textOf(events)).toBe(ANSWERS[top.model]);
    expect(p.promptsOf("synthesis")).toEqual([]);
    expect(d.calls).toBe(8);
  });

  it("starts no call at all when the request was cancelled before the first stage", async () => {
    const p = panel();
    const ac = new AbortController();
    ac.abort();                                            // a listener added later would never fire
    const events = await run(p.council.deliberate(QUESTION, { source: "http", signal: ac.signal }));
    expect(p.calls()).toEqual([]);
    expect(events.find((e) => e.type === "done")).toBeUndefined();
    expect(events.find((e) => e.type === "error")).toBeUndefined();
  });

  it("stops at the end of the stage a cancelled request was in", async () => {
    const p = panel();
    p.claude.delayMs = 40;
    p.codex.delayMs = 40;
    p.antigravity.delayMs = 40;
    const ac = new AbortController();
    const events: CouncilEvent[] = [];
    for await (const ev of p.council.deliberate(QUESTION, { source: "http", signal: ac.signal })) {
      events.push(ev);
      if (ev.type === "progress" && ev.stage === "answers" && ev.done === 1) ac.abort();
    }
    expect(events.find((e) => e.type === "done")).toBeUndefined();
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    expect(p.promptsOf("rankings")).toEqual([]);
    expect(p.promptsOf("synthesis")).toEqual([]);
  });
});

describe("a busy provider", () => {
  const BUSY: ProviderEvent[] = [{ type: "error", kind: "busy", detail: "UNAVAILABLE (code 503): No capacity available for model gpt-oss-120b-medium on the server" }];

  it("is waited out in place, and the seat keeps the model it was given", async () => {
    // The capture that named the kind: `antigravity-oss` answered 503 during the first
    // real deliberation. The model was not refused, the provider's server was
    // full, so stepping down the chain would move to another model of the same
    // provider and buy nothing.
    let asked = 0;
    const p = panel({ overrides: { "antigravity-oss": () => (++asked === 1 ? BUSY : [{ type: "text", delta: ANSWERS["antigravity-oss"] }, { type: "done", usage: { input: 10, output: 2 } }]) } });
    const events = await run(p.council.deliberate(QUESTION, { source: "http" }));
    const done = events.find((e) => e.type === "done")!;
    expect(done.detail.lost).toEqual([]);
    expect(done.detail.members.map((m) => m.model)).toContain("antigravity-oss");
    // Asked twice, and the second time the same model: no fallback recorded.
    expect(asked).toBeGreaterThanOrEqual(2);
    expect(done.detail.members.find((m) => m.model === "antigravity-oss")!.fellBackFrom).toBeUndefined();
  });

  it("loses the seat when the wait does not help, without stepping down", async () => {
    const p = panel({ overrides: { "antigravity-oss": BUSY } });
    const events = await run(p.council.deliberate(QUESTION, { source: "http" }));
    const done = events.find((e) => e.type === "done")!;
    expect(done.detail.lost).toEqual([{ family: "open-weights", model: "antigravity-oss", reason: "busy" }]);
    // The provider is untouched: a full server says nothing about the quota,
    // so its other seat keeps answering and no pause was installed.
    expect(p.core.providerStates().find((x) => x.id === "antigravity")).toMatchObject({ pausedUntil: null, strikes: 0 });
    expect(done.detail.members.map((m) => m.model)).toContain("antigravity-pro");
  });
});
