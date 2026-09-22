import { describe, it, expect } from "vitest";
import { seat, nextInChain, labels, type ModelState, type Seated } from "../src/council/seating.js";
import type { Seat } from "../src/council/types.js";
import type { ModelInfo } from "../src/core/core.js";

// Compile-time only, and erased whole: a type alias emits nothing at all, so
// unlike a `const` these leave no unused function behind in the built test.
//
// The first guard says what Core.listModels() returns must be what seat()
// takes, or the engine would have to translate the state on the way in and the
// two shapes could drift apart unnoticed. It is not enough on its own: every
// field of ModelState but `name` and `available` is optional, so ModelInfo
// could lose or rename `reason` and this would still compile — while seat()
// silently recorded a bare "unavailable" for every skip and lost
// rate_limited/auth_expired, with every assertion below still green. The
// second guard names that field, and stops compiling if it goes.
type TakesCoreState<T extends (seats: Seat[], state: ModelInfo[]) => Seated> = T;
type _StateComesFromCore = TakesCoreState<typeof seat>;
type CarriesReason<T extends ModelState["reason"]> = T;
type _ReasonFlows = CarriesReason<ModelInfo["reason"]>;

// The four default seats of config/capitoline.yaml, shortened: what matters
// here is a chain with a fallback, a chain of one, and two seats of different
// families.
const ANTHROPIC: Seat = { family: "anthropic", models: ["claude-fable", "claude-opus", "claude-sonnet"] };
const OPENAI: Seat = { family: "openai", models: ["codex-gpt-6-astra", "codex-gpt-5.6-sol"] };
const OPEN_WEIGHTS: Seat = { family: "open-weights", models: ["antigravity-gpt-oss"] };

// The state as Core.listModels() reports it: every model of every provider,
// available or not, with the reason when it is not.
const state = (...entries: [string, boolean?, string?][]): ModelState[] =>
  entries.map(([name, available = true, reason]) => (reason === undefined ? { name, available } : { name, available, reason }));

const ALL_UP = state(
  ["claude-fable"], ["claude-opus"], ["claude-sonnet"],
  ["codex-gpt-6-astra"], ["codex-gpt-5.6-sol"],
  ["antigravity-gpt-oss"],
);

describe("seat", () => {
  it("takes the first model of each chain when the whole state is up", () => {
    const r = seat([ANTHROPIC, OPENAI, OPEN_WEIGHTS], ALL_UP);
    expect(r.members).toEqual([
      { seat: ANTHROPIC, model: "claude-fable" },
      { seat: OPENAI, model: "codex-gpt-6-astra" },
      { seat: OPEN_WEIGHTS, model: "antigravity-gpt-oss" },
    ]);
    expect(r.skipped).toEqual([]);
    expect(r.empty).toEqual([]);
  });

  it("skips a paused first choice and records the reason the state gave", () => {
    const r = seat([ANTHROPIC], state(
      ["claude-fable", false, "rate_limited"], ["claude-opus"], ["claude-sonnet"],
    ));
    expect(r.members).toEqual([{ seat: ANTHROPIC, model: "claude-opus" }]);
    expect(r.skipped).toEqual([{ seat: ANTHROPIC, model: "claude-fable", reason: "rate_limited" }]);
    expect(r.empty).toEqual([]);
  });

  it("walks past every unavailable model and records each skip in chain order", () => {
    const r = seat([ANTHROPIC], state(
      ["claude-fable", false, "rate_limited"], ["claude-opus", false, "auth_expired"], ["claude-sonnet"],
    ));
    expect(r.members).toEqual([{ seat: ANTHROPIC, model: "claude-sonnet" }]);
    expect(r.skipped.map((s) => [s.model, s.reason])).toEqual([
      ["claude-fable", "rate_limited"],
      ["claude-opus", "auth_expired"],
    ]);
  });

  it("leaves a seat whose whole chain is down empty, which is not an error", () => {
    const r = seat([ANTHROPIC, OPEN_WEIGHTS], state(
      ["claude-fable", false, "rate_limited"], ["claude-opus", false, "rate_limited"], ["claude-sonnet", false, "unhealthy"],
      ["antigravity-gpt-oss"],
    ));
    expect(r.members).toEqual([{ seat: OPEN_WEIGHTS, model: "antigravity-gpt-oss" }]);
    expect(r.empty).toEqual([ANTHROPIC]);
    expect(r.skipped).toHaveLength(3);
  });

  it("skips a model the state does not mention at all, rather than seating it blind", () => {
    const r = seat([OPEN_WEIGHTS], state(["claude-opus"]));
    expect(r.members).toEqual([]);
    expect(r.empty).toEqual([OPEN_WEIGHTS]);
    expect(r.skipped).toEqual([{ seat: OPEN_WEIGHTS, model: "antigravity-gpt-oss", reason: "unknown_model" }]);
  });

  it("records a reason even when the state gives none", () => {
    const r = seat([OPEN_WEIGHTS], state(["antigravity-gpt-oss", false]));
    expect(r.skipped).toEqual([{ seat: OPEN_WEIGHTS, model: "antigravity-gpt-oss", reason: "unavailable" }]);
  });

  it("returns no members for no seats", () => {
    expect(seat([], ALL_UP)).toEqual({ members: [], skipped: [], empty: [] });
  });
});

describe("nextInChain", () => {
  it("returns the model after the current one", () => {
    expect(nextInChain(ANTHROPIC, "claude-fable")).toBe("claude-opus");
    expect(nextInChain(ANTHROPIC, "claude-opus")).toBe("claude-sonnet");
  });

  it("returns null at the end of the chain, so a refusal cannot cascade", () => {
    expect(nextInChain(ANTHROPIC, "claude-sonnet")).toBeNull();
    expect(nextInChain(OPEN_WEIGHTS, "antigravity-gpt-oss")).toBeNull();
  });

  it("returns null for a model that is not in the chain", () => {
    expect(nextInChain(ANTHROPIC, "codex-gpt-5.6-sol")).toBeNull();
  });

  // The real case of 2026-09-21, one step later: Opus is paused, Fable refuses
  // mid-flight anyway, and the one retry the design allows must not be spent on
  // the model the gateway would refuse by itself — Sonnet was free.
  it("steps down to the first model the state reports available, not merely the next one", () => {
    expect(nextInChain(ANTHROPIC, "claude-fable", state(
      ["claude-fable", false, "rate_limited"], ["claude-opus", false, "rate_limited"], ["claude-sonnet"],
    ))).toBe("claude-sonnet");
  });

  it("returns null when the rest of the chain is unavailable, or unknown to the state", () => {
    expect(nextInChain(ANTHROPIC, "claude-fable", state(
      ["claude-opus", false, "rate_limited"], ["claude-sonnet", false, "unhealthy"],
    ))).toBeNull();
    // A model the state does not mention is skipped for the same reason seat()
    // skips it: the call would come back "unknown_model", and nothing retries.
    expect(nextInChain(ANTHROPIC, "claude-opus", state(["claude-opus"]))).toBeNull();
  });

  it("never steps back onto a repeated model, which is the one that just refused", () => {
    expect(nextInChain({ family: "x", models: ["a", "a", "b"] }, "a")).toBe("b");
  });
});

describe("labels", () => {
  const MEMBERS = [{ model: "claude-fable" }, { model: "codex-gpt-6-astra" }, { model: "antigravity-gemini-pro" }, { model: "antigravity-gpt-oss" }];
  const QUESTION = "What is the half-life of a design decision?";
  const asObject = (m: Map<string, string>): Record<string, string> => Object.fromEntries([...m].sort());

  it("gives every member one distinct label, from A upwards", () => {
    const m = labels(MEMBERS, QUESTION);
    expect(m.size).toBe(4);
    expect([...m.values()].sort()).toEqual(["Response A", "Response B", "Response C", "Response D"]);
    for (const { model } of MEMBERS) expect(m.get(model)).toMatch(/^Response [A-Z]$/);
  });

  it("pairs the same labels with the same models for the same question", () => {
    expect(asObject(labels(MEMBERS, QUESTION))).toEqual(asObject(labels(MEMBERS, QUESTION)));
  });

  it("does not depend on the order the members are seated in", () => {
    const reversed = [...MEMBERS].reverse();
    expect(asObject(labels(reversed, QUESTION))).toEqual(asObject(labels(MEMBERS, QUESTION)));
  });

  // §12.4 is not "the mapping changes sometimes", it is that a client cannot
  // learn one: a near-constant shuffle that moved for one question in twelve
  // would satisfy the old `size > 1` and leak the panel just the same. So the
  // assertion is on the spread. Four members have 24 permutations; over 200
  // fixed questions the implementation produces all 24 and lands each label on
  // each model about 50 times (25%, observed worst case 68). The bounds below
  // are loose around that, and deterministic — the questions are fixed — but a
  // seed that collapsed (one byte of the hash, or the question's length, which
  // these 200 questions take only three values of) falls far outside them.
  it("spreads the labels over the members when the question changes", () => {
    const QUESTIONS = 200;
    const mappings = new Set<string>();
    const seen = new Map<string, Map<string, number>>();
    for (let i = 0; i < QUESTIONS; i++) {
      const m = labels(MEMBERS, `question number ${i}`);
      mappings.add(JSON.stringify(asObject(m)));
      for (const [model, label] of m) {
        const counts = seen.get(model) ?? new Map<string, number>();
        counts.set(label, (counts.get(label) ?? 0) + 1);
        seen.set(model, counts);
      }
    }
    expect(mappings.size).toBeGreaterThanOrEqual(20);
    for (const { model } of MEMBERS) {
      const counts = seen.get(model);
      expect(counts?.size).toBe(4);
      expect(Math.max(...counts!.values())).toBeLessThanOrEqual(QUESTIONS * 0.4);
    }
  });

  // The base-26 carry is unreachable from any configuration — a 27-seat panel
  // is not a panel — but it is the one piece of arithmetic here that can be
  // wrong, so it is exercised rather than trusted.
  it("keeps the labels distinct past Z", () => {
    const many = Array.from({ length: 27 }, (_, i) => ({ model: `m${String(i).padStart(2, "0")}` }));
    const m = labels(many, QUESTION);
    expect(new Set(m.values()).size).toBe(27);
    expect([...m.values()]).toContain("Response Z");
    expect([...m.values()]).toContain("Response AA");
  });

  it("handles one member and none", () => {
    expect(asObject(labels([{ model: "claude-opus" }], QUESTION))).toEqual({ "claude-opus": "Response A" });
    expect(labels([], QUESTION).size).toBe(0);
  });
});
