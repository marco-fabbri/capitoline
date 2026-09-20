import { DatabaseSync } from "node:sqlite";
import type { ErrorKind, RateLimitWindow } from "../core/types.js";

export interface CallRecord {
  provider: string; model: string; inputTokens: number; outputTokens: number; durationMs: number;
  outcome: "ok" | ErrorKind | "aborted"; source: "http" | "mcp" | "health"; ts?: number;
}
export interface Totals { calls: number; inputTokens: number; outputTokens: number }
export type WindowName = "five_hour" | "seven_day";

export class UsageStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
        outcome TEXT NOT NULL, source TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS calls_provider_ts ON calls(provider, ts);
      CREATE TABLE IF NOT EXISTS rate_windows (
        provider TEXT NOT NULL, window TEXT NOT NULL, utilization REAL NOT NULL, resets_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, PRIMARY KEY (provider, window));
    `);
  }
  record(c: CallRecord): void {
    this.db.prepare(`INSERT INTO calls (ts, provider, model, input_tokens, output_tokens, duration_ms, outcome, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(c.ts ?? Date.now(), c.provider, c.model, c.inputTokens, c.outputTokens, c.durationMs, c.outcome, c.source);
  }
  totals(provider: string, sinceMs: number, now = Date.now()): Totals {
    const row = this.db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o FROM calls WHERE provider = ? AND ts > ?`)
      .get(provider, now - sinceMs) as { calls: number; i: number; o: number };
    return { calls: Number(row.calls), inputTokens: Number(row.i), outputTokens: Number(row.o) };
  }
  setWindow(provider: string, window: WindowName, w: RateLimitWindow, now = Date.now()): void {
    this.db.prepare(`INSERT INTO rate_windows (provider, window, utilization, resets_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider, window) DO UPDATE SET utilization = excluded.utilization, resets_at = excluded.resets_at, updated_at = excluded.updated_at`)
      .run(provider, window, w.utilization, w.resetsAt, now);
  }
  windows(provider: string): Partial<Record<WindowName, RateLimitWindow & { updatedAt: number }>> {
    const rows = this.db.prepare(`SELECT window, utilization, resets_at, updated_at FROM rate_windows WHERE provider = ?`).all(provider) as
      { window: WindowName; utilization: number; resets_at: number; updated_at: number }[];
    const out: Partial<Record<WindowName, RateLimitWindow & { updatedAt: number }>> = {};
    for (const r of rows) out[r.window] = { utilization: r.utilization, resetsAt: r.resets_at, updatedAt: r.updated_at };
    return out;
  }
  close(): void { this.db.close(); }
}
