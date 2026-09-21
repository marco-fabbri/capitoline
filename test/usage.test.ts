import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
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
});
