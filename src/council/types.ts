/**
 * The council's own types. Deliberately free of imports: the configuration
 * schema in src/config.ts produces a `CouncilConfig`, so anything this module
 * pulled in would be pulled in by the configuration loader too.
 */

/**
 * A seat is a family and an ordered fallback chain, never a single model.
 * Quotas run out one model at a time (on 2026-09-21 Fable was refused while
 * the same subscription answered on Opus), and a panel needs independent
 * judgment, which one seat per family is what buys: design §12.2.
 */
export interface Seat {
  family: string;
  /** The chain, best first; the first model the state reports available is seated. */
  models: string[];
}

/** A member of a running deliberation: which seat, which model of its chain, and
 * the label the ranking stage knows it by. The label is assigned once the panel
 * is known — before the ranking, and before the judge in a council that runs no
 * ranking — and never appears in a prompt as anything but "Response X" (§12.4). */
export interface SeatedMember {
  seat: Seat;
  model: string;
  label: string;
}

/**
 * One configured council, as the code reads it. The YAML is snake_case,
 * because an operator writes it next to the rest of `config/capitoline.yaml`;
 * the schema renames the four scalars on the way in, so the code never carries
 * two spellings of the same setting.
 */
export interface CouncilConfig {
  seats: Seat[];
  judge: Seat;
  /** false: the judge is seated apart from the members, so no synthesizer weighs its own answer. */
  judgeAllowMember: boolean;
  /** true: the judge sees the labels, not the real model names. The un-blinded detail reaches the client instead. */
  judgeBlind: boolean;
  /** Fewer answers than this and no ranking happens at all; never below 2. */
  minMembers: number;
  /**
   * false: stage 2 does not run at all — the judge synthesises the answers
   * with no aggregate, and the deliberation costs one call per seat plus the
   * synthesis instead of two plus one (the `-fast` shape). `minMembers` keeps
   * its meaning: below it there is still nothing to synthesize.
   */
  ranking: boolean;
  /** Per member, per stage. A member that overruns loses its seat, the deliberation continues. */
  stageTimeoutS: number;
}

/**
 * One member's vote on one labelled answer. `rank` starts at 1 and ties are
 * allowed, so three members can be ranked 1, 1, 2; `reason` is the member's
 * own words and reaches the client with the rest of the detail (§12.6). Only
 * ever built by `parseRanking()`, which refuses anything it cannot trust.
 */
export interface Ranking {
  label: string;
  rank: number;
  reason: string;
}

/**
 * The panel's verdict on one label, once every surviving ranking is counted.
 *
 * `averageRank` is 0 — never a valid rank, which starts at 1 — when `votes` is
 * 0, and means "nobody ranked this answer", not "ranked first". A number is
 * used rather than null or Infinity because this crosses the wire inside the
 * `capitoline` field of an ordinary JSON response, where `Infinity` serialises
 * to null anyway and a nullable field would force every reader to handle two
 * shapes. It happens when a member's ranking could not be parsed and the label
 * belongs to a member nobody else ranked, or when no ranking survived at all.
 */
export interface Aggregate {
  label: string;
  averageRank: number;
  votes: number;
}

/**
 * One member as the client is told about it, after the fact and un-blinded
 * (§12.6): the seat's family, the model that actually answered, the label its
 * answer was ranked under and the answer itself.
 *
 * `fellBackFrom` lists the models of the chain the seat walked past to get
 * here, in the order it walked them, each with the reason it was walked past —
 * `"claude-fable (rate_limited)"`. Both halves of the two-step seating land in
 * it: the models the state already reported unavailable before the call, and
 * the one model a mid-flight refusal stepped down from. It is absent, not
 * empty, when the seat took the first model of its chain, so the common case
 * costs nothing in the response.
 */
export interface DeliberationMember {
  family: string;
  model: string;
  label: string;
  answer: string;
  fellBackFrom?: string[];
}

/**
 * A seat that produced no answer, declared rather than hidden (§12.5). `model`
 * is the last model the seat tried and is absent when it never called one,
 * which is the case of a seat whose whole chain the state already reported
 * unavailable.
 *
 * `reason` is a classification and never a provider's own words: the
 * `FailureKind` the last call ended with, or — for a seat nothing could be
 * seated in — what the state said about each model of its chain. The CLI's
 * `detail` (up to two thousand characters of stderr) stays in the log, because
 * this object travels to the client inside the `capitoline` field of an
 * ordinary response, and provider detail never reaches a client.
 *
 * `fellBackFrom` is the same list a surviving member carries, in the same
 * format, for a seat that walked part of its chain and died anyway: without it
 * a seat that stepped down and was then lost would report the last model
 * alone, and the operator would read one model down where two fell (§12.6).
 */
export interface LostSeat {
  family: string;
  model?: string;
  reason: string;
  fellBackFrom?: string[];
}

/** One member's vote, under the model that cast it. The deliberation reaches the client un-blinded, so the voter is named by model; its label is in `members`. */
export interface MemberRanking {
  by: string;
  ranking: Ranking[];
}

/**
 * Everything the council did, which is what the `capitoline` field of the
 * response carries (§12.6). It is the un-blinded record of a blind
 * deliberation: the labels the members ranked under sit next to the real model
 * names, after the fact, where no prompt can reach them.
 *
 * `deliberationId` is what §12.7 asks for: the nine calls are nine rows under
 * the real models that served them, and this is the only thing that ties them
 * back together, so the cost of one question can be summed instead of guessed
 * from a time window. It is minted per run and written to every usage row the
 * deliberation causes.
 *
 * `judge.model` is the empty string when nothing was synthesised: the case of
 * §12.5, where a single surviving answer is returned as it is, and the case of
 * a judge chain with no model left, where the best-ranked answer is returned
 * instead of throwing away eight calls that already answered.
 *
 * `calls` counts every call the deliberation attempted, retries included: nine
 * for the default panel of four seats, five for the same panel without the
 * ranking stage. A call the gateway refuses at its own gates — a standing
 * pause, a model the state has already taken down — spends no provider call
 * and writes no usage row, so `calls` is an upper bound on the rows of §12.7
 * and not an identity.
 */
export interface Deliberation {
  deliberationId: string;
  strategyVersion: number;
  /**
   * How the council deliberated: `"ranked"` for the three stages of §12.1,
   * `"fast"` for a council configured with `ranking: false`, which skips the
   * peer ranking.
   *
   * It is stated rather than inferred because `rankings` and `aggregate` are
   * both empty in two quite different deliberations: the fast one, where the
   * stage never ran, and a full panel where every ranking failed or could not
   * be parsed (§12.5) — the second is a degraded run worth an operator's
   * attention, the first is what was asked for. The name is the shape word of
   * the model name (§12.8), so a response says which `capitoline-*` behaviour
   * produced it even when the request has been forgotten.
   */
  shape: "ranked" | "fast";
  members: DeliberationMember[];
  lost: LostSeat[];
  rankings: MemberRanking[];
  aggregate: Aggregate[];
  judge: { model: string; blind: boolean };
  calls: number;
}
