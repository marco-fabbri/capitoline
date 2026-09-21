import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { H5, UsageStore } from "../src/usage/store.js";

describe("UsageStore", () => {
  it("records calls and sums them per provider within a window", () => {
    const s = new UsageStore(":memory:");
    const now = 1_000_000_000_000;
    s.record({ provider: "claude", model: "claude-opus", inputTokens: 100, outputTokens: 10, durationMs: 5, outcome: "ok", source: "http", ts: now - 1000 });
    s.record({ provider: "claude", model: "claude-opus", inputTokens: 50, outputTokens: 5, durationMs: 5, outcome: "ok", source: "http", ts: now - 6 * 3600_000 });
    s.record({ provider: "codex", model: "codex-gpt-5.5", inputTokens: 7, outputTokens: 1, durationMs: 5, outcome: "rate_limited", source: "http", ts: now });
    expect(s.totals("claude", 5 * 3600_000, now)).toEqual({ calls: 1, inputTokens: 100, outputTokens: 10 });
    expect(s.totals("claude", 7 * 24 * 3600_000, now)).toEqual({ calls: 2, inputTokens: 150, outputTokens: 15 });
    expect(s.totals("codex", 5 * 3600_000, now).calls).toBe(1);
    s.close();
  });
  it("stores and returns the latest rate-limit windows", () => {
    const s = new UsageStore(":memory:");
    s.setWindow("claude", "five_hour", { utilization: 0.05, resetsAt: 1789896000 }, 10);
    s.setWindow("claude", "five_hour", { utilization: 0.5, resetsAt: 1789896000 }, 20);
    s.setWindow("claude", "seven_day", { utilization: 0.14, resetsAt: 1790362800 }, 20);
    expect(s.windows("claude")).toEqual({
      five_hour: { utilization: 0.5, resetsAt: 1789896000, updatedAt: 20 },
      seven_day: { utilization: 0.14, resetsAt: 1790362800, updatedAt: 20 },
    });
    expect(s.windows("codex")).toEqual({});
    s.close();
  });
  it("counts successful image calls in the window and reports when it opened", () => {
    const s = new UsageStore(":memory:");
    const now = 1_000_000_000_000;
    const img = (ts: number, outcome: "ok" | "rate_limited") =>
      s.record({ provider: "antigravity", model: "agy-image", kind: "image", inputTokens: 0, outputTokens: 0, durationMs: 20_000, outcome, source: "http", ts });
    img(now - 6 * 3600_000, "ok");                 // before the window
    img(now - 4 * 3600_000, "ok");                 // the window opens here
    img(now - 1000, "ok");
    img(now - 500, "rate_limited");                // a failed generation costs no quota
    s.record({ provider: "antigravity", model: "agy-gemini-flash", inputTokens: 1, outputTokens: 1, durationMs: 5, outcome: "ok", source: "http", ts: now - 100 });
    s.record({ provider: "other", model: "other-image", kind: "image", inputTokens: 0, outputTokens: 0, durationMs: 5, outcome: "ok", source: "http", ts: now - 100 });
    expect(s.imageWindow("antigravity", H5, now)).toEqual({ used: 2, windowStartedAt: now - 4 * 3600_000 });
    expect(s.imageWindow("antigravity", 2 * 3600_000, now)).toEqual({ used: 1, windowStartedAt: now - 1000 });
    expect(s.imageWindow("claude", H5, now)).toEqual({ used: 0, windowStartedAt: null });
    s.close();
  });
  it("defaults the image window to five hours and the recorded kind to text", () => {
    const s = new UsageStore(":memory:");
    const now = Date.now();
    s.record({ provider: "antigravity", model: "agy-image", kind: "image", inputTokens: 0, outputTokens: 0, durationMs: 5, outcome: "ok", source: "mcp", ts: now - 1000 });
    s.record({ provider: "antigravity", model: "agy-image", kind: "image", inputTokens: 0, outputTokens: 0, durationMs: 5, outcome: "ok", source: "mcp", ts: now - 6 * 3600_000 });
    s.record({ provider: "antigravity", model: "agy-gemini-flash", inputTokens: 1, outputTokens: 1, durationMs: 5, outcome: "ok", source: "http", ts: now - 1000 });
    expect(s.imageWindow("antigravity")).toEqual({ used: 1, windowStartedAt: now - 1000 });
    s.close();
  });
  // On a real host the store opens a database written before image models
  // existed, whose `calls` table has no `kind` column; CREATE TABLE IF NOT
  // EXISTS leaves it untouched, so only the ALTER TABLE keeps that history
  // readable. A file is needed: `:memory:` is always born with the column.
  it("adds the kind column to a database written before image models existed", () => {
    const dir = mkdtempSync(join(tmpdir(), "capitoline-usage-"));
    const path = join(dir, "usage.sqlite");
    const now = Date.now();
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(`CREATE TABLE calls (
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
        outcome TEXT NOT NULL, source TEXT NOT NULL)`);
      legacy.prepare(`INSERT INTO calls (ts, provider, model, input_tokens, output_tokens, duration_ms, outcome, source)
        VALUES (?, 'antigravity', 'agy-gemini-flash', 10, 2, 5, 'ok', 'http')`).run(now - 1000);
      legacy.close();

      const s = new UsageStore(path);
      s.record({ provider: "antigravity", model: "agy-image", kind: "image", inputTokens: 0, outputTokens: 0, durationMs: 20, outcome: "ok", source: "http", ts: now });
      // The pre-image row is still there and counted as text, so it weighs on
      // the budget but not on the image quota.
      expect(s.totals("antigravity", H5, now + 1).calls).toBe(2);
      expect(s.imageWindow("antigravity", H5, now + 1)).toEqual({ used: 1, windowStartedAt: now });
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A fresh deployment points `db_path` at a directory systemd has not created
  // yet (/var/lib/capitoline/usage.sqlite): without the mkdir the process dies
  // at startup with sqlite's opaque "unable to open database file".
  it("creates the parent directory of a nested database path", () => {
    const dir = mkdtempSync(join(tmpdir(), "capitoline-usage-"));
    const path = join(dir, "var", "lib", "capitoline", "usage.sqlite");
    try {
      const s = new UsageStore(path);
      s.record({ provider: "claude", model: "claude-opus", inputTokens: 1, outputTokens: 1, durationMs: 5, outcome: "ok", source: "http" });
      s.close();
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The production path: a real file, in WAL mode, read back by a second
  // connection — the only way to see that what `record()` writes actually
  // lands on disk, and the only test that looks at the four columns the
  // in-memory ones never read.
  it("writes every column to a real file, readable by a second connection", () => {
    const dir = mkdtempSync(join(tmpdir(), "capitoline-usage-"));
    const path = join(dir, "usage.sqlite");
    const now = 1_000_000_000_000;
    try {
      const s = new UsageStore(path);
      s.record({ provider: "claude", model: "claude-opus-4-6", inputTokens: 120, outputTokens: 34, durationMs: 4321, outcome: "rate_limited", source: "mcp", ts: now });
      s.setWindow("claude", "five_hour", { utilization: 0.25, resetsAt: 1789896000 }, now);
      s.close();

      const other = new DatabaseSync(path);
      try {
        expect((other.prepare(`PRAGMA journal_mode`).get() as { journal_mode: string }).journal_mode).toBe("wal");
        expect(other.prepare(`SELECT ts, provider, model, input_tokens, output_tokens, duration_ms, outcome, source, kind FROM calls`).all()).toEqual([
          { ts: now, provider: "claude", model: "claude-opus-4-6", input_tokens: 120, output_tokens: 34, duration_ms: 4321, outcome: "rate_limited", source: "mcp", kind: "text" },
        ]);
        expect(other.prepare(`SELECT provider, window, utilization, resets_at, updated_at FROM rate_windows`).all()).toEqual([
          { provider: "claude", window: "five_hour", utilization: 0.25, resets_at: 1789896000, updated_at: now },
        ]);
      } finally {
        other.close();
      }

      // Reopening the same file keeps the history and still reads it back.
      const again = new UsageStore(path);
      expect(again.totals("claude", H5, now + 1)).toEqual({ calls: 1, inputTokens: 120, outputTokens: 34 });
      expect(again.windows("claude").five_hour).toEqual({ utilization: 0.25, resetsAt: 1789896000, updatedAt: now });
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // SIGTERM followed by SIGINT closes the store twice; node:sqlite throws on
  // the second close, which would turn a clean shutdown into a crash.
  it("closes idempotently", () => {
    const s = new UsageStore(":memory:");
    s.close();
    expect(() => s.close()).not.toThrow();
  });

  // Every request records a row and reads the budget windows: the SQL must be
  // compiled once, in the constructor, not on every call.
  it("compiles its statements once and reuses them", () => {
    const s = new UsageStore(":memory:");
    const spy = vi.spyOn(DatabaseSync.prototype, "prepare");
    try {
      const now = Date.now();
      s.record({ provider: "claude", model: "claude-opus", inputTokens: 1, outputTokens: 1, durationMs: 5, outcome: "ok", source: "http", ts: now });
      s.record({ provider: "claude", model: "claude-opus", kind: "image", inputTokens: 1, outputTokens: 1, durationMs: 5, outcome: "ok", source: "http", ts: now });
      s.totals("claude", H5, now + 1);
      s.imageWindow("claude", H5, now + 1);
      s.setWindow("claude", "five_hour", { utilization: 0.1, resetsAt: 1 }, now);
      s.windows("claude");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      s.close();
    }
  });
});
