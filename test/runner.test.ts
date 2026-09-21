import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunner } from "../src/runner/runner.js";
import { createLogger } from "../src/log.js";

const FAKE = join(process.cwd(), "test/fake-cli/fake-cli.mjs");
const log = createLogger("test");
const root = mkdtempSync(join(tmpdir(), "capitoline-runner-"));
const runner = createRunner({ sandboxRoot: root, user: null, killGraceMs: 300, log });

async function collect(it: AsyncIterable<string>) { const out: string[] = []; for await (const l of it) out.push(l); return out; }

// Same generator as fake-cli.mjs "emit-bytes" (the fake cannot be imported: it runs on load).
function pseudoRandomBytes(n: number, seed = 0x9e3779b9): Buffer {
  const out = Buffer.alloc(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

describe("runner", () => {
  it("writes stdin, streams stdout lines, removes the sandbox", async () => {
    const h = await runner.run({ binary: FAKE, args: ["--mode", "stdin-len"], stdin: "hello", timeoutMs: 5000 });
    expect(existsSync(h.sandboxDir)).toBe(true);
    const lines = await collect(h.lines);
    const r = await h.result;
    expect(lines).toEqual(['{"stdin_length":5}']);
    expect(r.exitCode).toBe(0);
    expect(existsSync(h.sandboxDir)).toBe(false);
  });
  it("closes stdin when null so the child does not block", async () => {
    const h = await runner.run({ binary: FAKE, args: ["--mode", "stdin-len"], stdin: null, timeoutMs: 5000 });
    expect(await collect(h.lines)).toEqual(['{"stdin_length":0}']);
    await h.result;
  });
  it("runs in an empty sandbox directory containing only the given files", async () => {
    const h = await runner.run({ binary: FAKE, args: ["--mode", "cwd"], stdin: null, timeoutMs: 5000, files: [{ name: "img.png", bytes: Buffer.from("x") }] });
    const [line] = await collect(h.lines);
    await h.result;
    const parsed = JSON.parse(line);
    expect(parsed.cwd).toBe(h.sandboxDir);
    expect(parsed.files).toEqual(["img.png"]);
  });
  it("kills a hanging process at the timeout and reports it", async () => {
    const t0 = Date.now();
    const h = await runner.run({ binary: FAKE, args: ["--mode", "hang"], stdin: null, timeoutMs: 500 });
    await collect(h.lines);
    const r = await h.result;
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(existsSync(h.sandboxDir)).toBe(false);
  });
  it("kills the process when the signal aborts", async () => {
    const ac = new AbortController();
    const h = await runner.run({ binary: FAKE, args: ["--mode", "hang"], stdin: null, timeoutMs: 10000, signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    await collect(h.lines);
    const r = await h.result;
    expect(r.aborted).toBe(true);
    expect(existsSync(h.sandboxDir)).toBe(false);
  });
  it("does not run the process when the signal is already aborted", async () => {
    const t0 = Date.now();
    const ac = new AbortController();
    ac.abort();
    const h = await runner.run({ binary: FAKE, args: ["--mode", "hang"], stdin: null, timeoutMs: 10000, signal: ac.signal });
    expect(await collect(h.lines)).toEqual([]);
    const r = await h.result;
    expect(r.aborted).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(existsSync(h.sandboxDir)).toBe(false);
  });
  it("keeps lines emitted before the consumer starts iterating", async () => {
    const h = await runner.run({ binary: FAKE, args: ["--mode", "slow"], stdin: null, timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 450));
    const lines = await collect(h.lines);
    await h.result;
    expect(lines).toEqual(['{"i":0}', '{"i":1}', '{"i":2}', '{"i":3}', '{"i":4}']);
  });
  it("rejects attachment names that escape the sandbox", async () => {
    await expect(
      runner.run({ binary: FAKE, args: ["--mode", "cwd"], stdin: null, timeoutMs: 5000, files: [{ name: "../evil.txt", bytes: Buffer.from("x") }] }),
    ).rejects.toThrow(/invalid attachment name/);
    expect(existsSync(join(root, "..", "evil.txt"))).toBe(false);
  });
  it("keeps only the last 64 KiB of stderr", async () => {
    const h = await runner.run({ binary: FAKE, args: ["--mode", "big-stderr"], stdin: null, timeoutMs: 5000 });
    await collect(h.lines);
    const r = await h.result;
    expect(r.exitCode).toBe(0);
    expect(r.stderr.length).toBe(64 * 1024);
    expect(r.stderr.endsWith("000019999\nEND\n")).toBe(true);
    expect(r.stderr).not.toContain("000000000\n");
  });
  it("reports exit code and captured stderr on crash", async () => {
    const h = await runner.run({ binary: FAKE, args: ["--mode", "crash"], stdin: null, timeoutMs: 5000 });
    await collect(h.lines);
    const r = await h.result;
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("boom");
  });
  it("reports a missing binary as a failed run, not an exception", async () => {
    const h = await runner.run({ binary: "/nonexistent/binary", args: [], stdin: null, timeoutMs: 5000 });
    await collect(h.lines);
    const r = await h.result;
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/ENOENT|spawn/);
  });
});

describe("runner.capture", () => {
  it("returns the whole stdout as bytes, byte for byte, without a sandbox", async () => {
    const before = readdirSync(root).length;
    const r = await runner.capture({ binary: FAKE, args: ["--mode", "emit-bytes", "--bytes", "300000"], timeoutMs: 5000, maxBytes: 1024 * 1024 });
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.stdout.length).toBe(300_000);
    expect(r.stdout.equals(pseudoRandomBytes(300_000))).toBe(true);
    expect(readdirSync(root).length).toBe(before);
  });
  it("kills the child once stdout exceeds maxBytes and does not report success", async () => {
    const t0 = Date.now();
    const r = await runner.capture({ binary: FAKE, args: ["--mode", "emit-bytes", "--bytes", "4000000"], timeoutMs: 10000, maxBytes: 64 * 1024 });
    expect(r.exitCode).not.toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.stdout.length).toBeLessThanOrEqual(64 * 1024);
    expect(r.stderr).toMatch(/exceeded 65536 bytes/);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  it("reports a non-zero exit code and the captured stderr", async () => {
    const r = await runner.capture({ binary: FAKE, args: ["--mode", "crash"], timeoutMs: 5000, maxBytes: 1024 });
    expect(r.exitCode).toBe(2);
    expect(r.stdout.length).toBe(0);
    expect(r.stderr).toContain("boom");
  });
  it("kills a hanging process at the timeout and reports it", async () => {
    const t0 = Date.now();
    const r = await runner.capture({ binary: FAKE, args: ["--mode", "hang"], timeoutMs: 500, maxBytes: 1024 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
  it("reports a missing binary as a failed capture, not an exception", async () => {
    const r = await runner.capture({ binary: "/nonexistent/binary", args: [], timeoutMs: 5000, maxBytes: 1024 });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/ENOENT|spawn/);
  });
});

describe("runner.sweep", () => {
  /** A sandbox root of its own: the sweep looks at every entry of the directory. */
  function sweptRunner() {
    const dir = mkdtempSync(join(tmpdir(), "capitoline-sweep-"));
    return { dir, runner: createRunner({ sandboxRoot: dir, user: null, killGraceMs: 300, log }) };
  }
  /** Moves an entry's mtime into the past; the sweep decides on mtime, not on the name. */
  function age(path: string, ms: number) {
    const t = (Date.now() - ms) / 1000;
    utimesSync(path, t, t);
  }

  it("removes the sandboxes older than the given age and keeps the fresh ones", async () => {
    const { dir, runner: r } = sweptRunner();
    mkdirSync(join(dir, "run-old"));
    writeFileSync(join(dir, "run-old", "prompt.txt"), "x");   // not empty: the removal must be recursive
    age(join(dir, "run-old"), 10 * 60 * 1000);
    mkdirSync(join(dir, "run-fresh"));

    expect(await r.sweep(5 * 60 * 1000)).toEqual(["run-old"]);
    expect(readdirSync(dir)).toEqual(["run-fresh"]);
  });

  it("leaves alone what is not a sandbox, however old", async () => {
    const { dir, runner: r } = sweptRunner();
    mkdirSync(join(dir, "keep-me"));
    age(join(dir, "keep-me"), 10 * 60 * 1000);
    writeFileSync(join(dir, "run-loose.txt"), "x");           // a file, not a run directory
    age(join(dir, "run-loose.txt"), 10 * 60 * 1000);

    expect(await r.sweep(5 * 60 * 1000)).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(["keep-me", "run-loose.txt"]);
  });

  it("reports nothing instead of throwing when the sandbox root does not exist", async () => {
    const { dir, runner: r } = sweptRunner();
    rmSync(dir, { recursive: true });
    await expect(r.sweep(5 * 60 * 1000)).resolves.toEqual([]);
  });
});
