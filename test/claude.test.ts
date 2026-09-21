import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { claudeAdapter } from "../src/providers/claude.js";
import { loadConfig } from "../src/config.js";
import { modelSpecs } from "../src/providers/adapter.js";
import type { AdapterEvent } from "../src/core/types.js";

const cfg = loadConfig("config/capitoline.yaml").providers.claude;
const models = modelSpecs("claude", cfg);
const opus = models.find((m) => m.name === "claude-opus")!;

async function* linesOf(path: string) { for (const l of readFileSync(path, "utf8").split("\n")) yield l; }
async function events(path: string) { const out: AdapterEvent[] = []; for await (const e of claudeAdapter.parse(linesOf(path))) out.push(e); return out; }

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
  it("takes the model and effort flag names from the configuration", () => {
    // The repository config declares the flags this CLI uses today, so a
    // renamed flag is a configuration change and never a code change.
    expect([cfg.model_flag, cfg.effort_flag, cfg.effort_key]).toEqual(["--model", "--effort", null]);
    const renamed = { ...cfg, model_flag: "--model-id", effort_flag: "--reasoning", effort_key: null };
    const c = claudeAdapter.buildCommand(renamed, opus, { model: "claude-opus", stream: false, effort: "high", messages: [{ role: "user", text: "hi" }] });
    expect(c.args.slice(cfg.args.length)).toEqual(["--model-id", "opus", "--reasoning", "high"]);
    expect(c.args).not.toContain("--model");
    expect(c.args).not.toContain("--effort");
  });
  it("passes the effort as a key=value argument when the provider declares an effort key", () => {
    const keyed = { ...cfg, effort_flag: "-c", effort_key: "reasoning.effort" };
    const c = claudeAdapter.buildCommand(keyed, opus, { model: "claude-opus", stream: false, effort: "low", messages: [{ role: "user", text: "hi" }] });
    expect(c.args.slice(cfg.args.length)).toEqual(["--model", "opus", "-c", 'reasoning.effort="low"']);
  });
  it("omits the effort argument when the provider declares no effort flag", () => {
    const noEffort = { ...cfg, effort_flag: null };
    const c = claudeAdapter.buildCommand(noEffort, opus, { model: "claude-opus", stream: false, effort: "high", messages: [{ role: "user", text: "hi" }] });
    expect(c.args.slice(cfg.args.length)).toEqual(["--model", "opus"]);
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
    const out: AdapterEvent[] = []; for await (const e of claudeAdapter.parse(l())) out.push(e);
    expect(out).toEqual([{ type: "error", kind: "auth_expired", detail: "Login expired · Please run /login" }]);
  });
});
