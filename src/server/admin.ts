import express, { type Request, type Response } from "express";
import type { Logger } from "../log.js";
import { CapitolineError } from "../core/types.js";
import type { ApiKeyInfo, DeliberationCall, DeliberationSummary, SpendRow, UsageDayRow } from "../usage/store.js";
import { costOf, parseSubscriptions, SUBSCRIPTIONS_KEY, type Prices, type Subscriptions } from "../usage/costs.js";
import type { ModelInfo, PauseInfo, ProviderState } from "../core/core.js";
import { callerOf } from "./access.js";

/** What the admin API needs from the store (src/usage/store.ts). */
export interface AdminStore {
  createKey(name: string, createdBy: string | null): { name: string; key: string; createdAt: number };
  listKeys(): ApiKeyInfo[];
  revokeKey(name: string): boolean;
  nameCaller(id: string, name: string): void;
  callerNames(): Record<string, string>;
}

/**
 * What the operator's views and actions need beyond keys and names (the
 * dashboard under /ui reads and does everything through these, and so can
 * curl). Reads, plus the few actions that are state and not configuration: a
 * pause lifted or installed, a check run now, a caller's kept conversations
 * removed. Nothing here writes the configuration file.
 */
export interface AdminOps {
  core: {
    pauses(): PauseInfo[];
    liftPause(provider: string, scope: string | null): boolean;
    holdBack(provider: string, model: string | undefined, forMs: number): PauseInfo;
    checkHealth(provider?: string): Promise<void>;
    checkCatalog(): Promise<void>;
    checkQuota(): Promise<void>;
    providerStates(): ProviderState[];
    listModels(): ModelInfo[];
  };
  usage: {
    usageByDay(sinceMs: number): UsageDayRow[];
    spend(sinceMs: number): SpendRow[];
    setting(key: string): unknown;
    setSetting(key: string, value: unknown): void;
    deliberations(limit: number): DeliberationSummary[];
    deliberationCalls(id: string): DeliberationCall[];
  };
  /** The `prices` section of the configuration; without it every cost is unknown. */
  prices?: Prices;
  /** Counts only: an operator never reads what a caller wrote. */
  conversations?: { summary(): { owner: string; threads: number; turns: number; bytes: number; lastUsedAt: number }[]; deleteOwner(owner: string): number };
  /** server.notify, when configured. */
  notify?: (message: string) => Promise<boolean>;
  /** The configuration in force, with what must not travel taken out. */
  config: () => unknown;
}

const DAY_MS = 86_400_000;
// A hand-made pause is for maintenance, not a way to retire a model: a week at most.
const MAX_HOLD_MINUTES = 7 * 24 * 60;

const FORBIDDEN = { error: { message: "this caller is not an administrator (server.access.admins)", type: "invalid_request_error", code: "forbidden" } };

/**
 * `/v1/admin`: the gateway's own keys and the names of its callers, for the
 * callers `server.access.admins` names — an email, a bound service token's
 * name, or a key's name, since all three reach `callerOf` the same way. Every
 * action is a log line with who did it. Nothing here touches the
 * configuration file, which stays the source of truth for everything else
 * (design §8.5): a key is state, not configuration, and so is a caller's
 * name.
 */
export function createAdminRouter(store: AdminStore, admins: string[], names: () => Record<string, string>, log: Logger, ops?: AdminOps): express.Router {
  const router = express.Router();
  const allowed = new Set(admins);
  router.use((req, res, next) => {
    // The caller as /v1/usage would show it: a service token reaches here as
    // its client id, and `admins` names it the way the operator knows it —
    // through the same binding, configured or made at run time. A raw id in
    // `admins` works too.
    const raw = callerOf(res.locals.identity);
    const caller = raw === null ? null : (names()[raw] ?? raw);
    if (caller === null || (!allowed.has(caller) && !(raw !== null && allowed.has(raw)))) { res.status(403).json(FORBIDDEN); return; }
    res.locals.admin = caller;
    next();
  });
  const fail = (res: Response, e: unknown) => {
    if (e instanceof CapitolineError) { res.status(400).json({ error: { message: e.message, type: "invalid_request_error", code: e.kind } }); return; }
    log.error({ err: e }, "admin: unhandled error");
    res.status(500).json({ error: { message: "internal error", type: "server_error", code: "bad_output" } });
  };

  // The key is in this response and nowhere else, ever: the store keeps its
  // hash, the list below never returns it, and the log names the key and not
  // its value.
  router.post("/keys", (req: Request, res: Response) => {
    const name = (req.body as { name?: unknown } | undefined)?.name;
    if (typeof name !== "string") { res.status(400).json({ error: { message: "name (string) is required", type: "invalid_request_error", code: "bad_request" } }); return; }
    try {
      const created = store.createKey(name, res.locals.admin as string);
      log.info({ admin: res.locals.admin, key: name }, "admin: key created");
      res.status(201).json({ name: created.name, key: created.key, created_at: created.createdAt });
    } catch (e) { fail(res, e); }
  });

  router.get("/keys", (_req: Request, res: Response) => {
    res.json({ keys: store.listKeys().map((k) => ({ name: k.name, created_at: k.createdAt, created_by: k.createdBy, revoked_at: k.revokedAt, last_used_at: k.lastUsedAt })) });
  });

  // Revoked, not deleted: the usage rows written under this name keep it.
  router.delete("/keys/:name", (req: Request, res: Response) => {
    const name = String(req.params.name);
    if (!store.revokeKey(name)) { res.status(404).json({ error: { message: `no live key named "${name}"`, type: "invalid_request_error", code: "not_found" } }); return; }
    log.info({ admin: res.locals.admin, key: name }, "admin: key revoked");
    res.json({ name, revoked: true });
  });

  // The binding of a Cloudflare-identified caller to a name: the runtime
  // half of server.access.callers, with the same meaning and the same reader
  // (/v1/usage names rows at presentation time, never when they are written).
  router.put("/callers/:id", (req: Request, res: Response) => {
    const id = String(req.params.id);
    const name = (req.body as { name?: unknown } | undefined)?.name;
    if (typeof name !== "string" || name.trim() === "" || name.length > 320) { res.status(400).json({ error: { message: "name (string, 1-320 characters) is required", type: "invalid_request_error", code: "bad_request" } }); return; }
    store.nameCaller(id, name.trim());
    log.info({ admin: res.locals.admin, id, name: name.trim() }, "admin: caller named");
    res.json({ id, name: name.trim() });
  });

  router.get("/callers", (_req: Request, res: Response) => {
    res.json({ callers: store.callerNames() });
  });

  if (ops) {
    const bad = (res: Response, message: string) => res.status(400).json({ error: { message, type: "invalid_request_error", code: "bad_request" } });
    const missing = (res: Response, message: string) => res.status(404).json({ error: { message, type: "invalid_request_error", code: "not_found" } });
    const named = (caller: string | null) => (caller !== null && names()[caller]) || caller;
    const intParam = (v: unknown, def: number, min: number, max: number) => {
      const n = v === undefined ? def : Number(v);
      return Number.isInteger(n) && n >= min && n <= max ? n : null;
    };

    // Who is in: what the page asks first, to tell a key that is not an
    // administrator's from one that is (a 403 here, from the gate above).
    router.get("/whoami", (_req: Request, res: Response) => { res.json({ admin: res.locals.admin }); });

    router.get("/usage", (req: Request, res: Response) => {
      const days = intParam(req.query.days, 7, 1, 90);
      if (days === null) return void bad(res, "days must be a whole number from 1 to 90");
      res.json({ days, rows: ops.usage.usageByDay(days * DAY_MS).map((r) => ({ ...r, caller: named(r.caller) })) });
    });

    // What the subscriptions cost: what the operator set here, and until then
    // the configuration's own figures, which are in USD.
    const subscriptions = (): { value: Subscriptions; source: "admin" | "configuration" } => {
      const kept = parseSubscriptions(ops.usage.setting(SUBSCRIPTIONS_KEY));
      return kept ? { value: kept, source: "admin" } : { value: { currency: "USD", usdPerUnit: 1, monthly: ops.prices?.subscriptions ?? {} }, source: "configuration" };
    };

    router.get("/subscriptions", (_req: Request, res: Response) => {
      const s = subscriptions();
      res.json({ ...s.value, source: s.source });
    });

    // State, not configuration: a subscription's price changes with the plan
    // and with the vendor, and is paid in the operator's own currency. The
    // whole value is replaced, so leaving a provider out removes its figure.
    router.put("/subscriptions", (req: Request, res: Response) => {
      const s = parseSubscriptions(req.body, ops.core.providerStates().map((p) => p.id));
      if (!s) return void bad(res, "expected { currency: three capital letters, usdPerUnit: a number above 0, monthly: { <provider id>: a number from 0 } }");
      ops.usage.setSetting(SUBSCRIPTIONS_KEY, s);
      log.info({ admin: res.locals.admin, currency: s.currency, providers: Object.keys(s.monthly) }, "admin: subscriptions set");
      res.json({ ...s, source: "admin" });
    });

    // What the recorded traffic would have cost at the vendors' list prices:
    // a comparison with the subscriptions, not a bill. `cost` is null for a
    // model the configuration gives no price, so a sum can say what it left out.
    router.get("/costs", (req: Request, res: Response) => {
      const days = intParam(req.query.days, 30, 1, 90);
      if (days === null) return void bad(res, "days must be a whole number from 1 to 90");
      const prices = ops.prices ?? { subscriptions: {}, models: {} };
      res.json({
        days, pricesVerified: prices.verified ?? null, subscriptions: subscriptions().value,
        rows: ops.usage.spend(days * DAY_MS).map((r) => ({ ...r, caller: named(r.caller), cost: costOf(r, prices.models[r.model]) })),
      });
    });

    router.get("/deliberations", (req: Request, res: Response) => {
      const limit = intParam(req.query.limit, 20, 1, 200);
      if (limit === null) return void bad(res, "limit must be a whole number from 1 to 200");
      res.json({ deliberations: ops.usage.deliberations(limit).map((d) => ({ ...d, caller: named(d.caller) })) });
    });

    router.get("/deliberations/:id", (req: Request, res: Response) => {
      const calls = ops.usage.deliberationCalls(String(req.params.id));
      if (calls.length === 0) return void missing(res, `no deliberation "${req.params.id}"`);
      res.json({ id: String(req.params.id), calls });
    });

    router.get("/pauses", (_req: Request, res: Response) => { res.json({ pauses: ops.core.pauses() }); });

    router.post("/pauses", (req: Request, res: Response) => {
      const b = (req.body ?? {}) as { provider?: unknown; model?: unknown; minutes?: unknown };
      if (typeof b.provider !== "string" || (b.model !== undefined && typeof b.model !== "string")) return void bad(res, "provider (string) is required; model (string) is optional");
      const minutes = intParam(b.minutes, NaN, 1, MAX_HOLD_MINUTES);
      if (minutes === null) return void bad(res, `minutes must be a whole number from 1 to ${MAX_HOLD_MINUTES}`);
      try {
        const pause = ops.core.holdBack(b.provider, b.model as string | undefined, minutes * 60_000);
        log.info({ admin: res.locals.admin, provider: b.provider, model: b.model, minutes }, "admin: pause installed");
        res.status(201).json(pause);
      } catch (e) { fail(res, e); }
    });

    // The scope travels in the query because it holds a colon and may hold a
    // slash; without it the provider's own pause is the one lifted.
    router.delete("/pauses/:provider", (req: Request, res: Response) => {
      const provider = String(req.params.provider);
      const scope = typeof req.query.scope === "string" && req.query.scope !== "" ? req.query.scope : null;
      if (!ops.core.liftPause(provider, scope)) return void missing(res, `no pause stands for ${provider}${scope ? ` ${scope}` : ""}`);
      log.info({ admin: res.locals.admin, provider, scope }, "admin: pause lifted");
      res.json({ provider, scope, lifted: true });
    });

    // A real call on each CLI probed, like the hourly one: awaited, so the
    // answer is the state after it.
    router.post("/health-check", async (req: Request, res: Response) => {
      const provider = (req.body as { provider?: unknown } | undefined)?.provider;
      if (provider !== undefined && typeof provider !== "string") return void bad(res, "provider must be a string");
      try {
        await ops.core.checkHealth(provider);
        log.info({ admin: res.locals.admin, provider }, "admin: health check run");
        res.json({ providers: ops.core.providerStates().map((p) => ({ id: p.id, health: p.health })) });
      } catch (e) { fail(res, e); }
    });

    router.post("/catalog-check", async (_req: Request, res: Response) => {
      try {
        await Promise.all([ops.core.checkCatalog(), ops.core.checkQuota()]);
        log.info({ admin: res.locals.admin }, "admin: catalog check run");
        res.json({ providers: ops.core.providerStates().map((p) => ({ id: p.id, catalog: p.catalog, quota: p.quota })) });
      } catch (e) { fail(res, e); }
    });

    router.post("/notify-test", async (_req: Request, res: Response) => {
      if (!ops.notify) return void bad(res, "notifications are not configured (server.notify)");
      const delivered = await ops.notify(`test notification, asked for by ${String(res.locals.admin)}`);
      log.info({ admin: res.locals.admin, delivered }, "admin: test notification sent");
      res.json({ delivered });
    });

    router.get("/conversations", (_req: Request, res: Response) => {
      res.json({ owners: (ops.conversations?.summary() ?? []).map((o) => ({ ...o, name: named(o.owner) })) });
    });

    router.delete("/conversations/:owner", (req: Request, res: Response) => {
      const owner = String(req.params.owner);
      const threads = ops.conversations?.deleteOwner(owner) ?? 0;
      if (threads === 0) return void missing(res, `"${owner}" has no kept conversations`);
      log.info({ admin: res.locals.admin, owner, threads }, "admin: conversations deleted");
      res.json({ owner, deleted: threads });
    });

    router.get("/config", (_req: Request, res: Response) => { res.json(ops.config()); });
  }

  return router;
}
