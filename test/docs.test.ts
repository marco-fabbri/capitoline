import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

// The three adapters each count cached input the way their own CLI reports it,
// and each is right for that CLI (docs/spike-2026-09.md §10). Nothing in the
// code can express that the resulting numbers are not comparable across
// providers: the only thing that keeps a reader of /health or of the usage
// table from comparing them is the note in the documentation. So the note is
// pinned here, because otherwise its deletion would break nothing and be
// noticed by no one.
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
  it("is in docs/deploy.md, where /health and the usage table are described", () => {
    const s = section(readFileSync("docs/deploy.md", "utf8"), "## 9. ");
    expect(s).toMatch(/\/health/);
    expect(s).toMatch(/\/v1\/usage/);
    pinsTheConventions(s);
    // The measurement, not an assertion: the Antigravity half of it is proven.
    expect(s).toMatch(/spike-2026-09\.md` §10/);
  });

  it("is in the README, where the endpoints are shown", () => {
    const s = section(readFileSync("README.md", "utf8"), "## Use it");
    pinsTheConventions(s);
  });
});
