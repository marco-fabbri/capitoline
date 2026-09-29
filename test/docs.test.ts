import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

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

// The shipped councils are a configuration change and nothing else: another
// one is six lines of YAML, and nothing in the code would
// notice that it never reached the README, the runbook or the spec. What each
// council costs is the number a reader decides on, and it is derivable from
// the file — one call per seat, one more per seat when the ranking stage runs,
// one for the judge — so the documentation is checked against the file rather
// than against a number somebody typed once.
const CONFIG = loadConfig("config/capitoline.yaml");
const COUNCILS = Object.entries(CONFIG.council);

const price = (c: (typeof COUNCILS)[number][1]): number => c.seats.length * (c.ranking ? 2 : 1) + 1;

// How many seats of one council a provider serves, counted as src/config.ts
// counts them for the concurrency rule: a chain spanning two providers needs
// the slot in both, and the judge is not a seat.
const seatsOn = (provider: string, c: (typeof COUNCILS)[number][1]): number =>
  c.seats.filter((s) => s.models.some((m) => CONFIG.providers[provider]?.models[m] !== undefined)).length;

// A markdown table of councils: the rows keyed by the model name in the first
// cell, with the `Calls` column read off the header rather than by position,
// so the table can gain a column without the test moving.
const councilTable = (text: string, where: string): Map<string, string> => {
  const lines = text.split("\n");
  const head = lines.findIndex((l) => l.startsWith("|") && /\bCalls\b/.test(l));
  expect(head, `no council table with a Calls column in ${where}`).toBeGreaterThanOrEqual(0);
  const cells = (l: string): string[] => l.split("|").slice(1, -1).map((c) => c.trim());
  const calls = cells(lines[head]).findIndex((c) => /\bCalls\b/.test(c));
  const rows = new Map<string, string>();
  for (const line of lines.slice(head + 2)) {
    if (!line.startsWith("|")) break;
    const row = cells(line);
    rows.set(row[0].replaceAll("`", ""), row[calls]);
  }
  return rows;
};

// The explanation of one configuration key, out of the `| Key |` tables of
// §7. There are several of them in that section, so the table is chosen by
// the key it documents rather than by position. The council table documents
// both blocks at once, so a row that states only the reference panel's
// reading is a row that is false for a variant.
const keyRow = (text: string, where: string, key: string): string => {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^\|\s*Key\s*\|/.test(lines[i])) continue;
    for (const line of lines.slice(i + 2)) {
      if (!line.startsWith("|")) break;
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      if (cells[0].replaceAll("`", "") === key) return cells[1];
    }
  }
  expect.fail(`no \`${key}\` row in any key table of ${where}`);
};

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

describe("the shipped councils, as documented", () => {
  it("are all in the README with their price in calls", () => {
    const rows = councilTable(section(readFileSync("README.md", "utf8"), "## Use it"), "the README");
    expect([...rows.keys()].sort()).toEqual(COUNCILS.map(([n]) => n).sort());
    for (const [name, c] of COUNCILS) expect(rows.get(name), `${name}: calls`).toBe(String(price(c)));
  });

  it("are all in the runbook with their price in calls, docs/deploy.md §7", () => {
    const rows = councilTable(section(readFileSync("docs/deploy.md", "utf8"), "## 7. "), "docs/deploy.md §7");
    expect([...rows.keys()].sort()).toEqual(COUNCILS.map(([n]) => n).sort());
    for (const [name, c] of COUNCILS) expect(rows.get(name), `${name}: calls`).toBe(String(price(c)));
  });

  // A line that has gone stale before: it read `2` while the file said `3`,
  // the day a three-rung ladder was shipped, and a runbook that contradicts
  // the file it documents is worse than one that says nothing. The value and the
  // council that justifies it are both read out of the configuration here.
  it("say why the Antigravity subscription runs the number of processes it runs", () => {
    const s = section(readFileSync("docs/deploy.md", "utf8"), "## 7. ");
    const slots = /`providers\.antigravity\.concurrency` is `(\d+)`/.exec(s);
    expect(slots, "the runbook no longer states the Antigravity concurrency").not.toBeNull();
    expect(Number(slots![1])).toBe(CONFIG.providers.antigravity.concurrency);
    // The rule is per council, over the largest council the provider sits in,
    // so the paragraph has to name that council and not another.
    const largest = COUNCILS.reduce((a, b) => (seatsOn("antigravity", b[1]) > seatsOn("antigravity", a[1]) ? b : a));
    const paragraph = s.slice(slots!.index, s.indexOf("\n\n", slots!.index));
    // Backticked and bounded, not a bare substring: `capitoline` is a prefix
    // of the other two names, so a plain toMatch on the largest council's name
    // is satisfied by a paragraph that names only the other two — the exact
    // mistake this test exists to catch.
    const named = (n: string): RegExp => new RegExp("`" + n + "`");
    expect(paragraph, "the largest Antigravity council is not the one named").toMatch(named(largest[0]));
    expect(paragraph).toMatch(/largest/);
    // And every council the paragraph names is named with the number of
    // Antigravity seats it actually has — the first number word after its
    // name, which is where the prose states it — so no council other than the
    // largest can be presented as the largest.
    for (const [name, c] of COUNCILS) {
      const at = paragraph.search(named(name));
      if (at < 0) continue;
      const after = paragraph.slice(at, at + 80);
      const stated = new RegExp(`\\b(${WORDS.join("|")})\\b`).exec(after);
      const word = WORDS[seatsOn("antigravity", c)];
      expect(stated?.[1], `${name} seats ${word} chains on Antigravity, and the paragraph says otherwise`).toBe(word);
    }
  });

  // The §7 table documents both blocks with the reference panel's
  // values, so every row whose reading differs for a variant has to carry the
  // exception. The judge row is the one that went stale first: the ladder's
  // chain does not close on `claude-haiku`, it opens on it.
  it("name the last model of every judge chain that is not the reference panel's, docs/deploy.md §7", () => {
    const cell = keyRow(section(readFileSync("docs/deploy.md", "utf8"), "## 7. "), "docs/deploy.md §7", "judge");
    const reference = CONFIG.council.capitoline.judge.models.join(",");
    for (const [name, c] of COUNCILS) {
      if (c.judge.models.join(",") === reference) continue;
      const last = c.judge.models[c.judge.models.length - 1];
      expect(cell, `${name}: its judge chain ends on ${last}, which the row never names`).toMatch(new RegExp("`" + last + "`"));
    }
  });

  // Adding a council is the one configuration change that can make a provider
  // short of slots, and the check that says so runs before the restart.
  it("tell the runbook's reader to re-read the concurrency check when a council is added", () => {
    const s = section(readFileSync("docs/deploy.md", "utf8"), "## 7. ");
    const added = s.indexOf("Adding a council");
    expect(added, "the runbook does not say what adding a council costs").toBeGreaterThanOrEqual(0);
    const check = s.indexOf("npm run check-config", added);
    expect(check - added, "the check is not named where a council is added").toBeLessThan(900);
  });
});

describe("the spec, §12", () => {
  const s = section(readFileSync("docs/superpowers/specs/2026-09-19-capitoline-design.md", "utf8"), "## 12. ");

  it("carries the naming rule the three model names follow", () => {
    expect(s).toMatch(/shape word/);
    expect(s).toMatch(/family name/);
    expect(s).toMatch(/capitoline-2/);
  });

  it("carries the ranking flag and what turning it off costs", () => {
    expect(s).toMatch(/`ranking`/);
    expect(s).toMatch(/five calls/);
    expect(s).toMatch(/no aggregate|empty aggregate/);
  });

  // The two shapes that were considered and dropped. Their reasons are the
  // part that does not survive a conversation, and without them the next
  // reader proposes them again — both look cheap on paper.
  // §12.1 is where src/config.ts sends the operator who trips the slot check
  // ("(design §12.1)"), so a figure that contradicts the file sends them to
  // the one paragraph that is wrong. Pinned to the file exactly as the
  // runbook's is.
  it("states the Antigravity concurrency the shipped file states", () => {
    const slots = /`providers\.antigravity\.concurrency` is `(\d+)`/.exec(s);
    expect(slots, "the spec no longer states the Antigravity concurrency").not.toBeNull();
    expect(Number(slots![1])).toBe(CONFIG.providers.antigravity.concurrency);
  });

  it("says why the two dropped variants were dropped", () => {
    expect(s).toMatch(/cannot break a tie/);
    expect(s).toMatch(/one pair in three|deadlock/);
    expect(s).toMatch(/spare its quota|sparing its quota|spare the Anthropic/);
    expect(s).toMatch(/degrades to three/);
  });
});

describe("the backlog", () => {
  const backlog = readFileSync("docs/backlog.md", "utf8");

  it("has moved the fast council out of what is still to come", () => {
    expect(section(backlog, "## Shipped")).toMatch(/capitoline-fast/);
    expect(section(backlog, "## Shipped")).toMatch(/capitoline-gemini/);
    // The price it was guessed at before it was built.
    expect(backlog).not.toMatch(/three calls instead of nine/);
  });

  it("records the shape that would justify a strategy object", () => {
    expect(section(backlog, "## Phase 2 and beyond")).toMatch(/strategy object/);
  });

  // The two ladders it used to hold as still to come are closed, and not by
  // being built into the shipped file: they are a recipe now.
  it("closes the other ladders into the guide rather than leaving them open", () => {
    expect(section(backlog, "## Phase 2 and beyond")).not.toMatch(/capitoline-claude|capitoline-openai/);
    expect(section(backlog, "## Shipped")).toMatch(/docs\/measure-a-model\.md/);
    const guide = readFileSync("docs/measure-a-model.md", "utf8");
    for (const name of ["capitoline-gemini", "capitoline-claude", "capitoline-openai"]) expect(guide).toMatch(new RegExp("  " + name + ":"));
  });
});

// The four conditions are stated twice: once where they are argued
// (docs/terms-of-service.md) and once where an application's author checks
// their own path against them (docs/connecting-an-application.md §5). A condition reworded in
// one and not the other would leave the two documents drawing different
// lines, so they are compared word for word.
describe("the four conditions", () => {
  const numbered = (text: string): string[] =>
    text.split("\n").filter((l) => /^[1-4]\. /.test(l)).map((l) => l.replace(/^[1-4]\. /, "").replace(/\*\*/g, ""));
  it("are the same four in the terms document and in the client guide", () => {
    const tos = readFileSync("docs/terms-of-service.md", "utf8");
    const argued = section(tos, "### The line, and four conditions");
    // In the terms document each condition is a bold heading followed by its
    // explanation; the heading is the condition.
    const conditions = numbered(argued).map((l) => l.split(/(?<=\.) /)[0]);
    const checked = numbered(section(readFileSync("docs/connecting-an-application.md", "utf8"), "## 5. "));
    expect(conditions).toHaveLength(4);
    expect(checked).toEqual(conditions);
  });
});

// The version a new host installs is written in three places: the
// configuration, which the Ansible playbook reads; the update guide's table,
// which says when each was verified; and the runbook's install line, for a
// host built by hand. A CLI update that changes one and not the others would
// install on the next host a version nobody verified.
describe("the verified CLI versions", () => {
  const NAMES: Record<string, string> = { claude: "Claude Code (`claude`)", codex: "Codex CLI (`codex`)", antigravity: "Antigravity CLI (`agy`)" };
  const PACKAGES: Record<string, string> = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex" };

  it("are the newest row of each CLI in docs/update-clis.md", () => {
    const rows = section(readFileSync("docs/update-clis.md", "utf8"), "## Versions in use").split("\n")
      .filter((l) => l.startsWith("| ") && !l.startsWith("| CLI"))
      .map((l) => l.split("|").map((c) => c.trim()));
    for (const [id, name] of Object.entries(NAMES)) {
      const newest = rows.filter((r) => r[1] === name).at(-1);
      expect(newest, `no row for ${name}`).toBeDefined();
      expect(CONFIG.providers[id].version?.verified, `providers.${id}.version.verified`).toBe(newest![2]);
    }
  });

  it("are what docs/deploy.md §4 installs", () => {
    const line = /npm install -g (.+)/.exec(section(readFileSync("docs/deploy.md", "utf8"), "## 4. "))?.[1] ?? "";
    for (const [id, pkg] of Object.entries(PACKAGES)) {
      expect(line, `docs/deploy.md §4 installs ${pkg}`).toContain(`${pkg}@${CONFIG.providers[id].version?.verified}`);
    }
  });
});
