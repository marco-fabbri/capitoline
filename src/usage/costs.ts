import type { SpendRow } from "./store.js";

/** A model's list price: USD per million tokens, and per image for a model that makes them. */
export interface Price { input: number; output: number; cached_input?: number; image?: number }
/** The `prices` section of the configuration, as the admin API reads it. */
export interface Prices { verified?: string; subscriptions: Record<string, number>; models: Record<string, Price> }

const MTOK = 1_000_000;

/**
 * What the calls of one row would have cost through the vendor's API at list
 * price: a comparison, never a bill, since the gateway runs on subscriptions.
 * Cached input is charged at its own rate when the price names one and at the
 * input rate when it does not; a cache write is charged as plain input, which
 * undercounts it slightly. Rows written before cached tokens were kept carry
 * none, so their input is priced whole: the figure errs upwards, never down.
 */
export function costOf(row: SpendRow, price: Price | undefined): number | null {
  if (!price) return null;
  const cached = Math.min(row.cachedInputTokens, row.inputTokens);
  const tokens = ((row.inputTokens - cached) * price.input + cached * (price.cached_input ?? price.input) + row.outputTokens * price.output) / MTOK;
  return tokens + row.ok * (price.image ?? 0);
}
