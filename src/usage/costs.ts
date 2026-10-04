import type { SpendRow } from "./store.js";

/** A model's list price: USD per million tokens, and per image for a model that makes them. */
export interface Price { input: number; output: number; cached_input?: number; image?: number }
/** The `prices` section of the configuration, as the admin API reads it. */
export interface Prices { verified?: string; subscriptions: Record<string, number>; models: Record<string, Price> }

/**
 * What the subscriptions cost a month, in the currency they are paid in, and
 * what one unit of it is worth in USD, the currency of every list price. The
 * rate is the operator's own figure: the gateway asks nobody for it.
 */
export interface Subscriptions { currency: string; usdPerUnit: number; monthly: Record<string, number> }
export const SUBSCRIPTIONS_KEY = "subscriptions";

/** Null when `v` is not a well-formed Subscriptions, or names a provider outside `providers`. */
export function parseSubscriptions(v: unknown, providers?: string[]): Subscriptions | null {
  if (typeof v !== "object" || v === null) return null;
  const { currency, usdPerUnit, monthly } = v as Record<string, unknown>;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return null;
  if (typeof usdPerUnit !== "number" || !Number.isFinite(usdPerUnit) || usdPerUnit <= 0) return null;
  if (typeof monthly !== "object" || monthly === null || Array.isArray(monthly)) return null;
  for (const [id, n] of Object.entries(monthly)) {
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
    if (providers && !providers.includes(id)) return null;
  }
  return { currency, usdPerUnit, monthly: monthly as Record<string, number> };
}

const MTOK = 1_000_000;

/**
 * What the calls of one row would have cost through the vendor's API: a
 * comparison, never a bill, since the gateway runs on subscriptions.
 *
 * A call whose CLI reported its own cost is taken at that figure, which knows
 * the model that answered and every cache rate. The others are priced from the
 * list: cached input at its own rate when the price names one and at the input
 * rate when it does not, a cache write as plain input. Rows written before
 * cached tokens were kept carry none, so their input is priced whole. The two
 * pull opposite ways — a cached read costs a fraction of the input rate, a
 * cache write up to twice it — so the list figure is an estimate that can
 * miss on either side: a short Claude Code call whose prompt was written to
 * cache was reported at about twice what the list gives (2026-10-04). Null
 * when calls remain that nothing can price.
 */
export function costOf(row: SpendRow, price: Price | undefined): number | null {
  if (row.reportedCalls === row.calls) return row.reportedCost;
  if (!price) return null;
  const u = row.unreported, cached = Math.min(u.cachedInputTokens, u.inputTokens);
  const tokens = ((u.inputTokens - cached) * price.input + cached * (price.cached_input ?? price.input) + u.outputTokens * price.output) / MTOK;
  return row.reportedCost + tokens + u.ok * (price.image ?? 0);
}
