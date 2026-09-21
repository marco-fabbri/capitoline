import { createServer, connect, type AddressInfo } from "node:net";
import { describe, it, expect } from "vitest";
import { start } from "../src/main.js";
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

  it("checks provider health before the port accepts a connection", async () => {
    const port = await freePort();
    const p = new FakeProvider("claude", ["claude-opus"], OK);
    let healthFinishedAt = 0;
    p.health = async () => {
      await new Promise((r) => setTimeout(r, 300));
      healthFinishedAt = performance.now();
      return { ok: false, kind: "cli_crashed", checkedAt: Date.now() };
    };

    const starting = start(CONFIG, { port, providers: [p] });
    const acceptedAt = await firstAccept(port);
    const app = await starting;
    try {
      expect(healthFinishedAt).toBeGreaterThan(0);
      // The first connection the port ever accepted came after the health
      // check had already landed: no request can meet a stale "available".
      expect(acceptedAt).toBeGreaterThan(healthFinishedAt);
      const r = await fetch(`http://127.0.0.1:${app.port}/v1/models`);
      expect(((await r.json()) as { data: unknown[] }).data).toEqual([]);
    } finally { await app.close(); }
  });
});

describe("close()", () => {
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

  it("resolves both times when called twice", async () => {
    const p = new FakeProvider("claude", ["claude-opus"], OK);
    const app = await start(CONFIG, { port: 0, providers: [p], shutdownGraceMs: 100 });
    await expect(app.close()).resolves.toBeUndefined();
    await expect(app.close()).resolves.toBeUndefined();
  });
});
