import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunner } from "../src/runner/runner.js";
import { createLogger } from "../src/log.js";

const FAKE = join(process.cwd(), "test/fake-cli/fake-cli.mjs");
const log = createLogger("test");
const root = mkdtempSync(join(tmpdir(), "capitoline-runner-"));
const runner = createRunner({ sandboxRoot: root, user: null, killGraceMs: 300, log });

async function collect(it: AsyncIterable<string>) { const out: string[] = []; for await (const l of it) out.push(l); return out; }

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
