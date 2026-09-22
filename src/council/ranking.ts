import type { Aggregate, Ranking } from "./types.js";

/**
 * The two types live in `types.ts`, which imports nothing, because the
 * `Deliberation` the engine reports is built there too and the configuration
 * loader already pulls that module in. They are re-exported here so a caller
 * that thinks in terms of "the ranking stage" can take both the functions and
 * their types from one module.
 */
export type { Aggregate, Ranking } from "./types.js";

/** A rank below this is not a rank. Ties are allowed, gaps are not forbidden; zero, negatives and fractions are. */
const FIRST_RANK = 1;

/** Where a wrapped array is looked for, in order. Models wrap the array about as often as they return it bare. */
const ARRAY_KEYS = ["ranking", "rankings", "results"];

/**
 * The reply as JSON, whatever the model wrapped it in.
 *
 * Three tolerances, and no more: a fenced block (```json or bare), a sentence
 * before or after the JSON, and an object around the array. They cost nothing
 * and cover what models actually do to an instruction to answer in JSON only.
 * Everything beyond them — a rank expressed in prose, a label the panel never
 * offered — is refused by the caller rather than guessed at: a ranking is a
 * vote, and a misread vote is worse than a missing one, because a member that
 * did not rank is simply skipped (§12.5) while a wrong rank silently changes
 * which answer the judge is told the panel preferred.
 */
function toJson(text: string): unknown {
  let body = text.trim();
  const fence = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```/.exec(body);
  if (fence !== null) body = fence[1].trim();
  try {
    return JSON.parse(body);
  } catch {
    // A sentence around the JSON: take the widest bracketed span and retry
    // once. The span is bounded by the outermost brackets of the same kind,
    // so a prose "]" outside them cannot truncate it.
    for (const [open, close] of [["[", "]"], ["{", "}"]]) {
      const from = body.indexOf(open), to = body.lastIndexOf(close);
      if (from >= 0 && to > from) {
        try { return JSON.parse(body.slice(from, to + 1)); } catch { /* fall through to the throw below */ }
      }
    }
    throw new Error("ranking reply is not JSON");
  }
}

/** The entries of the reply, from a bare array or from the one array an object wraps. */
function entriesOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    for (const key of ARRAY_KEYS) {
      const inner = record[key];
      if (Array.isArray(inner)) return inner;
    }
  }
  throw new Error("ranking reply is neither an array nor an object wrapping one");
}

/**
 * The offered label this text means, or null.
 *
 * Exact first, then case-insensitively, then the bare suffix: a member asked
 * to rank "Response A" answers `"A"` often enough that refusing it would
 * throw away good rankings over punctuation. The suffix match is taken only
 * when exactly one offered label ends with it, so nothing is ever resolved by
 * guessing between two candidates.
 */
function resolve(raw: string, labels: string[]): string | null {
  const text = raw.trim();
  if (labels.includes(text)) return text;
  const lower = text.toLowerCase();
  const insensitive = labels.filter((l) => l.toLowerCase() === lower);
  if (insensitive.length === 1) return insensitive[0];
  const suffix = labels.filter((l) => l.toLowerCase().endsWith(` ${lower}`));
  return suffix.length === 1 ? suffix[0] : null;
}

/**
 * One member's ranking, or a throw. The engine treats a throw as "this member
 * did not rank": its answer stays in the deliberation and the other members'
 * votes still decide the aggregate (§12.5). So the bar here is trust, not
 * salvage — a reply that is half-understood is refused whole.
 *
 * Refused: a reply that is not JSON, an entry with no usable label, a label
 * the panel never offered, a rank that is not a positive integer, the same
 * label ranked twice, and a ranking that leaves an offered label out. The last
 * one matters more than it looks: the member was shown every answer, including
 * its own, and a partial reply is either a model that stopped reading or one
 * that quietly dropped the answer it liked least, which is a vote against it
 * that would not be counted as one.
 */
export function parseRanking(text: string, labels: string[]): Ranking[] {
  if (labels.length === 0) throw new Error("parseRanking() needs at least one label");
  const entries = entriesOf(toJson(text));
  if (entries.length === 0) throw new Error("ranking reply is empty");
  const out: Ranking[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("ranking entry is not an object");
    const { label: rawLabel, rank, reason } = entry as Record<string, unknown>;
    if (typeof rawLabel !== "string" || rawLabel.trim() === "") throw new Error("ranking entry has no label");
    const label = resolve(rawLabel, labels);
    if (label === null) throw new Error(`ranking names "${rawLabel}", which was not offered`);
    if (seen.has(label)) throw new Error(`ranking votes on ${label} twice`);
    if (typeof rank !== "number" || !Number.isInteger(rank) || rank < FIRST_RANK) {
      throw new Error(`ranking gives ${label} the rank ${JSON.stringify(rank)}, which is not a positive integer`);
    }
    seen.add(label);
    out.push({ label, rank, reason: typeof reason === "string" ? reason : "" });
  }
  const missing = labels.filter((l) => !seen.has(l));
  if (missing.length > 0) throw new Error(`ranking leaves out ${missing.join(", ")}`);
  return out.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
}

/** Three decimals: enough to order 4/3 against 1.5, few enough that the client is not shown 1.3333333333333333. */
const round = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * The panel's verdict, best first.
 *
 * `labels` is optional and additive: without it the aggregate covers exactly
 * the labels somebody voted on, which is all the plan's signature promised.
 * With it — the engine always has the list — a label nobody ranked is still
 * reported, with `votes: 0`, instead of vanishing from the response. That case
 * is not hypothetical: when every ranking fails to parse the aggregate would
 * otherwise be empty and the judge would be told nothing about answers that do
 * exist, and the client's `capitoline` field would list a member whose label
 * appears nowhere in the aggregate.
 *
 * The order is: ranked labels by average, better first; a tie broken by the
 * number of votes, because an average over three votes says more than the same
 * average over one; then by label, so two runs of the same deliberation
 * present the same order. Unranked labels come last whatever their average
 * says, since 0 would otherwise sort them first.
 */
export function aggregate(rankings: Ranking[][], labels?: string[]): Aggregate[] {
  const totals = new Map<string, { sum: number; votes: number }>();
  for (const label of labels ?? []) totals.set(label, { sum: 0, votes: 0 });
  for (const ranking of rankings) {
    for (const { label, rank } of ranking) {
      const t = totals.get(label) ?? { sum: 0, votes: 0 };
      t.sum += rank;
      t.votes += 1;
      totals.set(label, t);
    }
  }
  const out: Aggregate[] = [...totals].map(([label, t]) => ({
    label,
    averageRank: t.votes === 0 ? 0 : round(t.sum / t.votes),
    votes: t.votes,
  }));
  return out.sort((a, b) => {
    if ((a.votes === 0) !== (b.votes === 0)) return a.votes === 0 ? 1 : -1;
    return a.averageRank - b.averageRank || b.votes - a.votes || a.label.localeCompare(b.label);
  });
}
