import { describe, it, expect } from "vitest";
import { parseRanking, aggregate } from "../src/council/ranking.js";
import type { Ranking, Aggregate } from "../src/council/ranking.js";
import { STRATEGY_VERSION, RANKING_SCHEMA, answerPrompt, rankingPrompt, synthesisPrompt } from "../src/council/prompts.js";

const LABELS = ["Response A", "Response B", "Response C"];

// A well-formed reply, as the prompt asks for it.
const CLEAN = JSON.stringify([
  { label: "Response A", rank: 2, reason: "solid but thin on the trade-offs" },
  { label: "Response B", rank: 1, reason: "the only one that answers the question asked" },
  { label: "Response C", rank: 3, reason: "wrong about the failure mode" },
]);

describe("parseRanking", () => {
  it("reads a clean JSON array and sorts it best first", () => {
    expect(parseRanking(CLEAN, LABELS)).toEqual([
      { label: "Response B", rank: 1, reason: "the only one that answers the question asked" },
      { label: "Response A", rank: 2, reason: "solid but thin on the trade-offs" },
      { label: "Response C", rank: 3, reason: "wrong about the failure mode" },
    ]);
  });

  it("tolerates a ```json fence", () => {
    const fenced = "```json\n" + CLEAN + "\n```";
    expect(parseRanking(fenced, LABELS).map((r) => r.label)).toEqual(["Response B", "Response A", "Response C"]);
  });

  it("tolerates a bare fence and prose around the JSON", () => {
    const messy = "Here is my ranking:\n```\n" + CLEAN + "\n```\nHappy to explain further.";
    expect(parseRanking(messy, LABELS)).toHaveLength(3);
    expect(parseRanking("Sure — " + CLEAN, LABELS)).toHaveLength(3);
  });

  it("accepts the array wrapped in an object", () => {
    for (const key of ["ranking", "rankings", "results"]) {
      const wrapped = `{"${key}": ${CLEAN}}`;
      expect(parseRanking(wrapped, LABELS).map((r) => r.rank)).toEqual([1, 2, 3]);
    }
  });

  it("accepts ties, which the prompt allows", () => {
    const tied = JSON.stringify([
      { label: "Response A", rank: 1, reason: "a" },
      { label: "Response B", rank: 1, reason: "b" },
      { label: "Response C", rank: 2, reason: "c" },
    ]);
    expect(parseRanking(tied, LABELS).map((r) => r.rank)).toEqual([1, 1, 2]);
  });

  it("accepts a bare label letter and ignores case, which models produce constantly", () => {
    const bare = JSON.stringify([
      { label: "A", rank: 1, reason: "a" },
      { label: "response b", rank: 2, reason: "b" },
      { label: "Response C", rank: 3, reason: "c" },
    ]);
    expect(parseRanking(bare, LABELS).map((r) => r.label)).toEqual(["Response A", "Response B", "Response C"]);
  });

  it("defaults a missing reason to the empty string rather than rejecting the vote", () => {
    const noReason = JSON.stringify(LABELS.map((label, i) => ({ label, rank: i + 1 })));
    expect(parseRanking(noReason, LABELS).every((r) => r.reason === "")).toBe(true);
  });

  it("rejects a label that was not offered", () => {
    const unknown = JSON.stringify([
      ...LABELS.map((label, i) => ({ label, rank: i + 1, reason: "" })),
      { label: "Response D", rank: 4, reason: "" },
    ]);
    expect(() => parseRanking(unknown, LABELS)).toThrow(/Response D/);
  });

  it("rejects an entry with no label at all", () => {
    const missing = JSON.stringify([{ rank: 1, reason: "best" }, { label: "Response B", rank: 2 }, { label: "Response C", rank: 3 }]);
    expect(() => parseRanking(missing, LABELS)).toThrow(/label/i);
  });

  it("rejects a rank that is not a positive integer", () => {
    for (const rank of [0, -1, 1.5, "1", null, "first"]) {
      const bad = JSON.stringify([
        { label: "Response A", rank },
        { label: "Response B", rank: 2 },
        { label: "Response C", rank: 3 },
      ]);
      expect(() => parseRanking(bad, LABELS), `rank ${JSON.stringify(rank)}`).toThrow(/rank/i);
    }
  });

  it("rejects the same label ranked twice", () => {
    const twice = JSON.stringify([
      { label: "Response A", rank: 1 }, { label: "Response A", rank: 2 }, { label: "Response B", rank: 3 }, { label: "Response C", rank: 4 },
    ]);
    expect(() => parseRanking(twice, LABELS)).toThrow(/twice|duplicate/i);
  });

  it("rejects a ranking that leaves a label out", () => {
    const partial = JSON.stringify([{ label: "Response A", rank: 1 }, { label: "Response B", rank: 2 }]);
    expect(() => parseRanking(partial, LABELS)).toThrow(/Response C/);
  });

  it("rejects prose, an empty reply and a JSON scalar", () => {
    for (const text of ["", "   ", "I liked B best, then A, then C.", "42", '"Response A"', "[]", "{}"]) {
      expect(() => parseRanking(text, LABELS), JSON.stringify(text)).toThrow();
    }
  });
});

describe("aggregate", () => {
  const ranking = (...pairs: [string, number][]): Ranking[] => pairs.map(([label, rank]) => ({ label, rank, reason: "" }));

  it("averages the ranks each label received and counts the votes, best first", () => {
    const out = aggregate([
      ranking(["Response A", 1], ["Response B", 2], ["Response C", 3]),
      ranking(["Response A", 2], ["Response B", 1], ["Response C", 3]),
      ranking(["Response A", 1], ["Response B", 3], ["Response C", 2]),
    ]);
    expect(out).toEqual<Aggregate[]>([
      { label: "Response A", averageRank: 1.333, votes: 3 },
      { label: "Response B", averageRank: 2, votes: 3 },
      { label: "Response C", averageRank: 2.667, votes: 3 },
    ]);
  });

  it("averages a tie to the same number for both labels", () => {
    const out = aggregate([ranking(["Response A", 1], ["Response B", 1]), ranking(["Response A", 2], ["Response B", 2])]);
    expect(out.map((a) => a.averageRank)).toEqual([1.5, 1.5]);
    expect(out.map((a) => a.label)).toEqual(["Response A", "Response B"]);
  });

  it("puts a label nobody ranked last, with no votes and no rank", () => {
    const out = aggregate([ranking(["Response A", 2], ["Response B", 1])], ["Response A", "Response B", "Response C"]);
    expect(out).toEqual<Aggregate[]>([
      { label: "Response B", averageRank: 1, votes: 1 },
      { label: "Response A", averageRank: 2, votes: 1 },
      { label: "Response C", averageRank: 0, votes: 0 },
    ]);
  });

  it("reports every offered label with no votes when no ranking survived", () => {
    expect(aggregate([], LABELS)).toEqual<Aggregate[]>([
      { label: "Response A", averageRank: 0, votes: 0 },
      { label: "Response B", averageRank: 0, votes: 0 },
      { label: "Response C", averageRank: 0, votes: 0 },
    ]);
    expect(aggregate([])).toEqual([]);
  });

  it("breaks a tie on the average by the number of votes, then by label", () => {
    const out = aggregate([
      ranking(["Response A", 1], ["Response B", 1]),
      ranking(["Response B", 1]),
    ]);
    expect(out.map((a) => a.label)).toEqual(["Response B", "Response A"]);
    expect(out.map((a) => a.votes)).toEqual([2, 1]);
  });
});

describe("prompts", () => {
  const QUESTION = "Should the gateway retry a refused model?";
  const ANSWERS = [
    { label: "Response A", text: "Retry once, down the chain." },
    { label: "Response B", text: "Never retry: the quota is gone." },
    { label: "Response C", text: "It depends on the refusal." },
  ];
  const AGG: Aggregate[] = [
    { label: "Response B", averageRank: 1.5, votes: 2 },
    { label: "Response A", averageRank: 2, votes: 2 },
    { label: "Response C", averageRank: 0, votes: 0 },
  ];

  it("names a strategy version, because changing a prompt changes the model name", () => {
    expect(STRATEGY_VERSION).toBe(1);
    expect(Number.isInteger(STRATEGY_VERSION)).toBe(true);
  });

  it("asks the question and nothing about a council in the answer prompt", () => {
    const p = answerPrompt(QUESTION);
    expect(p).toContain(QUESTION);
    expect(p.toLowerCase()).not.toContain("council");
    expect(p.toLowerCase()).not.toContain("rank");
  });

  it("shows every answer under its label, states the schema and the member's own label", () => {
    const p = rankingPrompt(QUESTION, ANSWERS, "Response B");
    expect(p).toContain(QUESTION);
    for (const a of ANSWERS) { expect(p).toContain(a.label); expect(p).toContain(a.text); }
    expect(p).toContain(JSON.stringify(RANKING_SCHEMA, null, 2));
    expect(p).toMatch(/your own answer/i);
    expect(p).toContain("Response B");
    expect(p).toMatch(/\bJSON\b/);
    expect(p).toMatch(/\b1\b/);
    expect(p).toMatch(/tie/i);
  });

  it("asks for a ranking that its own parser accepts", () => {
    const p = rankingPrompt(QUESTION, ANSWERS, "Response A");
    expect(p).toContain("label");
    expect(p).toContain("rank");
    expect(p).toContain("reason");
    const reply = JSON.stringify(ANSWERS.map((a, i) => ({ label: a.label, rank: i + 1, reason: "because" })));
    expect(parseRanking(reply, ANSWERS.map((a) => a.label))).toHaveLength(3);
  });

  it("never names a model in the ranking prompt, whatever the seating was", () => {
    const p = rankingPrompt(QUESTION, ANSWERS, "Response B");
    for (const model of ["claude-opus", "codex-gpt-6-astra", "agy-gemini-pro", "agy-gpt-oss"]) expect(p).not.toContain(model);
  });

  it("gives the judge the answers, the aggregate order and an instruction to answer directly", () => {
    const p = synthesisPrompt(QUESTION, ANSWERS, AGG, true);
    expect(p).toContain(QUESTION);
    for (const a of ANSWERS) { expect(p).toContain(a.label); expect(p).toContain(a.text); }
    expect(p).toContain("1.5");
    expect(p.indexOf("Response B")).toBeLessThan(p.indexOf("Response C"));
    expect(p).toMatch(/not (?:name|mention|refer)/i);
  });

  it("keeps the judge blind by default: no model name reaches it even when the identities are known", () => {
    const identities = new Map([["Response A", "claude-opus"], ["Response B", "codex-gpt-6-astra"], ["Response C", "agy-gemini-pro"]]);
    const blind = synthesisPrompt(QUESTION, ANSWERS, AGG, true, identities);
    for (const model of identities.values()) expect(blind).not.toContain(model);
  });

  it("names the models to an un-blinded judge", () => {
    const identities = new Map([["Response A", "claude-opus"], ["Response B", "codex-gpt-6-astra"], ["Response C", "agy-gemini-pro"]]);
    const open = synthesisPrompt(QUESTION, ANSWERS, AGG, false, identities);
    for (const model of identities.values()) expect(open).toContain(model);
    expect(open).toContain("Response A");
  });

  it("falls back to the labels when an un-blinded judge has no identities to show", () => {
    const open = synthesisPrompt(QUESTION, ANSWERS, AGG, false);
    expect(open).toContain("Response A");
    expect(open).toContain(ANSWERS[0].text);
  });

  it("tells the judge which labels nobody ranked instead of showing them as rank zero", () => {
    const p = synthesisPrompt(QUESTION, ANSWERS, AGG, true);
    expect(p).not.toMatch(/Response C[^\n]*\b0(?:\.0+)?\b/);
  });
});
