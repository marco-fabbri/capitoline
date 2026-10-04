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
      s.record({ provider: "antigravity", model: "antigravity-image", kind: "image", inputTokens: 0, outputTokens: 0, durationMs: 20_000, outcome, source: "http", ts });
    img(now - 6 * 3600_000, "ok");                 // before the window
    img(now - 4 * 3600_000, "ok");                 // the window opens here
    img(now - 1000, "ok");
    img(now - 500, "rate_limited");                // a failed generation costs no quota
    s.record({ provider: "antigravity", model: "antigravity-gemini-flash", inputTokens: 1, outputTokens: 1, durationMs: 5, outcome: "ok", source: "http", ts: now - 100 });
    s.record({ provider: "other", model: "other-image", kind: "image", inputTokens: 0, outputTokens: 0, durationMs: 5, outcome: "ok", source: "http", ts: now - 100 });
    expect(s.imageWindow("antigravity", H5, now)).toEqual({ used: 2, windowStartedAt: now - 4 * 3600_000 });
    expect(s.imageWindow("antigravity", 2 * 3600_000, now)).toEqual({ used: 1, windowStartedAt: now - 1000 });
    expect(s.imageWindow("claude", H5, now)).toEqual({ used: 0, windowStartedAt: null });
    s.close();
  });
  it("defaults the image window to five hours and the recorded kind to text", () => {
    const s = new UsageStore(":memory:");
    const now = Date.now();
    s.record({ provider: "antigravity", model: "antigravity-image", kind: "image", inputTokens: 0, outputTokens: 0, durationMs: 5, outcome: "ok", source: "mcp", ts: now - 1000 });
    s.record({ provider: "antigravity", model: "antigravity-image", kind: "image", inputTokens: 0, outputTokens: 0, durationMs: 5, outcome: "ok", source: "mcp", ts: now - 6 * 3600_000 });
    s.record({ provider: "antigravity", model: "antigravity-gemini-flash", inputTokens: 1, outputTokens: 1, durationMs: 5, outcome: "ok", source: "http", ts: now - 1000 });
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
        VALUES (?, 'antigravity', 'antigravity-gemini-flash', 10, 2, 5, 'ok', 'http')`).run(now - 1000);
      legacy.close();

      const s = new UsageStore(path);
      s.record({ provider: "antigravity", model: "antigravity-image", kind: "image", inputTokens: 0, outputTokens: 0, durationMs: 20, outcome: "ok", source: "http", ts: now });
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

  // B4: the row says who asked. `caller` is nullable because "nobody said"
  // is a real state — Access verification disabled, and every health probe.
  it("records the caller of a call, and null when there is none", () => {
    const dir = mkdtempSync(join(tmpdir(), "capitoline-usage-"));
    const path = join(dir, "usage.sqlite");
    const now = 1_000_000_000_000;
    try {
      const s = new UsageStore(path);
      s.record({ provider: "claude", model: "claude-opus", inputTokens: 1, outputTokens: 1, durationMs: 5, outcome: "ok", source: "http", caller: "me@example.com", ts: now });
      s.record({ provider: "claude", model: "claude-opus", inputTokens: 1, outputTokens: 1, durationMs: 5, outcome: "ok", source: "http", ts: now + 1 });
      s.record({ provider: "claude", model: "claude-opus", inputTokens: 1, outputTokens: 1, durationMs: 5, outcome: "ok", source: "http", caller: null, ts: now + 2 });
      s.close();

      const other = new DatabaseSync(path);
      try {
        expect(other.prepare(`SELECT caller FROM calls ORDER BY id`).all()).toEqual([{ caller: "me@example.com" }, { caller: null }, { caller: null }]);
      } finally {
        other.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 2026-09-23: `opus` moved from Opus 5 to Opus 5.5 with no configuration
  // changed, and nothing in the history said which one any measurement used.
  it("records the dated id of the model that answered, and null when the CLI said nothing", () => {
    const s = new UsageStore(":memory:");
    const now = 1_000_000_000_000;
    s.record({ provider: "claude", model: "claude-opus", inputTokens: 1, outputTokens: 1, durationMs: 5, outcome: "ok", source: "http", cliModelId: "claude-opus-5", ts: now - 3 * 24 * 3600_000 });
    s.record({ provider: "claude", model: "claude-opus", inputTokens: 1, outputTokens: 1, durationMs: 5, outcome: "ok", source: "http", cliModelId: "claude-opus-5-5", ts: now - 1000 });
    s.record({ provider: "claude", model: "claude-opus", inputTokens: 1, outputTokens: 1, durationMs: 5, outcome: "ok", source: "http", cliModelId: "claude-opus-5-5", ts: now });
    // Codex and Antigravity report nothing, and null is the honest value: the
    // listing leaves them out rather than adding a row that says "as always".
    s.record({ provider: "codex", model: "codex-gpt-5.5", inputTokens: 1, outputTokens: 1, durationMs: 5, outcome: "ok", source: "http", ts: now });

    // Two rows under one gateway name is the reading the column exists for.
    expect(s.modelIdentities(7 * 24 * 3600_000, now)).toEqual([
      { model: "claude-opus", cliModelId: "claude-opus-5", calls: 1, firstAt: now - 3 * 24 * 3600_000, lastAt: now - 3 * 24 * 3600_000 },
      { model: "claude-opus", cliModelId: "claude-opus-5-5", calls: 2, firstAt: now - 1000, lastAt: now },
    ]);
    // A window that predates the change shows one model and no history.
    expect(s.modelIdentities(3600_000, now).map((r) => r.cliModelId)).toEqual(["claude-opus-5-5"]);
    s.close();
  });

  it("adds the model id column to a database written before it existed", () => {
    // The store upgrades in place: three columns were added this way before
    // (kind, caller, deliberation) and the history is kept, not rebuilt.
    const dir = mkdtempSync(join(tmpdir(), "capitoline-usage-"));
    const path = join(dir, "usage.sqlite");
    const now = 1_000_000_000_000;
    try {
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE calls (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
        outcome TEXT NOT NULL, source TEXT NOT NULL)`);
      old.prepare(`INSERT INTO calls (ts, provider, model, input_tokens, output_tokens, duration_ms, outcome, source) VALUES (?,?,?,?,?,?,?,?)`)
        .run(now - 1000, "claude", "claude-opus", 1, 1, 5, "ok", "http");
      old.close();

      const s = new UsageStore(path);
      s.record({ provider: "claude", model: "claude-opus", inputTokens: 1, outputTokens: 1, durationMs: 5, outcome: "ok", source: "http", cliModelId: "claude-opus-5-5", ts: now });
      // The old row is still there and says nothing, which is true of it.
      expect(s.totals("claude", 3600_000, now).calls).toBe(2);
      expect(s.modelIdentities(3600_000, now)).toEqual([
        { model: "claude-opus", cliModelId: "claude-opus-5-5", calls: 1, firstAt: now, lastAt: now },
      ]);
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // What /health answers: who spent the window. The gateway's own health
  // probes are not a caller and would swamp the null row (45 of the first 56
  // calls on the host were health checks), so they are left out.
  it("breaks a window down by caller, without its own health probes", () => {
    const s = new UsageStore(":memory:");
    const now = 1_000_000_000_000;
    const call = (caller: string | null, ts: number, input: number, source: "http" | "mcp" = "http") =>
      s.record({ provider: "claude", model: "claude-opus", inputTokens: input, outputTokens: 1, durationMs: 5, outcome: "ok", source, caller, ts });
    call("me@example.com", now - 1000, 10);
    call("me@example.com", now - 2000, 20, "mcp");
    call("svc-token", now - 3000, 5);
    call(null, now - 4000, 1);
    call("me@example.com", now - 25 * 3600_000, 999);   // outside the window
    s.record({ provider: "claude", model: "health", inputTokens: 0, outputTokens: 0, durationMs: 0, outcome: "ok", source: "health", ts: now - 100 });
    expect(s.callers(24 * 3600_000, now)).toEqual([
      { caller: "me@example.com", calls: 2, inputTokens: 30, outputTokens: 2 },
      { caller: null, calls: 1, inputTokens: 1, outputTokens: 1 },
      { caller: "svc-token", calls: 1, inputTokens: 5, outputTokens: 1 },
    ]);
    // The window is open at the far end, `ts > now - sinceMs`, as totals() is.
    expect(s.callers(1500, now)).toEqual([{ caller: "me@example.com", calls: 1, inputTokens: 10, outputTokens: 1 }]);
    s.close();
  });

  // The same upgrade for the cached share of the input: the rows written
  // before carry none, which prices their input whole (src/usage/costs.ts).
  it("adds the cached input column to a database written before it was kept, and sums what a caller spent on a model", () => {
    const dir = mkdtempSync(join(tmpdir(), "capitoline-usage-"));
    const path = join(dir, "usage.sqlite");
    const now = Date.now();
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(`CREATE TABLE calls (
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
        outcome TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text', caller TEXT)`);
      legacy.prepare(`INSERT INTO calls (ts, provider, model, input_tokens, output_tokens, duration_ms, outcome, source, caller)
        VALUES (?, 'claude', 'claude-opus', 10, 2, 5, 'ok', 'http', 'app-one')`).run(now - 1000);
      legacy.close();

      const s = new UsageStore(path);
      s.record({ provider: "claude", model: "claude-opus", inputTokens: 30, cachedInputTokens: 20, outputTokens: 1, durationMs: 5, outcome: "timeout", source: "http", caller: "app-one", ts: now });
      s.record({ provider: "claude", model: "claude-opus", inputTokens: 7, outputTokens: 1, costUsd: 0.25, durationMs: 5, outcome: "ok", source: "http", caller: "app-one", ts: now });
      s.record({ provider: "claude", model: "claude-opus", inputTokens: 99, outputTokens: 9, durationMs: 5, outcome: "ok", source: "health", ts: now });
      expect(s.spend(H5, now + 1)).toEqual([
        { caller: "app-one", provider: "claude", model: "claude-opus", kind: "text", calls: 3, ok: 2, inputTokens: 47, cachedInputTokens: 20, outputTokens: 4,
          // The call whose cost the CLI reported is counted apart from the two a price list has to cost.
          reportedCalls: 1, reportedCost: 0.25, firstAt: now - 1000, lastAt: now, unreported: { ok: 1, inputTokens: 40, cachedInputTokens: 20, outputTokens: 3 } },
      ]);
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The deployed database was written before attribution existed: its `calls`
  // table has no `caller` column and CREATE TABLE IF NOT EXISTS leaves it
  // alone, so only the ALTER TABLE keeps that history readable.
  it("adds the caller column to a database written before attribution existed", () => {
    const dir = mkdtempSync(join(tmpdir(), "capitoline-usage-"));
    const path = join(dir, "usage.sqlite");
    const now = Date.now();
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(`CREATE TABLE calls (
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
        outcome TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text')`);
      legacy.prepare(`INSERT INTO calls (ts, provider, model, input_tokens, output_tokens, duration_ms, outcome, source)
        VALUES (?, 'claude', 'claude-opus', 10, 2, 5, 'ok', 'http')`).run(now - 1000);
      legacy.close();

      const s = new UsageStore(path);
      s.record({ provider: "claude", model: "claude-opus", inputTokens: 3, outputTokens: 1, durationMs: 5, outcome: "ok", source: "http", caller: "me@example.com", ts: now });
      // The old row is kept, and its unknown caller is the same null a call
      // with Access disabled writes today.
      expect(s.callers(H5, now + 1)).toEqual([
        { caller: null, calls: 1, inputTokens: 10, outputTokens: 2 },
        { caller: "me@example.com", calls: 1, inputTokens: 3, outputTokens: 1 },
      ]);
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A pause was the one piece of provider state living only in memory: a quota
  // refusal that reopens in days was rediscovered by a real call after every
  // restart (backlog, observed on the host 2026-09-22).
  it("stores a pause per provider and per model and returns the ones still standing", () => {
    const s = new UsageStore(":memory:");
    const now = 1_000_000_000_000;
    s.setPause("antigravity", null, now + 60_000, 1, now);
    s.setPause("antigravity", "antigravity-image", now + 5 * 24 * 3600_000, 2, now);
    s.setPause("claude", "claude-fable", now + 3600_000, 3, now);
    // A provider-wide pause and one of that provider's models coexist, as they
    // do in memory: sqlite orders the null model first.
    expect(s.pauses(now)).toEqual([
      { provider: "antigravity", model: null, until: now + 60_000, strikes: 1, announcedAt: null },
      { provider: "antigravity", model: "antigravity-image", until: now + 5 * 24 * 3600_000, strikes: 2, announcedAt: null },
      { provider: "claude", model: "claude-fable", until: now + 3600_000, strikes: 3, announcedAt: null },
    ]);
    s.close();
  });

  // sqlite allows NULLs inside a PRIMARY KEY and holds two of them distinct, so
  // the provider-wide pause is the case where an upsert silently piles rows up
  // instead of replacing one — and the stale one would come back on a restart.
  it("replaces a pause of the same scope instead of piling rows up", () => {
    const s = new UsageStore(":memory:");
    const now = 1_000_000_000_000;
    s.setPause("a", null, now + 60_000, 1, now);
    s.setPause("a", null, now + 3_660_000, 2, now);
    s.setPause("a", "a-1", now + 60_000, 1, now);
    s.setPause("a", "a-1", now + 120_000, 2, now);
    expect(s.pauses(now)).toEqual([
      { provider: "a", model: null, until: now + 3_660_000, strikes: 2, announcedAt: null },
      { provider: "a", model: "a-1", until: now + 120_000, strikes: 2, announcedAt: null },
    ]);
    s.close();
  });

  it("leaves an expired pause out of the answer and collects it only when asked", () => {
    const s = new UsageStore(":memory:");
    const now = 1_000_000_000_000;
    s.setPause("a", null, now - 1, 4, now - 60_000);
    s.setPause("a", "a-1", now + 1000, 1, now);
    expect(s.pauses(now)).toEqual([{ provider: "a", model: "a-1", until: now + 1000, strikes: 1, announcedAt: null }]);
    // The read destroys nothing: the clock comes from the caller, and one that
    // jumped ahead (a restored snapshot, an NTP step at boot) would otherwise
    // wipe a five-day pause on its way past it, with no trace anywhere.
    expect(s.pauses(now - 120_000)).toEqual([
      { provider: "a", model: null, until: now - 1, strikes: 4, announcedAt: null },
      { provider: "a", model: "a-1", until: now + 1000, strikes: 1, announcedAt: null },
    ]);
    // Collecting them is the separate step, and it says how many it took.
    expect(s.prunePauses(now)).toBe(1);
    expect(s.prunePauses(now)).toBe(0);
    expect(s.pauses(now - 120_000)).toEqual([{ provider: "a", model: "a-1", until: now + 1000, strikes: 1, announcedAt: null }]);
    s.close();
  });

  it("clears one scope of a pause and leaves the other standing", () => {
    const s = new UsageStore(":memory:");
    const now = 1_000_000_000_000;
    s.setPause("a", null, now + 60_000, 1, now);
    s.setPause("a", "a-1", now + 120_000, 2, now);
    s.clearPause("a", null);
    expect(s.pauses(now)).toEqual([{ provider: "a", model: "a-1", until: now + 120_000, strikes: 2, announcedAt: null }]);
    s.clearPause("a", "a-1");
    expect(s.pauses(now)).toEqual([]);
    s.close();
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
      s.callers(H5, now + 1);
      s.setPause("claude", null, now + 60_000, 1, now);
      s.pauses(now);
      s.prunePauses(now);
      s.clearPause("claude", null);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      s.close();
    }
  });
});

describe("UsageStore: the gateway's own keys and caller names", () => {
  it("issues a key once, stores only its hash, and authenticates it by name", () => {
    const s = new UsageStore(":memory:");
    const now = 1_000_000_000_000;
    const { key, name, createdAt } = s.createKey("app-two", "owner@example.com", now);
    expect(name).toBe("app-two");
    expect(createdAt).toBe(now);
    expect(key).toMatch(/^cap_[A-Za-z0-9_-]{43}$/);
    expect(s.authenticateKey(key, now + 5)).toEqual({ name: "app-two" });
    expect(s.authenticateKey("cap_" + "x".repeat(43))).toBeNull();
    expect(s.authenticateKey("not-a-key")).toBeNull();
    // The listing carries what an operator needs and never the secret.
    expect(s.listKeys()).toEqual([{ name: "app-two", createdAt: now, createdBy: "owner@example.com", revokedAt: null, lastUsedAt: now + 5 }]);
    expect(JSON.stringify(s.listKeys())).not.toContain(key.slice(4, 20));
    expect(s.hasKeys()).toBe(true);
    s.close();
  });

  it("refuses a duplicate or malformed name, and revokes without deleting", () => {
    const s = new UsageStore(":memory:");
    s.createKey("app", null);
    expect(() => s.createKey("app", null)).toThrow(/already exists/);
    for (const bad of ["App", "a", "-x", "x".repeat(65), "sp ace"]) expect(() => s.createKey(bad, null), bad).toThrow(/must match/);
    expect(s.revokeKey("app", 42)).toBe(true);
    expect(s.revokeKey("app", 43)).toBe(false);
    expect(s.revokeKey("ghost")).toBe(false);
    expect(s.listKeys()[0]).toMatchObject({ name: "app", revokedAt: 42 });
    expect(s.hasKeys()).toBe(false);
    s.close();
  });

  it("names a caller, and renames it in place", () => {
    const s = new UsageStore(":memory:");
    s.nameCaller("0000000000000000000000000000000a.access", "app-one");
    s.nameCaller("0000000000000000000000000000000a.access", "app-one");
    expect(s.callerNames()).toEqual({ "0000000000000000000000000000000a.access": "app-one" });
    s.close();
  });
});
