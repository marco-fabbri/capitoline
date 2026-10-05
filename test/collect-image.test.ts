import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
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

  it("keeps a week of agy's own logs and drops the older ones", () => {
    const agy = agyHome();
    mkdirSync(join(agy, "log"));
    const old = join(agy, "log/cli-20260901_120000.log"), recent = join(agy, "log/cli-20260929_120000.log");
    writeFileSync(old, "x"); writeFileSync(recent, "x");
    const tenDaysAgo = Date.now() / 1000 - 10 * 86_400;
    utimesSync(old, tenDaysAgo, tenDaysAgo);
    expect(collect(join(agy, "../.."), "forget", MINE).status).toBe(0);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it("succeeds on a conversation already gone, and refuses anything but a UUID", () => {
    const agy = agyHome();
    expect(collect(join(agy, "../.."), "forget", "01a0ec49-65e3-7951-a386-36865b168b07").status).toBe(0);
    expect(collect(join(agy, "../.."), "forget", "../../etc").status).toBe(2);
    expect(collect(join(agy, "../.."), "forget", MINE, "extra").status).toBe(2);
    expect(traces(agy, MINE)).toHaveLength(4);
  });
});

// What no run forgot: a subagent's conversation whose id never reached the
// stream, or a run cut short. Old enough to be nobody's, it goes; anything a
// run may still be using stays.
describe("capitoline-collect-image sweep", () => {
  const OLD = "11111111-2222-4333-8444-555555555555", FRESH = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  function home() {
    const h = mkdtempSync(join(tmpdir(), "collect-"));
    const agy = join(h, ".gemini/antigravity-cli");
    for (const id of [OLD, FRESH]) {
      mkdirSync(join(agy, "brain", id), { recursive: true });
      writeFileSync(join(agy, "brain", id, "transcript.jsonl"), "{}");
    }
    mkdirSync(join(agy, "brain", "not-a-conversation"), { recursive: true });
    mkdirSync(join(agy, "conversations"), { recursive: true });
    writeFileSync(join(agy, "conversations", `${OLD}.db`), "x");
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
    utimesSync(join(agy, "brain", OLD), twoHoursAgo, twoHoursAgo);
    utimesSync(join(agy, "brain", "not-a-conversation"), twoHoursAgo, twoHoursAgo);
    return { h, agy };
  }

  it("forgets the conversations untouched for that long, says how many, and leaves the rest", () => {
    const { h, agy } = home();
    const r = collect(h, "sweep", "60");
    expect(r.status).toBe(0);
    expect(r.stdout.toString().trim()).toBe("1");
    expect(existsSync(join(agy, "brain", OLD))).toBe(false);
    expect(existsSync(join(agy, "conversations", `${OLD}.db`))).toBe(false);
    expect(existsSync(join(agy, "brain", FRESH))).toBe(true);
    // Not a conversation id: not this script's to remove.
    expect(existsSync(join(agy, "brain", "not-a-conversation"))).toBe(true);
    expect(collect(h, "sweep", "60").stdout.toString().trim()).toBe("0");
  });

  it("refuses a span short enough to take what a run is using, and anything that is not a number", () => {
    const { h, agy } = home();
    for (const bad of [["sweep"], ["sweep", "5"], ["sweep", "0"], ["sweep", "-60"], ["sweep", "60; rm -rf /"], ["sweep", "60", "extra"]]) {
      expect(collect(h, ...bad).status, bad.join(" ")).toBe(2);
    }
    expect(existsSync(join(agy, "brain", OLD))).toBe(true);
  });

  it("succeeds with nothing to sweep", () => {
    const r = collect(mkdtempSync(join(tmpdir(), "collect-")), "sweep", "60");
    expect(r.status).toBe(0);
    expect(r.stdout.toString().trim()).toBe("0");
  });
});

describe("capitoline-collect-image, a conversation with no image", () => {
  it("says what the conversation held, by name only, before removing it", () => {
    const h = mkdtempSync(join(tmpdir(), "collect-"));
    const id = "11111111-2222-4333-8444-555555555555";
    const dir = join(h, ".gemini/antigravity-cli/brain", id);
    mkdirSync(join(dir, ".system_generated/logs"), { recursive: true });
    writeFileSync(join(dir, ".system_generated/logs/transcript.jsonl"), "the prompt, which must not travel");
    writeFileSync(join(dir, "notes.md"), "nor this");
    const r = collect(h, id);
    expect(r.status).toBe(4);
    const said = r.stderr.toString();
    expect(said).toMatch(/^no image produced; the conversation held: /);
    expect(said).toContain("notes.md");
    expect(said).toContain(".system_generated/logs/transcript.jsonl");
    expect(said).not.toContain("must not travel");
    expect(existsSync(dir)).toBe(false);
    // An empty one says so.
    mkdirSync(dir, { recursive: true });
    expect(collect(h, id).stderr.toString().trim()).toBe("no image produced; the conversation held: nothing");
  });
});
