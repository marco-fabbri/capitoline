import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageStore } from "../src/usage/store.js";

const execFileP = promisify(execFile);
const BACKUP = join(process.cwd(), "scripts/capitoline-backup");

/** `date +%F` on the host running the script: local calendar day, ISO order. */
const today = new Date().toLocaleDateString("en-CA");

interface Run { code: number; stdout: string; stderr: string }

async function run(args: string[], env: Record<string, string>): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileP(BACKUP, args, { env: { ...process.env, ...env } });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("scripts/capitoline-backup", () => {
  let root: string;
  let db: string;
  let config: string;
  let dest: string;
  let store: UsageStore | null = null;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "capitoline-backup-"));
    db = join(root, "lib", "usage.sqlite");
    config = join(root, "etc", "capitoline.yaml");
    dest = join(root, "backups");
    mkdirSync(join(root, "etc"), { recursive: true });
    mkdirSync(dest, { recursive: true });
    writeFileSync(config, "server:\n  port: 8080\n");
    // The production case: the service is running, so the database is open in
    // WAL mode and the most recent rows live in the `-wal` sidecar only.
    store = new UsageStore(db);
    store.record({ provider: "claude", model: "claude-opus", inputTokens: 100, outputTokens: 10, durationMs: 5, outcome: "ok", source: "http", ts: 1_700_000_000_000 });
    store.record({ provider: "codex", model: "codex-gpt-5.5", inputTokens: 7, outputTokens: 1, durationMs: 5, outcome: "ok", source: "mcp", ts: 1_700_000_001_000 });
  });

  afterEach(() => {
    store?.close();
    store = null;
    rmSync(root, { recursive: true, force: true });
  });

  function rowsIn(path: string): number {
    const d = new DatabaseSync(path);
    try {
      return (d.prepare(`SELECT COUNT(*) AS c FROM calls`).get() as { c: number }).c;
    } catch {
      return -1; // no `calls` table at all: the schema itself was still in the WAL
    } finally {
      d.close();
    }
  }

  it("writes a dated archive holding a WAL-consistent snapshot and the configuration", async () => {
    // What the old `tar czf` over the live file would have captured.
    const naive = join(root, "naive.sqlite");
    copyFileSync(db, naive);
    expect(statSync(`${db}-wal`).size).toBeGreaterThan(0);
    expect(rowsIn(naive)).not.toBe(2);

    const r = await run([dest], { CAPITOLINE_DB: db, CAPITOLINE_CONFIG: config });
    expect(r.code).toBe(0);

    const archive = join(dest, `capitoline-${today}.tgz`);
    expect(existsSync(archive)).toBe(true);
    expect(statSync(archive).mode & 0o077).toBe(0);

    const out = mkdtempSync(join(tmpdir(), "capitoline-restore-"));
    await execFileP("tar", ["xzf", archive, "-C", out]);
    expect(readdirSync(out).sort()).toEqual(["capitoline.yaml", "usage.sqlite"]);
    expect(readFileSync(join(out, "capitoline.yaml"), "utf8")).toBe("server:\n  port: 8080\n");
    expect(rowsIn(join(out, "usage.sqlite"))).toBe(2);
    rmSync(out, { recursive: true, force: true });
  });

  it("keeps the fourteen most recent archives and removes the older ones", async () => {
    const old = Array.from({ length: 20 }, (_, i) => `capitoline-2026-08-${String(i + 1).padStart(2, "0")}.tgz`);
    for (const name of old) writeFileSync(join(dest, name), "x");
    writeFileSync(join(dest, "unrelated.txt"), "x");

    const r = await run([dest], { CAPITOLINE_DB: db, CAPITOLINE_CONFIG: config });
    expect(r.code).toBe(0);

    const left = readdirSync(dest).filter((f) => f.endsWith(".tgz")).sort();
    expect(left).toEqual([...old.slice(7), `capitoline-${today}.tgz`]);
    expect(existsSync(join(dest, "unrelated.txt"))).toBe(true);
  });

  it("honours CAPITOLINE_BACKUP_KEEP", async () => {
    for (let i = 1; i <= 5; i++) writeFileSync(join(dest, `capitoline-2026-08-0${i}.tgz`), "x");
    const r = await run([dest], { CAPITOLINE_DB: db, CAPITOLINE_CONFIG: config, CAPITOLINE_BACKUP_KEEP: "2" });
    expect(r.code).toBe(0);
    expect(readdirSync(dest).sort()).toEqual(["capitoline-2026-08-05.tgz", `capitoline-${today}.tgz`]);
  });

  it("fails without writing an archive when an input is missing", async () => {
    const cases: [string[], Record<string, string>][] = [
      [[], { CAPITOLINE_DB: db, CAPITOLINE_CONFIG: config }],
      [[join(root, "nowhere")], { CAPITOLINE_DB: db, CAPITOLINE_CONFIG: config }],
      [[dest], { CAPITOLINE_DB: join(root, "lib", "absent.sqlite"), CAPITOLINE_CONFIG: config }],
      [[dest], { CAPITOLINE_DB: db, CAPITOLINE_CONFIG: join(root, "etc", "absent.yaml") }],
    ];
    for (const [args, env] of cases) {
      const r = await run(args, env);
      expect(r.code).toBeGreaterThan(0);
      expect(r.stderr).not.toBe("");
      expect(readdirSync(dest)).toEqual([]);
    }
  });

  it("leaves no staging directory behind", async () => {
    const before = readdirSync(tmpdir()).filter((f) => f.startsWith("capitoline-backup.")).length;
    await run([dest], { CAPITOLINE_DB: db, CAPITOLINE_CONFIG: config });
    const after = readdirSync(tmpdir()).filter((f) => f.startsWith("capitoline-backup.")).length;
    expect(after).toBe(before);
  });
});
