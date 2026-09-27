import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UsageStore } from "../src/usage/store.js";

// The bootstrap for an install with no administrator yet (docs/deploy.md
// §8): the three commands against a database of their own, through tsx so
// the source under test is the one run, never a stale dist/.
describe("npm run keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "capitoline-keys-"));
  const db = join(dir, "usage.sqlite");
  const overlay = join(dir, "overlay.yaml");
  writeFileSync(overlay, `usage:\n  db_path: ${db}\n`);
  const run = (...args: string[]) => spawnSync("npx", ["tsx", "src/keys-cli.ts", ...args], { encoding: "utf8", env: { ...process.env, CAPITOLINE_OVERLAY: overlay } });

  it("creates a key on stdout once, lists it without the secret, and revokes it", () => {
    const created = run("create", "app-two");
    expect(created.status, created.stderr).toBe(0);
    const key = created.stdout.trim();
    expect(key).toMatch(/^cap_/);
    expect(created.stderr).toMatch(/only time/);
    // The key works against the store the service would open.
    const s = new UsageStore(db);
    expect(s.authenticateKey(key)).toEqual({ name: "app-two" });
    s.close();
    const list = run("list");
    expect(list.stdout).toMatch(/^app-two\t/);
    expect(list.stdout).not.toContain(key.slice(4, 20));
    expect(run("create", "app-two").status).toBe(1);
    expect(run("revoke", "app-two").status).toBe(0);
    expect(run("revoke", "app-two").status).toBe(1);
    expect(run("list").stdout).toMatch(/revoked/);
    expect(run("bogus").status).toBe(2);
  }, 60_000);
});
