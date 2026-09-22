import { createHash } from "node:crypto";
import type { Seat } from "./types.js";

/**
 * A model as the gateway's own state reports it. This is the shape of the
 * fields `Core.listModels()` already returns, narrowed to the three the
 * seating needs, so the council can be handed that list directly without the
 * seating importing anything from `src/core`.
 */
export interface ModelState {
  name: string;
  available: boolean;
  /** Why not, in the state's own words: `rate_limited`, `auth_expired`, `unhealthy`, … */
  reason?: string;
}

/**
 * The outcome of seating a panel: who sits, which models were walked past and
 * why, and which seats found nobody at all. `skipped` and `empty` are not
 * errors — they are what the response has to declare (design §12.5, §12.6).
 */
export interface Seated {
  members: { seat: Seat; model: string }[];
  skipped: { seat: Seat; model: string; reason: string }[];
  /** A seat whose whole chain is unavailable. The deliberation continues without it. */
  empty: Seat[];
}

/** What a skip is recorded as when the state says "unavailable" and nothing more. */
const UNAVAILABLE = "unavailable";
/**
 * A chain model that the state does not mention at all. The configuration
 * schema refuses a seat naming a model no provider declares, so this can only
 * come from a host overlay that dropped a model after the file was validated.
 * It is treated as a skip rather than seated blind: seating it would spend a
 * call to be answered `unknown_model`, which no fallback retries.
 */
const UNKNOWN = "unknown_model";

/**
 * Seat each panel in one pass over its chain, best model first (design §12.2,
 * "before the call"). This is the cheap half of the two-step seating: a model
 * the state already knows to be paused costs nothing to skip, while the other
 * half — one step down after an unforeseen refusal — is `nextInChain()` and
 * belongs to the engine, which is the only thing that sees a refusal.
 */
export function seat(seats: Seat[], state: ModelState[]): Seated {
  const byName = new Map(state.map((m) => [m.name, m]));
  const out: Seated = { members: [], skipped: [], empty: [] };
  for (const s of seats) {
    let taken: string | null = null;
    for (const model of s.models) {
      const m = byName.get(model);
      if (m?.available === true) { taken = model; break; }
      out.skipped.push({ seat: s, model, reason: m === undefined ? UNKNOWN : m.reason ?? UNAVAILABLE });
    }
    if (taken === null) out.empty.push(s);
    else out.members.push({ seat: s, model: taken });
  }
  return out;
}

/**
 * The model after `current` in this seat's chain, or null when there is none.
 * One step, never a loop: the first refusal of a quota window is by definition
 * not in the health state yet, so a seat must be able to step down once
 * mid-flight; letting it walk the whole chain would turn one turned-over quota
 * into three more refused calls and a deliberation far past its deadline.
 *
 * A `current` that is not in the chain also returns null. It cannot happen
 * with a member this module seated, and the alternative — starting from the
 * head of the chain — would retry a model that may have just refused.
 */
export function nextInChain(seat: Seat, current: string): string | null {
  const i = seat.models.indexOf(current);
  return i < 0 || i + 1 >= seat.models.length ? null : seat.models[i + 1];
}

/** "Response A" … "Response Z", then "Response AA": more than 26 seats is not a panel, but the labels must stay distinct whatever the configuration says. */
function labelOf(i: number): string {
  let n = i, name = "";
  do { name = String.fromCharCode(65 + (n % 26)) + name; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return `Response ${name}`;
}

/**
 * mulberry32: a 32-bit seeded generator, four lines and no dependency. The
 * quality demanded here is low (a shuffle of four items) but the determinism
 * is absolute — `Math.random()` would make a strange deliberation impossible
 * to reproduce, which is the whole point of §12.4.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The label each member's answer is shown under in the ranking stage, by
 * model name. The mapping never enters a prompt as anything but the label; it
 * reaches the client afterwards, in the response (design §12.4).
 *
 * Two properties make a deliberation reproducible, and both are deliberate:
 *
 * - The seed is a hash of the question alone, so asking the same question
 *   again pairs the same labels with the same models. A different question
 *   almost always reshuffles them, which is what stops a client from learning
 *   that "Response A is always the Anthropic seat".
 * - The models are sorted before being shuffled, so the mapping depends on
 *   *which* models are seated and not on the order they happened to be seated
 *   in. Without this, a fallback that reordered the members — or simply a
 *   different completion order — would relabel the same panel on the same
 *   question and make two runs incomparable.
 */
export function labels(members: { model: string }[], question: string): Map<string, string> {
  const models = members.map((m) => m.model).sort();
  const next = rng(createHash("sha256").update(question, "utf8").digest().readUInt32BE(0));
  for (let i = models.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [models[i], models[j]] = [models[j], models[i]];
  }
  return new Map(models.map((model, i) => [model, labelOf(i)]));
}
