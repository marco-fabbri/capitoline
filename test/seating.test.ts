import { describe, it, expect } from "vitest";
import { seat, nextInChain, labels, type ModelState, type Seated } from "../src/council/seating.js";
import type { Seat } from "../src/council/types.js";
import type { ModelInfo } from "../src/core/core.js";

// Compile-time only, erased at runtime: what Core.listModels() returns must be
// what seat() takes, or the engine would have to translate the state on the
// way in and the two shapes could drift apart unnoticed.
export const _stateComesFromCore = (models: ModelInfo[]): Seated => seat([], models);

// The four default seats of config/capitoline.yaml, shortened: what matters
// here is a chain with a fallback, a chain of one, and two seats of different
// families.
const ANTHROPIC: Seat = { family: "anthropic", models: ["claude-fable", "claude-opus", "claude-sonnet"] };
const OPENAI: Seat = { family: "openai", models: ["codex-gpt-6-astra", "codex-gpt-5.6-sol"] };
const OPEN_WEIGHTS: Seat = { family: "open-weights", models: ["agy-gpt-oss"] };

// The state as Core.listModels() reports it: every model of every provider,
// available or not, with the reason when it is not.
const state = (...entries: [string, boolean?, string?][]): ModelState[] =>
  entries.map(([name, available = true, reason]) => (reason === undefined ? { name, available } : { name, available, reason }));

const ALL_UP = state(
  ["claude-fable"], ["claude-opus"], ["claude-sonnet"],
  ["codex-gpt-6-astra"], ["codex-gpt-5.6-sol"],
  ["agy-gpt-oss"],
);

describe("seat", () => {
  it("takes the first model of each chain when the whole state is up", () => {
    const r = seat([ANTHROPIC, OPENAI, OPEN_WEIGHTS], ALL_UP);
    expect(r.members).toEqual([
      { seat: ANTHROPIC, model: "claude-fable" },
      { seat: OPENAI, model: "codex-gpt-6-astra" },
      { seat: OPEN_WEIGHTS, model: "agy-gpt-oss" },
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
      ["agy-gpt-oss"],
    ));
    expect(r.members).toEqual([{ seat: OPEN_WEIGHTS, model: "agy-gpt-oss" }]);
    expect(r.empty).toEqual([ANTHROPIC]);
    expect(r.skipped).toHaveLength(3);
  });

  it("skips a model the state does not mention at all, rather than seating it blind", () => {
    const r = seat([OPEN_WEIGHTS], state(["claude-opus"]));
    expect(r.members).toEqual([]);
    expect(r.empty).toEqual([OPEN_WEIGHTS]);
    expect(r.skipped).toEqual([{ seat: OPEN_WEIGHTS, model: "agy-gpt-oss", reason: "unknown_model" }]);
  });

  it("records a reason even when the state gives none", () => {
    const r = seat([OPEN_WEIGHTS], state(["agy-gpt-oss", false]));
    expect(r.skipped).toEqual([{ seat: OPEN_WEIGHTS, model: "agy-gpt-oss", reason: "unavailable" }]);
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
    expect(nextInChain(OPEN_WEIGHTS, "agy-gpt-oss")).toBeNull();
  });

  it("returns null for a model that is not in the chain", () => {
    expect(nextInChain(ANTHROPIC, "codex-gpt-5.6-sol")).toBeNull();
  });
});

describe("labels", () => {
  const MEMBERS = [{ model: "claude-fable" }, { model: "codex-gpt-6-astra" }, { model: "agy-gemini-pro" }, { model: "agy-gpt-oss" }];
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

  it("generally pairs different labels with a different question", () => {
    const mappings = new Set<string>();
    for (let i = 0; i < 12; i++) mappings.add(JSON.stringify(asObject(labels(MEMBERS, `question number ${i}`))));
    expect(mappings.size).toBeGreaterThan(1);
  });

  it("handles one member and none", () => {
    expect(asObject(labels([{ model: "claude-opus" }], QUESTION))).toEqual({ "claude-opus": "Response A" });
    expect(labels([], QUESTION).size).toBe(0);
  });
});
