import express, { type Request, type Response } from "express";
import type { Logger } from "../log.js";
import { CapitolineError } from "../core/types.js";
import type { ApiKeyInfo } from "../usage/store.js";
import { callerOf } from "./access.js";

/** What the admin API needs from the store (src/usage/store.ts). */
export interface AdminStore {
  createKey(name: string, createdBy: string | null): { name: string; key: string; createdAt: number };
  listKeys(): ApiKeyInfo[];
  revokeKey(name: string): boolean;
  nameCaller(id: string, name: string): void;
  callerNames(): Record<string, string>;
}

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
export function createAdminRouter(store: AdminStore, admins: string[], names: () => Record<string, string>, log: Logger): express.Router {
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

  return router;
}
