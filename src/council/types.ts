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
 * the label the ranking stage knows it by. The label is assigned in stage 2 and
 * never appears in a prompt as anything but "Response X" (design §12.4). */
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
  /** Per member, per stage. A member that overruns loses its seat, the deliberation continues. */
  stageTimeoutS: number;
}
