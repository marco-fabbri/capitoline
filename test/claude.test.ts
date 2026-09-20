import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { claudeAdapter } from "../src/providers/claude.js";
import { loadConfig } from "../src/config.js";
import { modelSpecs } from "../src/providers/adapter.js";
import type { ProviderEvent } from "../src/core/types.js";

const cfg = loadConfig("config/capitoline.yaml").providers.claude;
const models = modelSpecs("claude", cfg);
const opus = models.find((m) => m.name === "claude-opus")!;

async function* linesOf(path: string) { for (const l of readFileSync(path, "utf8").split("\n")) yield l; }
async function events(path: string) { const out: ProviderEvent[] = []; for await (const e of claudeAdapter.parse(linesOf(path))) out.push(e); return out; }

describe("claude adapter", () => {
  it("builds the command with model, effort and system prompt, prompt on stdin", () => {
    const c = claudeAdapter.buildCommand(cfg, opus, {
      model: "claude-opus", stream: true, effort: "high",
      messages: [{ role: "system", text: "Be terse." }, { role: "user", text: "hi" }],
    });
    expect(c.args.slice(0, cfg.args.length)).toEqual(cfg.args);
    expect(c.args).toContain("--model"); expect(c.args[c.args.indexOf("--model") + 1]).toBe("opus");
    expect(c.args[c.args.indexOf("--effort") + 1]).toBe("high");
    expect(c.args[c.args.indexOf("--system-prompt") + 1]).toBe("Be terse.");
    expect(c.stdin).toBe("hi");
  });
  it("defaults effort to medium and omits the system flag when absent", () => {
    const c = claudeAdapter.buildCommand(cfg, opus, { model: "claude-opus", stream: false, messages: [{ role: "user", text: "hi" }] });
    expect(c.args[c.args.indexOf("--effort") + 1]).toBe("medium");
    expect(c.args).not.toContain("--system-prompt");
  });
  it("parses partial stream output into text deltas, rate limits and done with usage", async () => {
    const ev = await events("test/fixtures/claude/stream-json-partial.jsonl");
    expect(ev.filter((e) => e.type === "text").map((e) => (e as any).delta).join("")).toBe("ok ok");
    const rl = ev.find((e) => e.type === "rate_limit") as any;
    expect(rl.fiveHour.utilization).toBeCloseTo(0.05);
    expect(rl.sevenDay.resetsAt).toBe(1790362800);
    const done = ev.at(-1) as any;
    expect(done.type).toBe("done");
    expect(done.usage).toEqual({ input: 2 + 2947 + 3046, output: 6 });
  });
  it("uses the assistant message when no deltas were streamed", async () => {
    const ev = await events("test/fixtures/claude/stream-json-locked.jsonl");
    expect(ev.filter((e) => e.type === "text").map((e) => (e as any).delta).join("")).toBe("ok");
    expect(ev.at(-1)!.type).toBe("done");
  });
  it("maps an error result to a typed error", async () => {
    async function* l() { yield JSON.stringify({ type: "result", is_error: true, subtype: "error_during_execution", result: "Login expired · Please run /login" }); }
    const out: ProviderEvent[] = []; for await (const e of claudeAdapter.parse(l())) out.push(e);
    expect(out).toEqual([{ type: "error", kind: "auth_expired", detail: "Login expired · Please run /login" }]);
  });
});
