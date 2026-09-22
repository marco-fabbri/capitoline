import { createServer, connect, type AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { start, SHUTDOWN_GRACE_MS } from "../src/main.js";
import { UsageStore } from "../src/usage/store.js";
import { FakeProvider } from "./fake-provider.js";
import type { ProviderEvent } from "../src/core/types.js";

const CONFIG = "test/e2e.config.yaml";
/** The line configWithSandbox() replaces; kept next to CONFIG so the two are read together. */
const SANDBOX_ROOT_LINE = "sandbox_root: tmp/capitoline-e2e";

/** A port nobody is listening on, obtained by binding and releasing one. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address() as AddressInfo; s.close(() => resolve(port)); });
  });
}

/** Holds a port for the duration of a test, so a second listener must fail. */
function occupy(): Promise<{ port: number; release: () => Promise<void> }> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => resolve({
      port: (s.address() as AddressInfo).port,
      release: () => new Promise<void>((r) => s.close(() => r())),
    }));
  });
}

/**
 * The instant the port first accepts a TCP connection. Polling, not a single
 * attempt: the point is to observe the transition from refused to accepted
 * while `start()` is still running.
 */
async function firstAccept(port: number, timeoutMs = 10_000): Promise<number> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = connect({ port, host: "127.0.0.1" });
      s.once("connect", () => { s.destroy(); resolve(true); });
      s.once("error", () => { s.destroy(); resolve(false); });
    });
    if (ok) return performance.now();
    if (performance.now() > deadline) throw new Error(`port ${port} never accepted a connection`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A copy of the e2e configuration with `usage.db_path` pointing at a real file. */
function configWithDbFile(): { path: string; db: string } {
  const dir = mkdtempSync(join(tmpdir(), "capitoline-main-"));
  const db = join(dir, "usage.sqlite");
  const path = join(dir, "config.yaml");
  const text = readFileSync(CONFIG, "utf8");
  const out = text.replace(`db_path: ":memory:"`, `db_path: "${db}"`);
  // A literal that stopped matching would leave the shared configuration in
  // place — the in-memory database here, the shared sandbox root below — and
  // the test would then fail for another reason, after having worked on it.
  expect(out).not.toBe(text);
  writeFileSync(path, out);
  return { path, db };
}

/** A copy of the e2e configuration with a sandbox root of its own. */
function configWithSandbox(): { path: string; sandboxRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), "capitoline-sweep-"));
  const sandboxRoot = join(dir, "sandboxes");
  mkdirSync(sandboxRoot);
  const path = join(dir, "config.yaml");
  const text = readFileSync(CONFIG, "utf8");
  const out = text.replace(SANDBOX_ROOT_LINE, `sandbox_root: ${sandboxRoot}`);
  expect(out).not.toBe(text);
  writeFileSync(path, out);
  return { path, sandboxRoot };
}

const OK: ProviderEvent[] = [{ type: "text", delta: "ok" }, { type: "done", usage: { input: 1, output: 1 } }];

describe("start()", () => {
  it("rejects with a readable error when the port is taken", async () => {
    const taken = await occupy();
    try {
      const p = new FakeProvider("claude", ["claude-opus"], OK);
      await expect(start(CONFIG, { port: taken.port, providers: [p] })).rejects.toThrow(
        new RegExp(`cannot listen on 127\\.0\\.0\\.1:${taken.port}.*EADDRINUSE`),
      );
    } finally { await taken.release(); }
  });

  it("closes the usage store when the start fails", async () => {
    const { path, db } = configWithDbFile();
    const taken = await occupy();
    try {
      const p = new FakeProvider("claude", ["claude-opus"], OK);
      await expect(start(path, { port: taken.port, providers: [p] })).rejects.toThrow(/cannot listen/);
      // The WAL sidecar exists exactly while a connection is open, so its
      // absence is the observable proof that the sqlite handle was released
      // rather than leaked by the rejected start().
      expect(existsSync(db)).toBe(true);
      expect(existsSync(`${db}-wal`)).toBe(false);
    } finally { await taken.release(); }
  });

  // retry once: freePort() releases the port before start() takes it, so another
  // process can slip in between the two and the run fails with EADDRINUSE.
  it("accepts connections before the first health check and answers 503 until it lands", { retry: 1 }, async () => {
    const port = await freePort();
    const p = new FakeProvider("claude", ["claude-opus"], OK);
    let healthFinishedAt = 0;
    let land = () => {};
    const landed = new Promise<void>((r) => { land = r; });
    p.health = async () => {
      await landed;
      healthFinishedAt = performance.now();
      return { ok: false, kind: "cli_crashed", checkedAt: Date.now() };
    };

    const starting = start(CONFIG, { port, providers: [p] });
    // Raced, so a start() that fails for an unrelated reason surfaces as itself
    // instead of as "the port never accepted a connection" ten seconds later.
    const guard = starting.then(() => { throw new Error("start() resolved before the port accepted a connection"); });
    const acceptedAt = await Promise.race([firstAccept(port), guard]);
    void guard.catch(() => {});   // the race is decided; the guard must not resurface as an unhandled rejection

    // The socket is open while the check is still blocked: a CLI that takes a
    // minute to answer cannot turn a restart into connection-refused.
    expect(healthFinishedAt).toBe(0);
    const early = await fetch(`http://127.0.0.1:${port}/v1/models`);
    expect(early.status).toBe(503);
    expect(early.headers.get("retry-after")).toBe("5");
    expect((await early.json() as { error: { code: string } }).error.code).toBe("model_unavailable");
    // /health is never gated: the local monitor must see the startup.
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);

    land();
    const app = await starting;
    try {
      expect(healthFinishedAt).toBeGreaterThan(acceptedAt);
      // The check landed unhealthy, so the model is gone from the listing
      // rather than being offered and answering 502.
      const r = await fetch(`http://127.0.0.1:${app.port}/v1/models`);
      expect(((await r.json()) as { data: unknown[] }).data).toEqual([]);
    } finally { await app.close(); }
  });

  it("brings a stored pause back before the first health check", async () => {
    const { path, db } = configWithDbFile();
    const seed = new UsageStore(db);
    // A quota refusal that reopens in days, of the shape the host saw: without
    // the restore the model would be offered again and the first request would
    // spend a call to rediscover it.
    seed.setPause("claude", "claude-fable", Date.now() + 5 * 24 * 3600_000, 1);
    seed.close();
    const p = new FakeProvider("claude", ["claude-opus", "claude-fable"], OK);
    // The probe runs the paused model itself, which is the case the ordering is
    // for: the refusal is on record, so the check must not go and collect it
    // again. healthCalls is what makes the order observable — the listing below
    // is the same whether restorePauses() ran before or after checkHealth().
    p.healthModel = "claude-fable";
    const app = await start(path, { port: 0, providers: [p] });
    try {
      expect(p.healthCalls).toBe(0);
      const r = await fetch(`http://127.0.0.1:${app.port}/v1/models`);
      expect(((await r.json()) as { data: { id: string }[] }).data.map((m) => m.id)).toEqual(["claude-opus"]);
    } finally { await app.close(); }
  });

  it("sweeps the sandboxes left behind by an earlier run, measured on the longest timeout", async () => {
    const { path, sandboxRoot } = configWithSandbox();
    const old = new Date(Date.now() - 10 * 60 * 1000);
    const recent = new Date(Date.now() - 100 * 1000);
    for (const [name, when] of [["run-old", old], ["run-recent", recent]] as const) {
      mkdirSync(join(sandboxRoot, name));
      utimesSync(join(sandboxRoot, name), when, when);
    }
    const p = new FakeProvider("claude", ["claude-opus"], OK);
    const app = await start(path, { port: 0, providers: [p] });
    try {
      // 100 s is past every text timeout of the configuration (10 s) but well
      // inside the image model's 240 s, so a run still in flight survives a
      // restart of the gateway while a leaked one does not.
      expect(readdirSync(sandboxRoot)).toEqual(["run-recent"]);
    } finally { await app.close(); }
  });
});

describe("start() with a host overlay", () => {
  /** An overlay written to a directory of its own, next to the database it points at. */
  function overlay(body: (db: string) => string): { path: string; db: string } {
    const dir = mkdtempSync(join(tmpdir(), "capitoline-overlay-"));
    const db = join(dir, "usage.sqlite");
    const path = join(dir, "overlay.yaml");
    writeFileSync(path, body(db));
    return { path, db };
  }

  it("merges the overlay over the configuration it is given", async () => {
    // usage.db_path is the observable one: the e2e configuration keeps the
    // store in memory, so a file on disk can only come from the overlay.
    const { path, db } = overlay((f) => `usage:\n  db_path: "${f}"\n`);
    const p = new FakeProvider("claude", ["claude-opus"], OK);
    const app = await start(CONFIG, { port: 0, providers: [p], overlayPath: path });
    try {
      expect(existsSync(db)).toBe(true);
    } finally { await app.close(); }
  });

  it("takes the overlay from CAPITOLINE_OVERLAY when none is passed", async () => {
    // What the systemd unit sets, and the only path the deployed service uses.
    const { path, db } = overlay((f) => `usage:\n  db_path: "${f}"\n`);
    const before = process.env.CAPITOLINE_OVERLAY;
    process.env.CAPITOLINE_OVERLAY = path;
    const p = new FakeProvider("claude", ["claude-opus"], OK);
    try {
      const app = await start(CONFIG, { port: 0, providers: [p] });
      try {
        expect(existsSync(db)).toBe(true);
      } finally { await app.close(); }
    } finally {
      if (before === undefined) delete process.env.CAPITOLINE_OVERLAY;
      else process.env.CAPITOLINE_OVERLAY = before;
    }
  });

  it("refuses to start when the overlay names a file that is not there", async () => {
    // Loud, like every other configuration mistake: the alternative is a
    // gateway running on the repository's own paths and user.
    const absent = join(mkdtempSync(join(tmpdir(), "capitoline-overlay-")), "absent.yaml");
    const p = new FakeProvider("claude", ["claude-opus"], OK);
    await expect(start(CONFIG, { port: 0, providers: [p], overlayPath: absent })).rejects.toThrow(absent);
  });

  it("treats an empty CAPITOLINE_OVERLAY as no overlay at all", async () => {
    // `Environment=CAPITOLINE_OVERLAY=` in a unit, or an empty export in a
    // shell, is the natural way to turn the overlay off — and an empty string
    // is not undefined, so without normalising it the service dies on a
    // readFileSync("") whose message names no file.
    const before = process.env.CAPITOLINE_OVERLAY;
    process.env.CAPITOLINE_OVERLAY = "";
    const p = new FakeProvider("claude", ["claude-opus"], OK);
    try {
      const app = await start(CONFIG, { port: 0, providers: [p] });
      try {
        const r = await fetch(`http://127.0.0.1:${app.port}/v1/models`);
        expect(((await r.json()) as { data: { id: string }[] }).data.map((m) => m.id)).toEqual(["claude-opus"]);
      } finally { await app.close(); }
    } finally {
      if (before === undefined) delete process.env.CAPITOLINE_OVERLAY;
      else process.env.CAPITOLINE_OVERLAY = before;
    }
  });

  it("logs which files were loaded and the overlay's keys, never its values", async () => {
    // The requirement the startup line exists for: `server.access.audience` is
    // not a secret, but a log that prints the overlay's values is a habit this
    // one does not start, and a host that extends the overlay decides what ends
    // up in the journal. The database path is the sentinel: it is a value the
    // overlay sets, and it must appear nowhere in the line.
    const dir = mkdtempSync(join(tmpdir(), "capitoline-overlay-"));
    const db = join(dir, "sentinel-db.sqlite");
    const path = join(dir, "overlay.yaml");
    writeFileSync(path, `usage:\n  db_path: "${db}"\nrunner:\n  user: null\n`);
    const lines: string[] = [];
    const p = new FakeProvider("claude", ["claude-opus"], OK);
    const app = await start(CONFIG, { port: 0, providers: [p], overlayPath: path, logDest: { write: (chunk: string) => { lines.push(chunk); } } });
    try {
      const loaded = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === "configuration loaded");
      expect(loaded).toBeDefined();
      expect(loaded).toMatchObject({ config: CONFIG, overlay: path, overlayKeys: ["usage.db_path", "runner.user"] });
      // Every line, not only that one: the whole startup output is the journal.
      expect(lines.join("")).not.toContain("sentinel-db");
    } finally { await app.close(); }
  });

  it("starts as it does today when no overlay is named", async () => {
    const before = process.env.CAPITOLINE_OVERLAY;
    delete process.env.CAPITOLINE_OVERLAY;
    const p = new FakeProvider("claude", ["claude-opus"], OK);
    try {
      const app = await start(CONFIG, { port: 0, providers: [p] });
      try {
        const r = await fetch(`http://127.0.0.1:${app.port}/v1/models`);
        expect(((await r.json()) as { data: { id: string }[] }).data.map((m) => m.id)).toEqual(["claude-opus"]);
      } finally { await app.close(); }
    } finally { if (before !== undefined) process.env.CAPITOLINE_OVERLAY = before; }
  });
});

describe("close()", () => {
  it("waits five seconds for an in-flight response by default", () => {
    // Pinned: every other test here overrides the grace, so a production value
    // of 0 (every SSE stream destroyed the instant SIGTERM arrives) would
    // otherwise keep the suite green.
    expect(SHUTDOWN_GRACE_MS).toBe(5000);
  });

  it("resolves while an SSE response is still open", async () => {
    // Long enough that the stream cannot end by itself within the assertion.
    const script: ProviderEvent[] = Array.from({ length: 200 }, () => ({ type: "text", delta: "x" }) as ProviderEvent);
    script.push({ type: "done", usage: { input: 1, output: 1 } });
    const p = new FakeProvider("claude", ["claude-opus"], script);
    p.delayMs = 50;
    const app = await start(CONFIG, { port: 0, providers: [p], shutdownGraceMs: 100 });

    const r = await fetch(`http://127.0.0.1:${app.port}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(200);
    const reader = r.body!.getReader();
    await reader.read();   // the connection is now active, not idle

    const t0 = performance.now();
    await app.close();
    expect(performance.now() - t0).toBeLessThan(3000);
    await reader.cancel().catch(() => {});
  });

  it("returns the same promise when called twice", async () => {
    const p = new FakeProvider("claude", ["claude-opus"], OK);
    const app = await start(CONFIG, { port: 0, providers: [p], shutdownGraceMs: 100 });
    // Identity, not just "both resolve": a second shutdown must join the first
    // one, and only the memoized promise proves the store is closed once.
    const first = app.close();
    expect(app.close()).toBe(first);
    await expect(first).resolves.toBeUndefined();
  });
});
