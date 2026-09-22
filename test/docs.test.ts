import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

// The three adapters each count cached input the way their own CLI reports it,
// and each is right for that CLI (docs/spike-2026-09.md §10). Nothing in the
// code can express that the resulting numbers are not comparable across
// providers: the only thing that keeps a reader of the usage table from adding
// them up is the note in the documentation. So the note is pinned here,
// because otherwise its deletion would break nothing and be noticed by no one.
const section = (text: string, heading: string): string => {
  const start = text.indexOf(heading);
  expect(start, `heading not found: ${heading}`).toBeGreaterThanOrEqual(0);
  const level = heading.slice(0, heading.indexOf(" ") + 1);
  const next = text.indexOf(`\n${level}`, start + heading.length);
  return text.slice(start, next === -1 ? undefined : next);
};

// Each provider named next to what it does with its own numbers, so a reader
// who has only one of the three in front of them still knows which convention
// they are reading.
const pinsTheConventions = (s: string): void => {
  expect(s).toMatch(/OpenAI/);
  expect(s).toMatch(/Anthropic/);
  expect(s).toMatch(/Antigravity/);
  expect(s).toMatch(/not comparable/);
  expect(s).toMatch(/count calls, not tokens/);
};

describe("the note on what the token numbers mean", () => {
  // Section 9 is some ninety lines of runbook, so being inside it proves
  // nothing: what the note has to do is sit with the usage table it explains,
  // where the numbers are actually read. So the position is pinned too, by the
  // order of the two strings and by the distance between them — a note moved
  // to the top of the section, away from the table, has stopped doing its job.
  it("follows the usage table it explains, in docs/deploy.md §9", () => {
    const s = section(readFileSync("docs/deploy.md", "utf8"), "## 9. ");
    const example = s.indexOf("jq .callers");
    const note = s.indexOf("The `inputTokens` and `outputTokens` columns");
    expect(example, "the /v1/usage example is gone").toBeGreaterThanOrEqual(0);
    expect(note, "the note is gone, or no longer opens on the two columns").toBeGreaterThan(example);
    expect(note - example, "the note has drifted away from the table").toBeLessThan(600);
    const text = s.slice(note);
    pinsTheConventions(text);
    // The measurement, not an assertion: the Antigravity half of it is proven.
    expect(text).toMatch(/spike-2026-09\.md` §10/);
    // /health reports no token count, only the over-budget boolean computed
    // against that same provider's budget: saying where the numbers are not is
    // half of what this note is for.
    expect(text).toMatch(/overBudget/);
  });

  it("is in the README, where the endpoints are shown", () => {
    const s = section(readFileSync("README.md", "utf8"), "## Use it");
    pinsTheConventions(s);
  });
});
