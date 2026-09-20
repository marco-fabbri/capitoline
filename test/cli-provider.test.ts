import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { CliProvider } from "../src/providers/cli-provider.js";
import { claudeAdapter } from "../src/providers/claude.js";
import { createRunner } from "../src/runner/runner.js";
import { createLogger } from "../src/log.js";
import { loadConfig } from "../src/config.js";
import type { ProviderEvent } from "../src/core/types.js";

const FAKE = join(process.cwd(), "test/fake-cli/fake-cli.mjs");
const base = loadConfig("config/capitoline.yaml").providers.claude;
const runner = createRunner({ sandboxRoot: mkdtempSync(join(tmpdir(), "cp-")), user: null, killGraceMs: 200, log: createLogger("t") });

function provider(mode: string, extra: Partial<typeof base> = {}) {
  const fixture = join(process.cwd(), "test/fixtures/claude/stream-json-locked.jsonl"); // absolute: the CLI runs inside the sandbox dir
  const cfg = { ...base, binary: FAKE, args: ["--mode", mode, "--file", fixture], timeout_s: 1, ...extra };
  return new CliProvider("claude", cfg, claudeAdapter, runner, createLogger("t"));
}
const req = { model: "claude-haiku", stream: true, messages: [{ role: "user" as const, text: "hi" }] };
async function run(p: CliProvider) { const out: ProviderEvent[] = []; const m = p.models().find((x) => x.name === "claude-haiku")!; for await (const e of p.execute(req, m)) out.push(e); return out; }

describe("CliProvider", () => {
  it("replays fixture output through the adapter", async () => {
    const ev = await run(provider("replay"));
    expect(ev.map((e) => e.type)).toEqual(["text", "rate_limit", "done"]);
  });
  it("yields timeout when the process is killed by the deadline", async () => {
    const ev = await run(provider("hang"));
    expect(ev.at(-1)).toMatchObject({ type: "error", kind: "timeout" });
  });
  it("yields a classified error with stderr detail on crash", async () => {
    const ev = await run(provider("crash"));
    expect(ev.at(-1)).toMatchObject({ type: "error", kind: "cli_crashed", detail: expect.stringContaining("boom") });
  });
  it("yields bad_output when the process exits cleanly without a result", async () => {
    const ev = await run(provider("stdin-len"));
    expect(ev.at(-1)).toMatchObject({ type: "error", kind: "bad_output" });
  });
  it("health() is ok on replay and not ok on crash", async () => {
    expect((await provider("replay").health()).ok).toBe(true);
    const h = await provider("crash").health();
    expect(h.ok).toBe(false); expect(h.kind).toBe("cli_crashed");
  });
});
