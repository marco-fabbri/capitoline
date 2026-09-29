import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The public-repository guard (.githooks/), run as git runs it: a scratch
// repository with core.hooksPath pointed at this clone's .githooks, a HOME of
// its own so the owner's real private list is never read, and the private
// list, when a test wants one, passed through CAPITOLINE_PRIVATE_PATTERNS.
// The forbidden strings are assembled at run time: written out here, they
// would stop this very file from being committed through the guard.
const HOOKS = join(process.cwd(), ".githooks");
const SESSION = "Claude" + "-Session: https://claude" + ".ai/code/session_x";

function repo(privatePatterns?: string) {
  const dir = mkdtempSync(join(tmpdir(), "public-check-"));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1" };
  if (privatePatterns !== undefined) {
    const file = join(dir, "private-patterns");
    writeFileSync(file, privatePatterns);
    env.CAPITOLINE_PRIVATE_PATTERNS = file;
  }
  const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "core.hooksPath", HOOKS);
  const commit = (file: string, text: string, message = "a change") => {
    writeFileSync(join(dir, file), text);
    git("add", file);
    return git("commit", "-q", "-m", message);
  };
  return { commit };
}

describe("the public-repository guard", () => {
  it("refuses a commit that adds a privately listed word, naming the file and the line", () => {
    const r = repo("# the owner's own names\nexample-app\n").commit("notes.md", "first line\nsee example-app here\n");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/notes\.md:2 matches \/example-app\//);
    expect(r.stderr).toMatch(/this repository is public/);
  });
  it("refuses the same word in the commit message", () => {
    const r = repo("example-app\n").commit("notes.md", "clean text\n", "wire example-app to the gateway");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/message:1 matches/);
  });
  it("lets a clean commit through", () => {
    expect(repo("example-app\n").commit("notes.md", "nothing to hide\n").status).toBe(0);
  });
  it("runs the built-in patterns alone, and says so, when there is no private list", () => {
    const clean = repo().commit("notes.md", "nothing to hide\n");
    expect(clean.status).toBe(0);
    expect(clean.stderr).toMatch(/no private pattern list/);
    const leaked = repo().commit("notes.md", "done\n", `a change\n\n${SESSION}\n`);
    expect(leaked.status).not.toBe(0);
    expect(leaked.stderr).toMatch(/message:3 matches/);
  });
  it("catches a gateway key and a session link in a file too", () => {
    const r = repo().commit("config.txt", `key: cap_${"a".repeat(32)}\n${SESSION}\n`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/config\.txt:1 matches/);
    expect(r.stderr).toMatch(/config\.txt:2 matches/);
  });
});
