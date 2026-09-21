import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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
  it("settles when a grandchild holds stdout open after the process is killed", async () => {
    // 'close' never fires here: the detached grandchild keeps the write end of
    // the pipe. Without the bound on the wait for EOF the result promise would
    // stay pending, the line iterator would never end (so the provider's
    // generator would never complete and its concurrency slot never come back)
    // and the sandbox would stay on disk for the life of the process.
    const t0 = Date.now();
    const h = await runner.run({ binary: FAKE, args: ["--mode", "leak-stdout"], stdin: null, timeoutMs: 500 });
    expect(await collect(h.lines)).toEqual(['{"spawned":true}']);
    const r = await h.result;
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(4000);
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
    // A symlink is never followed: in a sandbox root shared with the runner
    // user, one named run-… would otherwise be a way to have the gateway
    // delete a directory of the planter's choosing.
    const outside = mkdtempSync(join(tmpdir(), "capitoline-outside-"));
    age(outside, 10 * 60 * 1000);
    symlinkSync(outside, join(dir, "run-link"));

    expect(await r.sweep(5 * 60 * 1000)).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(["keep-me", "run-link", "run-loose.txt"]);
    expect(existsSync(outside)).toBe(true);
    rmSync(outside, { recursive: true });
  });

  it("reports nothing instead of throwing when the sandbox root does not exist", async () => {
    const { dir, runner: r } = sweptRunner();
    rmSync(dir, { recursive: true });
    await expect(r.sweep(5 * 60 * 1000)).resolves.toEqual([]);
  });
});

describe("runner under sudo", () => {
  // The production branch: `sudo -n -H -u <user> -- <binary> <args>` with an
  // environment cut down to PATH. It is what enforces the privilege
  // separation the whole design rests on, and every other case in this file
  // runs with `user: null`, so nothing exercised it.
  //
  // The sudo it runs is a fake first on PATH (test/fake-cli/fake-sudo/sudo),
  // which executes nothing: it prints how it was called and exits. The real
  // sudo is never reached, and `-n` would make it fail rather than ask for a
  // password even if it were.
  const SUDO_DIR = join(process.cwd(), "test/fake-cli/fake-sudo");
  const sudoRunner = (dir: string) => createRunner({ sandboxRoot: dir, user: "runner", killGraceMs: 300, log });
  type Said = { sudo: string; argv: string[]; env: Record<string, string>; cwd: string };

  let savedPath: string | undefined;
  beforeEach(() => {
    savedPath = process.env.PATH;
    process.env.PATH = `${SUDO_DIR}:${savedPath ?? ""}`;
    process.env.CAPITOLINE_TEST_SECRET = "must never reach a CLI";
  });
  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    delete process.env.CAPITOLINE_TEST_SECRET;
  });

  /** What the child says it received, and the environment it did not receive. */
  function assertSudoCall(said: Said, expectedArgs: string[]) {
    expect(said.sudo).toBe("fake");                    // the fake, never the real sudo
    // -n: no sudoers rule must turn into a password prompt that hangs the run.
    // -H: the CLI must read the runner's own home, where its credentials are.
    // --: a model id or prompt flag starting with a dash is never read by sudo.
    expect(said.argv).toEqual(["-n", "-H", "-u", "runner", "--", FAKE, ...expectedArgs]);
    expect(said.env.PATH).toBe(process.env.PATH);
    // The reduced environment is the point: the gateway's own HOME would send
    // the CLI to the wrong credentials, and anything else it carries is the
    // gateway's business, not the CLI's.
    expect(said.env.HOME).toBeUndefined();
    expect(said.env.CAPITOLINE_TEST_SECRET).toBeUndefined();
    // Nothing but PATH is passed. What is left is injected by the platform
    // after the exec (macOS adds __CF_USER_TEXT_ENCODING), never carried over.
    expect(Object.keys(said.env).filter((k) => !k.startsWith("__"))).toEqual(["PATH"]);
  }

  it("runs the CLI through sudo, in the sandbox, with only PATH in the environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "capitoline-sudo-"));
    const h = await sudoRunner(dir).run({ binary: FAKE, args: ["--mode", "cwd"], stdin: null, timeoutMs: 5000 });
    const [line] = await collect(h.lines);
    const r = await h.result;
    expect(r.exitCode).toBe(0);
    const said = JSON.parse(line) as Said;
    assertSudoCall(said, ["--mode", "cwd"]);
    expect(said.cwd).toBe(h.sandboxDir);               // sudo does not move the run out of its sandbox
    expect(existsSync(h.sandboxDir)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("wraps a capture the same way, in the sandbox root", async () => {
    // The collect helper of the image path takes this branch too, and it is
    // the one command that deliberately runs outside a sandbox.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "capitoline-sudo-")));
    const r = await sudoRunner(dir).capture({ binary: FAKE, args: ["--collect", "x"], timeoutMs: 5000, maxBytes: 64 * 1024 });
    expect(r.exitCode).toBe(0);
    assertSudoCall(JSON.parse(r.stdout.toString("utf8")) as Said, ["--collect", "x"]);
    expect((JSON.parse(r.stdout.toString("utf8")) as Said).cwd).toBe(dir);
    rmSync(dir, { recursive: true, force: true });
  });
});
