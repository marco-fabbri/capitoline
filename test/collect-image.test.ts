import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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

describe("capitoline-collect-image forget", () => {
  const MINE = "dc840127-5c8b-446d-a171-920118ee670f";
  const OTHER = "f6c18ec4-b6d7-4e79-81f9-bb6d203cbd8c";
  // What one Antigravity run leaves behind, as observed with agy 1.2.14, for
  // two conversations: the one to forget and one that must stay.
  function agyHome(): string {
    const home = mkdtempSync(join(tmpdir(), "forget-"));
    const agy = join(home, ".gemini/antigravity-cli");
    for (const id of [MINE, OTHER]) {
      mkdirSync(join(agy, "brain", id, ".system_generated/logs"), { recursive: true });
      writeFileSync(join(agy, "brain", id, ".system_generated/logs/transcript.jsonl"), "the prompt");
      for (const [dir, file] of [["conversations", `${id}.db`], ["annotations", `${id}.pbtxt`], ["presence", `${id}.lock`]]) {
        mkdirSync(join(agy, dir), { recursive: true });
        writeFileSync(join(agy, dir, file), "x");
      }
    }
    const db = new DatabaseSync(join(agy, "conversation_summaries.db"));
    db.exec("CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text, preview text)");
    for (const id of [MINE, OTHER]) db.prepare("INSERT INTO conversation_summaries VALUES (?, 'a title', 'a preview of the prompt')").run(id);
    db.close();
    return agy;
  }
  const traces = (agy: string, id: string) => [`brain/${id}`, `conversations/${id}.db`, `annotations/${id}.pbtxt`, `presence/${id}.lock`].filter((f) => existsSync(join(agy, f)));
  const summaries = (agy: string) => {
    const db = new DatabaseSync(join(agy, "conversation_summaries.db"));
    try { return (db.prepare("SELECT conversation_id FROM conversation_summaries").all() as { conversation_id: string }[]).map((r) => r.conversation_id); } finally { db.close(); }
  };

  it("removes every trace of that conversation and nothing of another", () => {
    const agy = agyHome();
    const r = collect(join(agy, "../.."), "forget", MINE);
    expect(r.status).toBe(0);
    expect(traces(agy, MINE)).toEqual([]);
    expect(traces(agy, OTHER)).toHaveLength(4);
    expect(summaries(agy)).toEqual([OTHER]);
  });

  it("succeeds on a conversation already gone, and refuses anything but a UUID", () => {
    const agy = agyHome();
    expect(collect(join(agy, "../.."), "forget", "01a0ec49-65e3-7951-a386-36865b168b07").status).toBe(0);
    expect(collect(join(agy, "../.."), "forget", "../../etc").status).toBe(2);
    expect(collect(join(agy, "../.."), "forget", MINE, "extra").status).toBe(2);
    expect(traces(agy, MINE)).toHaveLength(4);
  });
});
