import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { ModelKind } from "../config.js";
import { CapitolineError, type ErrorKind, type RateLimitWindow } from "../core/types.js";
import type { ListedModel } from "../providers/adapter.js";

export interface CallRecord {
  provider: string; model: string; inputTokens: number; outputTokens: number; durationMs: number;
  outcome: "ok" | ErrorKind | "aborted"; source: "http" | "mcp" | "health"; ts?: number;
  /** What the model produces; defaults to text (health probes and every pre-image row). */
  kind?: ModelKind;
  /** Who asked, as the Access identity names them; null when nothing identified them. */
  caller?: string | null;
  /**
   * The council deliberation this call belongs to, null for a request a client
   * made directly. One question is nine calls under six different models
   * (spec 12.7), and this is what sums them back into one question instead of
   * a guess over a time window.
   */
  deliberation?: string | null;
  /**
   * The dated id of the model that actually answered — `claude-opus-5-5-…`
   * for a row whose `model` is `claude-opus`. Null when the CLI said nothing,
   * which is the honest value for every Codex and Antigravity row and for
   * every row written before 2026-09-23: only Claude's names are aliases that
   * move, so only Claude reports this.
   */
  cliModelId?: string | null;
}
export interface Totals { calls: number; inputTokens: number; outputTokens: number }
/** What one caller spent in a window. `caller` is null for the calls nothing identified. */
export interface CallerUsage { caller: string | null; calls: number; inputTokens: number; outputTokens: number }
/**
 * Which real model served a gateway name, and when. More than one row for the
 * same `model` is the thing worth seeing: the name did not change and the
 * model under it did — `claude-opus` was Opus 5 until 2026-09-22 and Opus 5.5
 * after it, with nothing in the configuration touched.
 */
export interface ModelIdentity { model: string; cliModelId: string; calls: number; firstAt: number; lastAt: number }
export type WindowName = "five_hour" | "seven_day";
/** Image generations counted in a rolling window: `windowStartedAt` is null while the window is empty. */
export interface ImageWindow { used: number; windowStartedAt: number | null }
/** A pause held across restarts. `model` is null for a pause that covers the whole provider. */
export interface PauseRow { provider: string; model: string | null; until: number; strikes: number; announcedAt: number | null }
/** A key as the admin API lists it: never the hash, never the key. */
export interface ApiKeyInfo { name: string; createdAt: number; createdBy: string | null; revokedAt: number | null; lastUsedAt: number | null }
/** Lower case, digits and dashes, 2-64 characters: a name that is also safe in a header, a log line and a URL. */
export const KEY_NAME = /^[a-z0-9][a-z0-9-]{1,63}$/;
const hashKey = (key: string): string => createHash("sha256").update(key).digest("hex");

/** The five-hour window: the provider's short image quota and the budget windows share it. */
export const H5 = 5 * 3600_000;

export class UsageStore {
  private readonly db: DatabaseSync;
  // Every request writes a row and reads the budget windows, so the SQL is
  // compiled once here instead of on every call. They are prepared after the
  // schema is settled (the `kind` migration below), because a statement naming
  // a column the table does not have yet fails to compile.
  private readonly stmts: {
    record: StatementSync; imageWindow: StatementSync; totals: StatementSync; setWindow: StatementSync; windows: StatementSync;
    callers: StatementSync; setPause: StatementSync; clearPause: StatementSync; prunePauses: StatementSync; pauses: StatementSync; announcePause: StatementSync; expiredAnnounced: StatementSync;
    deliberation: StatementSync; identities: StatementSync;
    insertKey: StatementSync; keyByHash: StatementSync; touchKey: StatementSync; revokeKey: StatementSync; keys: StatementSync; liveKeys: StatementSync;
    nameCaller: StatementSync; callerNames: StatementSync;
    saveCatalog: StatementSync; catalogs: StatementSync;
    announced: StatementSync; setAnnounced: StatementSync;
  };
  private closed = false;
  constructor(path: string) {
    // A fresh deployment points db_path at a directory that does not exist yet
    // (/var/lib/capitoline/usage.sqlite): sqlite would only say "unable to open
    // database file". `:memory:` and an empty path are sqlite's own names for a
    // database with no file, and have no parent directory to create.
    if (path !== ":memory:" && path !== "") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
        outcome TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text', caller TEXT, deliberation TEXT);
      CREATE INDEX IF NOT EXISTS calls_provider_ts ON calls(provider, ts);
      -- The per-caller breakdown filters on ts alone, which the composite
      -- index above cannot serve: without this one it is a full scan of a
      -- table nothing ever prunes. IF NOT EXISTS also upgrades the deployed
      -- database in place.
      CREATE INDEX IF NOT EXISTS calls_ts ON calls(ts);
      CREATE TABLE IF NOT EXISTS rate_windows (
        provider TEXT NOT NULL, window TEXT NOT NULL, utilization REAL NOT NULL, resets_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, PRIMARY KEY (provider, window));
      -- The pauses a rate limit installs, so a refusal that reopens in days is
      -- known again after a restart instead of being rediscovered by a real
      -- call. The model column is null for a pause covering the whole
      -- provider; IF NOT EXISTS is also what upgrades the deployed database.
      CREATE TABLE IF NOT EXISTS pauses (
        provider TEXT NOT NULL, model TEXT, until INTEGER NOT NULL, strikes INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, PRIMARY KEY (provider, model));
      -- One row per scope, enforced rather than merely respected. The PRIMARY
      -- KEY above cannot do it: sqlite admits NULLs inside the primary key of
      -- a rowid table and holds two of them distinct, so nothing would stop a
      -- second provider-wide row from being inserted, and the restore would
      -- then pick whichever came first. Folding the NULL to '' gives the
      -- scope a value the index can compare, and gives setPause() a conflict
      -- target so one atomic upsert replaces the delete-then-insert pair.
      CREATE UNIQUE INDEX IF NOT EXISTS pauses_scope ON pauses(provider, ifnull(model, ''));
      -- The gateway's own identity (design §4, "two identities"): a key it
      -- issued, kept as the sha256 of the key and never the key, which is
      -- shown once at creation. A revoked key stays, so the usage rows that
      -- carry its name keep their meaning; revoked_at is what refuses it.
      CREATE TABLE IF NOT EXISTS api_keys (
        name TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, created_by TEXT,
        revoked_at INTEGER, last_used_at INTEGER);
      -- What to call a caller Cloudflare identifies by a client id: the
      -- runtime half of server.access.callers, written by the admin API, read
      -- by /v1/usage at presentation time exactly as the configured map is.
      CREATE TABLE IF NOT EXISTS callers (id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at INTEGER NOT NULL);
      -- The last listing each provider's CLI gave of its models (the daily
      -- catalog, docs/deploy.md §7.2), as the JSON the adapter read. Restored
      -- at startup, so a restart neither drops the discovered models until the
      -- next listing nor reports every one of them as new.
      CREATE TABLE IF NOT EXISTS catalog (provider TEXT PRIMARY KEY, listing TEXT NOT NULL, checked_at INTEGER NOT NULL);
      -- The last CLI version announced as available, per provider, so the
      -- daily check announces each new version once and a restart not at all.
      CREATE TABLE IF NOT EXISTS versions (provider TEXT PRIMARY KEY, announced TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `);
    // A database written before image models existed has no `kind` column, and
    // CREATE TABLE IF NOT EXISTS leaves it alone: add it here, with the same
    // default, so an upgrade keeps its history instead of losing it.
    const columns = new Set((this.db.prepare(`PRAGMA table_info(calls)`).all() as { name: string }[]).map((c) => c.name));
    if (!columns.has("kind")) this.db.exec(`ALTER TABLE calls ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'`);
    // The same for the caller of a call, added after the deployed database was
    // written. Nullable and with no default: "nobody said who" is a real
    // state — the rows written before attribution existed, the health probes,
    // and every call served with Access verification disabled — and NULL is
    // its name, distinct from any string a token could carry.
    if (!columns.has("caller")) this.db.exec(`ALTER TABLE calls ADD COLUMN caller TEXT`);
    // And the same for the deliberation a call belonged to, added with the
    // council. Nullable for the same reason: every row written before the
    // council existed, and every direct request after it, belongs to no
    // deliberation, and NULL is that state's name.
    if (!columns.has("deliberation")) this.db.exec(`ALTER TABLE calls ADD COLUMN deliberation TEXT`);
    // And the dated model id, added 2026-09-23 when `opus` moved from Opus 5
    // to Opus 5.5 with nothing in the history saying which one any measurement
    // had used. Nullable with no default, for the same reason `caller` is:
    // "the CLI said nothing" is a real state, and it is what every Codex row,
    // every Antigravity row and every row older than this column will hold.
    if (!columns.has("cli_model_id")) this.db.exec(`ALTER TABLE calls ADD COLUMN cli_model_id TEXT`);
    // When a pause's start was announced (server.notify), added 2026-09-30:
    // what lets a restart announce the end of a pause it did not see start,
    // and not announce the start twice. NULL for a pause nobody was told of.
    const pauseColumns = new Set((this.db.prepare(`PRAGMA table_info(pauses)`).all() as { name: string }[]).map((c) => c.name));
    if (!pauseColumns.has("announced_at")) this.db.exec(`ALTER TABLE pauses ADD COLUMN announced_at INTEGER`);

    this.stmts = {
      record: this.db.prepare(`INSERT INTO calls (ts, provider, model, input_tokens, output_tokens, duration_ms, outcome, source, kind, caller, deliberation, cli_model_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      imageWindow: this.db.prepare(`SELECT COUNT(*) AS used, MIN(ts) AS started FROM calls WHERE provider = ? AND kind = 'image' AND outcome = 'ok' AND ts > ?`),
      totals: this.db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o FROM calls WHERE provider = ? AND ts > ?`),
      setWindow: this.db.prepare(`INSERT INTO rate_windows (provider, window, utilization, resets_at, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(provider, window) DO UPDATE SET utilization = excluded.utilization, resets_at = excluded.resets_at, updated_at = excluded.updated_at`),
      windows: this.db.prepare(`SELECT window, utilization, resets_at, updated_at FROM rate_windows WHERE provider = ?`),
      // The gateway's own health probes are excluded: they are not a caller,
      // and they outnumber the real traffic (45 of the first 56 calls on the
      // host), so they would bury the breakdown under one huge null row.
      callers: this.db.prepare(`SELECT caller, COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o
        FROM calls WHERE ts > ? AND source <> 'health' GROUP BY caller ORDER BY calls DESC, caller`),
      // One statement, so the row is never absent between two of them: a
      // delete followed by an insert is two transactions in WAL, and a SIGKILL
      // in the gap (systemd Restart=always, an OOM kill) would lose a five-day
      // pause — the very state this table exists to keep. The conflict target
      // is the expression the unique index above builds, not (provider,
      // model), because ON CONFLICT(provider, model) never fires for a
      // provider-wide pause: its model is NULL and no two NULLs conflict.
      // `model IS ?` in the delete below for the same reason: `IS` is the one
      // comparison that matches a NULL, so it serves both scopes.
      setPause: this.db.prepare(`INSERT INTO pauses (provider, model, until, strikes, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(provider, ifnull(model, '')) DO UPDATE SET until = excluded.until, strikes = excluded.strikes, updated_at = excluded.updated_at`),
      clearPause: this.db.prepare(`DELETE FROM pauses WHERE provider = ? AND model IS ?`),
      prunePauses: this.db.prepare(`DELETE FROM pauses WHERE until <= ?`),
      pauses: this.db.prepare(`SELECT provider, model, until, strikes, announced_at FROM pauses WHERE until > ? ORDER BY provider, model`),
      announcePause: this.db.prepare(`UPDATE pauses SET announced_at = ? WHERE provider = ? AND model IS ?`),
      expiredAnnounced: this.db.prepare(`SELECT provider, model, until, strikes, announced_at FROM pauses WHERE until <= ? AND announced_at IS NOT NULL ORDER BY provider, model`),
      // No index and no time bound: an identifier is asked about right after
      // the deliberation that minted it, one question at a time, and an index
      // on a column that is NULL for almost every row would cost every insert
      // for a read nothing does in a loop.
      deliberation: this.db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o FROM calls WHERE deliberation = ?`),
      // Rows the CLI identified, only: a null would say "Codex, as always"
      // and add a line to every listing for it. `calls_ts` covers the bound.
      identities: this.db.prepare(`SELECT model, cli_model_id AS id, COUNT(*) AS calls, MIN(ts) AS first_at, MAX(ts) AS last_at
        FROM calls WHERE ts > ? AND cli_model_id IS NOT NULL GROUP BY model, cli_model_id ORDER BY model, last_at`),
      insertKey: this.db.prepare(`INSERT INTO api_keys (name, hash, created_at, created_by) VALUES (?, ?, ?, ?)`),
      keyByHash: this.db.prepare(`SELECT name, revoked_at FROM api_keys WHERE hash = ?`),
      touchKey: this.db.prepare(`UPDATE api_keys SET last_used_at = ? WHERE name = ?`),
      revokeKey: this.db.prepare(`UPDATE api_keys SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL`),
      keys: this.db.prepare(`SELECT name, created_at, created_by, revoked_at, last_used_at FROM api_keys ORDER BY created_at, name`),
      liveKeys: this.db.prepare(`SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL`),
      nameCaller: this.db.prepare(`INSERT INTO callers (id, name, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`),
      callerNames: this.db.prepare(`SELECT id, name FROM callers ORDER BY id`),
      saveCatalog: this.db.prepare(`INSERT INTO catalog (provider, listing, checked_at) VALUES (?, ?, ?) ON CONFLICT(provider) DO UPDATE SET listing = excluded.listing, checked_at = excluded.checked_at`),
      catalogs: this.db.prepare(`SELECT provider, listing, checked_at FROM catalog ORDER BY provider`),
      announced: this.db.prepare(`SELECT announced FROM versions WHERE provider = ?`),
      setAnnounced: this.db.prepare(`INSERT INTO versions (provider, announced, updated_at) VALUES (?, ?, ?) ON CONFLICT(provider) DO UPDATE SET announced = excluded.announced, updated_at = excluded.updated_at`),
    };
  }
  record(c: CallRecord): void {
    this.stmts.record.run(c.ts ?? Date.now(), c.provider, c.model, c.inputTokens, c.outputTokens, c.durationMs, c.outcome, c.source, c.kind ?? "text", c.caller ?? null, c.deliberation ?? null, c.cliModelId ?? null);
  }

  // What one deliberation spent, across every model that served it: the other
  // half of spec 12.7, and the only reading the identifier exists for.
  deliberationTotals(id: string): Totals {
    const row = this.stmts.deliberation.get(id) as { calls: number; i: number; o: number };
    return { calls: Number(row.calls), inputTokens: Number(row.i), outputTokens: Number(row.o) };
  }

  // Who spent the window, busiest first. One row per distinct caller, with the
  // unidentified calls gathered under null — sqlite groups NULLs together,
  // which is exactly the reading wanted: "not attributed" is one bucket.
  callers(sinceMs: number, now = Date.now()): CallerUsage[] {
    const rows = this.stmts.callers.all(now - sinceMs) as { caller: string | null; calls: number; i: number; o: number }[];
    return rows.map((r) => ({ caller: r.caller, calls: Number(r.calls), inputTokens: Number(r.i), outputTokens: Number(r.o) }));
  }

  /**
   * Which real models served each gateway name in the window, oldest last seen
   * first within a name. Rows the CLI did not identify are left out rather than
   * gathered under a null: only Claude's names are aliases that move, so a null
   * row would say "Codex, as always" for every Codex model in the table.
   */
  modelIdentities(sinceMs: number, now = Date.now()): ModelIdentity[] {
    const rows = this.stmts.identities.all(now - sinceMs) as { model: string; id: string; calls: number; first_at: number; last_at: number }[];
    return rows.map((r) => ({ model: r.model, cliModelId: r.id, calls: Number(r.calls), firstAt: Number(r.first_at), lastAt: Number(r.last_at) }));
  }

  // The image quota is counted in generations, not tokens, and only a
  // generation that produced an image spends it: a 429 or a crash costs
  // nothing. The window is rolling, so it "opens" at the oldest call still
  // inside it — that is what a client needs to know when the next one frees up.
  // The count is a lower bound, never an exact reading: it sees the successful
  // runs of the images endpoint only, while a text run that invokes the CLI's
  // own generate_image tool (recorded with kind text) and a generation the
  // client abandons after the image event (recorded aborted) spend quota
  // without being counted.
  imageWindow(provider: string, windowMs = H5, now = Date.now()): ImageWindow {
    const row = this.stmts.imageWindow.get(provider, now - windowMs) as { used: number; started: number | null };
    return { used: Number(row.used), windowStartedAt: row.started === null ? null : Number(row.started) };
  }
  totals(provider: string, sinceMs: number, now = Date.now()): Totals {
    const row = this.stmts.totals.get(provider, now - sinceMs) as { calls: number; i: number; o: number };
    return { calls: Number(row.calls), inputTokens: Number(row.i), outputTokens: Number(row.o) };
  }
  setWindow(provider: string, window: WindowName, w: RateLimitWindow, now = Date.now()): void {
    this.stmts.setWindow.run(provider, window, w.utilization, w.resetsAt, now);
  }
  windows(provider: string): Partial<Record<WindowName, RateLimitWindow & { updatedAt: number }>> {
    const rows = this.stmts.windows.all(provider) as
      { window: WindowName; utilization: number; resets_at: number; updated_at: number }[];
    const out: Partial<Record<WindowName, RateLimitWindow & { updatedAt: number }>> = {};
    for (const r of rows) out[r.window] = { utilization: r.utilization, resetsAt: r.resets_at, updatedAt: r.updated_at };
    return out;
  }
  // The pause a rate limit installed, provider-wide (model null) or for one
  // model. It replaces whatever stood for that scope: the caller has already
  // decided the pause only grows, so what arrives here is the state to keep.
  setPause(provider: string, model: string | null, until: number, strikes: number, now = Date.now()): void {
    this.stmts.setPause.run(provider, model, until, strikes, now);
  }
  clearPause(provider: string, model: string | null): void {
    this.stmts.clearPause.run(provider, model);
  }
  /** The pauses still standing at `now`. A read, and only a read. */
  pauses(now = Date.now()): PauseRow[] {
    return this.pauseRows(this.stmts.pauses.all(now));
  }
  /** The pauses that ended before `now` after their start was announced: read before prunePauses() drops them. */
  expiredAnnouncedPauses(now = Date.now()): PauseRow[] {
    return this.pauseRows(this.stmts.expiredAnnounced.all(now));
  }
  /** Records that a pause's start was announced, or, with null, that the pause standing now was not. */
  markPauseAnnounced(provider: string, model: string | null, at: number | null): void {
    this.stmts.announcePause.run(at, provider, model);
  }
  private pauseRows(all: unknown[]): PauseRow[] {
    const rows = all as { provider: string; model: string | null; until: number; strikes: number; announced_at: number | null }[];
    return rows.map((r) => ({ provider: r.provider, model: r.model, until: Number(r.until), strikes: Number(r.strikes), announcedAt: r.announced_at === null ? null : Number(r.announced_at) }));
  }
  /**
   * Drops the rows that expired before `now` and says how many went, so the
   * caller can log it. Kept out of pauses(): a reader that deletes destroys a
   * five-day pause silently when the clock it is given is wrong (a restored
   * VM snapshot, an RTC off, an NTP step before time-sync.target), and the
   * only trace of the collection would be the row's absence.
   */
  prunePauses(now = Date.now()): number {
    return Number(this.stmts.prunePauses.run(now).changes);
  }

  // SIGTERM followed by SIGINT closes the store twice, and node:sqlite throws
  // on the second close: the flag keeps a clean shutdown clean.
  // ---- The gateway's own identity: keys it issued, and names for callers.

  /**
   * A new key, returned in the clear exactly once. `cap_` and 32 random
   * bytes; what is stored is the sha256 of the whole string, so a database
   * read back from a backup yields nothing a client could send.
   */
  createKey(name: string, createdBy: string | null, now = Date.now()): { name: string; key: string; createdAt: number } {
    if (!KEY_NAME.test(name)) throw new CapitolineError("bad_request", `key name "${name}" must match ${KEY_NAME}`);
    const key = `cap_${randomBytes(32).toString("base64url")}`;
    try {
      this.stmts.insertKey.run(name, hashKey(key), now, createdBy);
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw new CapitolineError("bad_request", `key "${name}" already exists`);
      throw e;
    }
    return { name, key, createdAt: now };
  }

  /** The key's name when it is one of ours and not revoked; null otherwise. Touches last_used_at. */
  authenticateKey(key: string, now = Date.now()): { name: string } | null {
    if (!key.startsWith("cap_")) return null;
    const row = this.stmts.keyByHash.get(hashKey(key)) as { name: string; revoked_at: number | null } | undefined;
    if (!row || row.revoked_at !== null) return null;
    this.stmts.touchKey.run(now, row.name);
    return { name: row.name };
  }

  /** Whether any live key exists: with none and no Access the gateway is open (design §4). */
  hasKeys(): boolean {
    return Number((this.stmts.liveKeys.get() as { n: number }).n) > 0;
  }

  listKeys(): ApiKeyInfo[] {
    const rows = this.stmts.keys.all() as { name: string; created_at: number; created_by: string | null; revoked_at: number | null; last_used_at: number | null }[];
    return rows.map((r) => ({ name: r.name, createdAt: Number(r.created_at), createdBy: r.created_by, revokedAt: r.revoked_at === null ? null : Number(r.revoked_at), lastUsedAt: r.last_used_at === null ? null : Number(r.last_used_at) }));
  }

  /** True when the key existed and was live; a second revoke, or an unknown name, is false. */
  revokeKey(name: string, now = Date.now()): boolean {
    return Number(this.stmts.revokeKey.run(now, name).changes) > 0;
  }

  nameCaller(id: string, name: string, now = Date.now()): void {
    this.stmts.nameCaller.run(id, name, now);
  }

  callerNames(): Record<string, string> {
    return Object.fromEntries((this.stmts.callerNames.all() as { id: string; name: string }[]).map((r) => [r.id, r.name]));
  }

  saveCatalog(provider: string, listing: ListedModel[], now = Date.now()): void {
    this.stmts.saveCatalog.run(provider, JSON.stringify(listing), now);
  }

  /** The stored listings. A row that no longer parses is skipped: the next listing replaces it. */
  catalogs(): { provider: string; listing: ListedModel[]; checkedAt: number }[] {
    const rows = this.stmts.catalogs.all() as { provider: string; listing: string; checked_at: number }[];
    return rows.flatMap((r) => {
      try {
        const listing = JSON.parse(r.listing) as unknown;
        return Array.isArray(listing) ? [{ provider: r.provider, listing: listing as ListedModel[], checkedAt: Number(r.checked_at) }] : [];
      } catch { return []; }
    });
  }

  announcedVersion(provider: string): string | null {
    const row = this.stmts.announced.get(provider) as { announced: string } | undefined;
    return row?.announced ?? null;
  }

  setAnnouncedVersion(provider: string, version: string, now = Date.now()): void {
    this.stmts.setAnnounced.run(provider, version, now);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
