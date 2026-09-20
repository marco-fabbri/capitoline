import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
export interface Runner { run(spec: RunSpec): Promise<RunHandle> }
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

      // A binary given as a relative path is relative to the gateway's cwd, not to the sandbox.
      const binary = spec.binary.includes("/") ? resolve(spec.binary) : spec.binary;
      const [cmd, args] = o.user
        ? ["sudo", ["-n", "-H", "-u", o.user, "--", binary, ...spec.args]]
        : [binary, spec.args];
      const env = o.user ? { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" } : process.env;

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
  };
}
