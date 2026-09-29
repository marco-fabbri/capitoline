import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The real helper, not the fake the provider tests use: it is the one piece of
// the image path that reads a file name the CLI chooses, and that name changed
// once under us (docs/deploy.md §7.1). Run against a temporary HOME, never the
// runner's.
const HELPER = join(process.cwd(), "scripts/capitoline-collect-image");
const THREAD = "01a0ec49-65e3-7951-a386-36865b168b07";

function collect(home: string, ...args: string[]) {
  return spawnSync("bash", [HELPER, ...args], { env: { PATH: process.env.PATH, HOME: home }, encoding: "buffer" });
}

function codexThread(file: string, bytes: string): { home: string; dir: string } {
  const home = mkdtempSync(join(tmpdir(), "collect-"));
  const dir = join(home, ".codex/generated_images", THREAD);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), bytes);
  return { home, dir };
}

describe("capitoline-collect-image, codex", () => {
  it.each([
    ["exec-71353327-f359-41dc-af1b-12e25b4ed1c1.png", "the name since September 2026"],
    ["call_abc123.png", "the name before it"],
  ])("prints %s (%s) and removes the thread's directory", (file) => {
    const { home, dir } = codexThread(file, "PNGDATA");
    const r = collect(home, "codex", THREAD);
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toBe("PNGDATA");
    expect(existsSync(dir)).toBe(false);
  });

  it("exits 4 when the thread's directory holds no picture, and removes it anyway", () => {
    const { home, dir } = codexThread("notes.txt", "not an image");
    const r = collect(home, "codex", THREAD);
    expect(r.status).toBe(4);
    expect(existsSync(dir)).toBe(false);
  });

  it("refuses anything but a UUID, and a thread that does not exist", () => {
    const home = mkdtempSync(join(tmpdir(), "collect-"));
    expect(collect(home, "codex", "../../etc").status).toBe(2);
    expect(collect(home, "codex", THREAD).status).toBe(3);
  });
});
