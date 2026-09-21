import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { ModelKind } from "../config.js";
import type { ErrorKind, RateLimitWindow } from "../core/types.js";

export interface CallRecord {
  provider: string; model: string; inputTokens: number; outputTokens: number; durationMs: number;
  outcome: "ok" | ErrorKind | "aborted"; source: "http" | "mcp" | "health"; ts?: number;
  /** What the model produces; defaults to text (health probes and every pre-image row). */
  kind?: ModelKind;
  /** Who asked, as the Access identity names them; null when nothing identified them. */
  caller?: string | null;
}
export interface Totals { calls: number; inputTokens: number; outputTokens: number }
/** What one caller spent in a window. `caller` is null for the calls nothing identified. */
export interface CallerUsage { caller: string | null; calls: number; inputTokens: number; outputTokens: number }
export type WindowName = "five_hour" | "seven_day";
/** Image generations counted in a rolling window: `windowStartedAt` is null while the window is empty. */
export interface ImageWindow { used: number; windowStartedAt: number | null }
/** A pause held across restarts. `model` is null for a pause that covers the whole provider. */
export interface PauseRow { provider: string; model: string | null; until: number; strikes: number }

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
    callers: StatementSync; setPause: StatementSync; clearPause: StatementSync; prunePauses: StatementSync; pauses: StatementSync;
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
        outcome TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text', caller TEXT);
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

    this.stmts = {
      record: this.db.prepare(`INSERT INTO calls (ts, provider, model, input_tokens, output_tokens, duration_ms, outcome, source, kind, caller) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
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
      pauses: this.db.prepare(`SELECT provider, model, until, strikes FROM pauses WHERE until > ? ORDER BY provider, model`),
    };
  }
  record(c: CallRecord): void {
    this.stmts.record.run(c.ts ?? Date.now(), c.provider, c.model, c.inputTokens, c.outputTokens, c.durationMs, c.outcome, c.source, c.kind ?? "text", c.caller ?? null);
  }

  // Who spent the window, busiest first. One row per distinct caller, with the
  // unidentified calls gathered under null — sqlite groups NULLs together,
  // which is exactly the reading wanted: "not attributed" is one bucket.
  callers(sinceMs: number, now = Date.now()): CallerUsage[] {
    const rows = this.stmts.callers.all(now - sinceMs) as { caller: string | null; calls: number; i: number; o: number }[];
    return rows.map((r) => ({ caller: r.caller, calls: Number(r.calls), inputTokens: Number(r.i), outputTokens: Number(r.o) }));
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
    const rows = this.stmts.pauses.all(now) as { provider: string; model: string | null; until: number; strikes: number }[];
    return rows.map((r) => ({ provider: r.provider, model: r.model, until: Number(r.until), strikes: Number(r.strikes) }));
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
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
