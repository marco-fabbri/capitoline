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
}
export interface Totals { calls: number; inputTokens: number; outputTokens: number }
export type WindowName = "five_hour" | "seven_day";
/** Image generations counted in a rolling window: `windowStartedAt` is null while the window is empty. */
export interface ImageWindow { used: number; windowStartedAt: number | null }

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
        outcome TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text');
      CREATE INDEX IF NOT EXISTS calls_provider_ts ON calls(provider, ts);
      CREATE TABLE IF NOT EXISTS rate_windows (
        provider TEXT NOT NULL, window TEXT NOT NULL, utilization REAL NOT NULL, resets_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, PRIMARY KEY (provider, window));
    `);
    // A database written before image models existed has no `kind` column, and
    // CREATE TABLE IF NOT EXISTS leaves it alone: add it here, with the same
    // default, so an upgrade keeps its history instead of losing it.
    const columns = this.db.prepare(`PRAGMA table_info(calls)`).all() as { name: string }[];
    if (!columns.some((c) => c.name === "kind")) this.db.exec(`ALTER TABLE calls ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'`);

    this.stmts = {
      record: this.db.prepare(`INSERT INTO calls (ts, provider, model, input_tokens, output_tokens, duration_ms, outcome, source, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      imageWindow: this.db.prepare(`SELECT COUNT(*) AS used, MIN(ts) AS started FROM calls WHERE provider = ? AND kind = 'image' AND outcome = 'ok' AND ts > ?`),
      totals: this.db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o FROM calls WHERE provider = ? AND ts > ?`),
      setWindow: this.db.prepare(`INSERT INTO rate_windows (provider, window, utilization, resets_at, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(provider, window) DO UPDATE SET utilization = excluded.utilization, resets_at = excluded.resets_at, updated_at = excluded.updated_at`),
      windows: this.db.prepare(`SELECT window, utilization, resets_at, updated_at FROM rate_windows WHERE provider = ?`),
    };
  }
  record(c: CallRecord): void {
    this.stmts.record.run(c.ts ?? Date.now(), c.provider, c.model, c.inputTokens, c.outputTokens, c.durationMs, c.outcome, c.source, c.kind ?? "text");
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
  // SIGTERM followed by SIGINT closes the store twice, and node:sqlite throws
  // on the second close: the flag keeps a clean shutdown clean.
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
