import type { SpendRow } from "./store.js";

/** A model's list price: USD per million tokens, and per image for a model that makes them. */
export interface Price { input: number; output: number; cached_input?: number; image?: number }
/** The `prices` section of the configuration, as the admin API reads it. */
export interface Prices { verified?: string; subscriptions: Record<string, number>; models: Record<string, Price> }

const MTOK = 1_000_000;

/**
 * What the calls of one row would have cost through the vendor's API: a
 * comparison, never a bill, since the gateway runs on subscriptions.
 *
 * A call whose CLI reported its own cost is taken at that figure, which knows
 * the model that answered and every cache rate. The others are priced from the
 * list: cached input at its own rate when the price names one and at the input
 * rate when it does not, a cache write as plain input, which undercounts it
 * slightly. Rows written before cached tokens were kept carry none, so their
 * input is priced whole: the figure errs upwards, never down. Null when calls
 * remain that nothing can price.
 */
export function costOf(row: SpendRow, price: Price | undefined): number | null {
  if (row.reportedCalls === row.calls) return row.reportedCost;
  if (!price) return null;
  const u = row.unreported, cached = Math.min(u.cachedInputTokens, u.inputTokens);
  const tokens = ((u.inputTokens - cached) * price.input + cached * (price.cached_input ?? price.input) + u.outputTokens * price.output) / MTOK;
  return row.reportedCost + tokens + u.ok * (price.image ?? 0);
}
