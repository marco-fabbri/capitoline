import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Logger } from "../log.js";

export interface RunSpec {
  binary: string;
  args: string[];
  stdin: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
  files?: { name: string; bytes: Buffer }[];
}
export interface RunResult { exitCode: number | null; timedOut: boolean; aborted: boolean; stderr: string; sandboxDir: string }
export interface RunHandle { lines: AsyncIterable<string>; result: Promise<RunResult>; sandboxDir: string }
export interface CaptureSpec { binary: string; args: string[]; timeoutMs: number; maxBytes: number }
export interface CaptureResult { exitCode: number | null; stdout: Buffer; stderr: string; timedOut: boolean }
export interface Runner {
  run(spec: RunSpec): Promise<RunHandle>;
  // Runs a helper command (through sudo when configured) and returns its stdout
  // as bytes: for collecting an image produced by a CLI outside the sandbox.
  capture(spec: CaptureSpec): Promise<CaptureResult>;
  // Removes the run-* directories under sandbox_root that no live run can own
  // any more, and returns their names. Called once at startup.
  sweep(olderThanMs: number): Promise<string[]>;
}
export interface RunnerOptions { sandboxRoot: string; user: string | null; killGraceMs: number; log: Logger }

const STDERR_CAP = 64 * 1024;

// Attachments must land inside the sandbox: only a plain file name is accepted.
function attachmentName(name: string): string {
  const base = basename(name);
  if (base !== name || base === "" || base === "." || base === ".." || name.startsWith("/")) {
    throw new Error(`invalid attachment name: ${name}`);
  }
  return base;
}

// Buffers 'line' events from the moment the interface is created, so lines emitted
// before the consumer starts iterating are not lost (readline's own async iterator
// is created lazily on the first next() and drops earlier lines).
function bufferedLines(rl: ReturnType<typeof createInterface>): AsyncIterable<string> {
  const queue: string[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  rl.on("line", (l) => { queue.push(l); wake?.(); });
  rl.on("close", () => { closed = true; wake?.(); });
  return (async function* () {
    for (;;) {
      if (queue.length > 0) { yield queue.shift() as string; continue; }
      if (closed) return;
      await new Promise<void>((r) => { wake = r; });
      wake = null;
    }
  })();
}

// sudo wrapping and environment reduction shared by run() and capture().
function command(o: RunnerOptions, binarySpec: string, specArgs: string[]): { binary: string; cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  // A binary given as a relative path is relative to the gateway's cwd, not to the sandbox.
  const binary = binarySpec.includes("/") ? resolve(binarySpec) : binarySpec;
  const [cmd, args] = o.user
    ? ["sudo", ["-n", "-H", "-u", o.user, "--", binary, ...specArgs]]
    : [binary, specArgs];
  const env = o.user ? { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" } : process.env;
  return { binary, cmd, args, env };
}

export function createRunner(o: RunnerOptions): Runner {
  // Cleanup must never throw: the result promise has to settle even if the
  // directory cannot be removed (e.g. EACCES on entries owned by the runner user).
  const removeSandbox = async (dir: string) => {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch (e) {
      o.log.error({ dir, err: (e as Error).message }, "sandbox cleanup failed");
    }
  };

  return {
    async run(spec: RunSpec): Promise<RunHandle> {
      await mkdir(o.sandboxRoot, { recursive: true });
      // Canonical path: on macOS tmpdir() is a symlink (/var -> /private/var) and
      // the child reports the resolved cwd, so sandboxDir must match it.
      const dir = await realpath(await mkdtemp(join(o.sandboxRoot, "run-")));
      try {
        // The sandbox is owned by the gateway user; when running through sudo the
        // runner user needs group access, so the directory is group-writable.
        if (o.user) await chmod(dir, 0o770);
        for (const f of spec.files ?? []) await writeFile(join(dir, attachmentName(f.name)), f.bytes);
      } catch (e) {
        await removeSandbox(dir);
        throw e;
      }

      // The client may already be gone (e.g. it disconnected while the request
      // was queued): do not spawn at all, just report the abort.
      if (spec.signal?.aborted) {
        await removeSandbox(dir);
        return {
          lines: (async function* () {})(),
          result: Promise.resolve({ exitCode: null, timedOut: false, aborted: true, stderr: "", sandboxDir: dir }),
          sandboxDir: dir,
        };
      }

      const { binary, cmd, args, env } = command(o, spec.binary, spec.args);
      const child = spawn(cmd, args, { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      let timedOut = false;
      let aborted = false;
      let spawnError: Error | null = null;

      child.on("error", (e) => { spawnError = e; });
      child.stdin.on("error", () => { /* child may exit before reading stdin */ });
      if (spec.stdin !== null) child.stdin.end(spec.stdin); else child.stdin.end();
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
        if (stderr.length > STDERR_CAP) stderr = stderr.slice(-STDERR_CAP);
      });

      const kill = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, o.killGraceMs).unref();
      };
      const timer = setTimeout(() => { timedOut = true; kill(); }, spec.timeoutMs);
      const onAbort = () => { aborted = true; kill(); };
      spec.signal?.addEventListener("abort", onAbort, { once: true });
      // 'abort' is not re-dispatched to listeners added after the fact.
      if (spec.signal?.aborted) onAbort();

      const lines = bufferedLines(createInterface({ input: child.stdout, crlfDelay: Infinity }));

      const result = new Promise<RunResult>((done) => {
        let finished = false;
        const finish = async (code: number | null) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          spec.signal?.removeEventListener("abort", onAbort);
          try {
            await removeSandbox(dir);
          } finally {
            if (spawnError) stderr += `\n${spawnError.message}`;
            const exitCode = spawnError ? -1 : code;
            if (exitCode !== 0 || timedOut) o.log.warn({ binary, exitCode, timedOut, aborted, stderr: stderr.slice(-2000) }, "cli run ended abnormally");
            done({ exitCode, timedOut, aborted, stderr, sandboxDir: dir });
          }
        };
        child.on("close", (code) => { void finish(code); });
        // A failed spawn (ENOENT) emits 'error' and may never emit 'close'.
        child.on("error", () => { setImmediate(() => { void finish(-1); }); });
      });

      return { lines, result, sandboxDir: dir };
    },

    async capture(spec: CaptureSpec): Promise<CaptureResult> {
      // No sandbox: the helper reads nothing from the working directory, so it
      // runs in the sandbox root, which is created on demand as in run().
      await mkdir(o.sandboxRoot, { recursive: true });
      const { binary, cmd, args, env } = command(o, spec.binary, spec.args);
      const child = spawn(cmd, args, { cwd: o.sandboxRoot, env, stdio: ["pipe", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      let received = 0;
      let overflow = false;
      let stderr = "";
      let timedOut = false;
      let spawnError: Error | null = null;

      child.on("error", (e) => { spawnError = e; });
      child.stdin.on("error", () => { /* child may exit before noticing */ });
      child.stdin.end();
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
        if (stderr.length > STDERR_CAP) stderr = stderr.slice(-STDERR_CAP);
      });

      const kill = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, o.killGraceMs).unref();
      };
      child.stdout.on("data", (d: Buffer) => {
        if (overflow) return;
        received += d.length;
        if (received > spec.maxBytes) {
          // Keep exactly maxBytes, stop consuming and kill: the caller must never
          // mistake a truncated stdout for a complete one, whatever the exit code.
          overflow = true;
          chunks.push(d.subarray(0, d.length - (received - spec.maxBytes)));
          child.stdout.destroy();
          kill();
          return;
        }
        chunks.push(d);
      });
      const timer = setTimeout(() => { timedOut = true; kill(); }, spec.timeoutMs);

      return new Promise<CaptureResult>((done) => {
        let finished = false;
        const finish = (code: number | null) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          if (spawnError) stderr += `\n${spawnError.message}`;
          if (overflow) stderr += `\nstdout exceeded ${spec.maxBytes} bytes`;
          const exitCode = spawnError || overflow ? -1 : code;
          if (exitCode !== 0 || timedOut) o.log.warn({ binary, exitCode, timedOut, overflow, stderr: stderr.slice(-2000) }, "capture ended abnormally");
          done({ exitCode, stdout: Buffer.concat(chunks), stderr, timedOut });
        };
        child.on("close", (code) => { finish(code); });
        // A failed spawn (ENOENT) emits 'error' and may never emit 'close'.
        child.on("error", () => { setImmediate(() => { finish(-1); }); });
      });
    },

    // A run() whose cleanup never happened (the process was killed between the
    // spawn and the close, or rm failed on a busy entry) leaves its directory
    // behind for good: nothing else ever looks at sandbox_root. The sweep runs
    // at startup, when this process owns no sandbox yet, and it measures the
    // age on mtime against the longest timeout the configuration allows, so a
    // directory it removes cannot belong to a run of another instance either.
    // It reports what it removed and never throws: a gateway that will not
    // start because of a leftover directory would be the worse failure.
    async sweep(olderThanMs: number): Promise<string[]> {
      const cutoff = Date.now() - olderThanMs;
      let entries;
      try {
        entries = await readdir(o.sandboxRoot, { withFileTypes: true });
      } catch (e) {
        // ENOENT is the normal state of a deployment that has not run a CLI yet.
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") o.log.warn({ dir: o.sandboxRoot, err: (e as Error).message }, "stale sandbox sweep failed");
        return [];
      }
      const removed: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith("run-")) continue;
        const dir = join(o.sandboxRoot, entry.name);
        try {
          if ((await stat(dir)).mtimeMs >= cutoff) continue;
          await rm(dir, { recursive: true, force: true, maxRetries: 3 });
          removed.push(entry.name);
        } catch (e) {
          o.log.warn({ dir, err: (e as Error).message }, "stale sandbox removal failed");
        }
      }
      if (removed.length > 0) o.log.info({ count: removed.length, dirs: removed, olderThanMs }, "removed stale sandboxes");
      return removed;
    },
  };
}
