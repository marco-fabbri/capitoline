import { createServer, connect, type AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { start, SHUTDOWN_GRACE_MS } from "../src/main.js";
import { FakeProvider } from "./fake-provider.js";
import type { ProviderEvent } from "../src/core/types.js";

const CONFIG = "test/e2e.config.yaml";

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
  writeFileSync(path, readFileSync(CONFIG, "utf8").replace(`db_path: ":memory:"`, `db_path: "${db}"`));
  return { path, db };
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
