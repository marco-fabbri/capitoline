import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { codexAdapter } from "../src/providers/codex.js";
import { loadConfig } from "../src/config.js";
import { modelSpecs } from "../src/providers/adapter.js";
import type { AdapterEvent } from "../src/core/types.js";

const cfg = loadConfig("config/capitoline.yaml").providers.codex;
const astra = modelSpecs("codex", cfg).find((m) => m.name === "codex-gpt-6-astra")!;
async function* linesOf(path: string) { for (const l of readFileSync(path, "utf8").split("\n")) yield l; }
async function events(src: AsyncIterable<string>) { const out: AdapterEvent[] = []; for await (const e of codexAdapter.parse(src)) out.push(e); return out; }

describe("codex adapter", () => {
  it("builds the command with model, effort override, developer instructions and stdin prompt", () => {
    const c = codexAdapter.buildCommand(cfg, astra, {
      model: "codex-gpt-6-astra", stream: false, effort: "low",
      messages: [{ role: "system", text: 'Say "hi"\nthen stop' }, { role: "user", text: "q" }],
    });
    expect(c.args.slice(0, cfg.args.length)).toEqual(cfg.args);
    expect(c.args[c.args.indexOf("-m") + 1]).toBe("gpt-6-astra");
    expect(c.args).toContain('model_reasoning_effort="low"');
    expect(c.args).toContain('developer_instructions="Say \\"hi\\"\\nthen stop"');
    expect(c.args.at(-1)).toBe("-");
    expect(c.stdin).toBe("q");
  });
  it("takes the model flag, the effort flag and the effort key from the configuration", () => {
    expect([cfg.model_flag, cfg.effort_flag, cfg.effort_key]).toEqual(["-m", "-c", "model_reasoning_effort"]);
    const renamed = { ...cfg, model_flag: "--model", effort_flag: "--config", effort_key: "reasoning.effort" };
    const c = codexAdapter.buildCommand(renamed, astra, { model: "codex-gpt-6-astra", stream: false, effort: "low", messages: [{ role: "user", text: "q" }] });
    expect(c.args.slice(cfg.args.length)).toEqual(["--model", "gpt-6-astra", "--config", 'reasoning.effort="low"', "-"]);
    expect(c.args).not.toContain("-m");
    expect(c.args).not.toContain('model_reasoning_effort="low"');
  });
  it("passes a bare effort value when the provider declares no effort key", () => {
    const bare = { ...cfg, effort_key: null };
    const c = codexAdapter.buildCommand(bare, astra, { model: "codex-gpt-6-astra", stream: false, effort: "low", messages: [{ role: "user", text: "q" }] });
    expect(c.args.slice(cfg.args.length)).toEqual(["-m", "gpt-6-astra", "-c", "low", "-"]);
  });
  it("parses exec --json output into one text event and done with usage", async () => {
    const ev = await events(linesOf("test/fixtures/codex/exec-json-locked.jsonl"));
    expect(ev).toEqual([{ type: "text", delta: "OK" }, { type: "done", usage: { input: 10566, output: 5 } }]);
  });
  it("maps turn.failed to a typed error", async () => {
    async function* l() { yield JSON.stringify({ type: "turn.failed", error: { message: "429 Too Many Requests" } }); }
    expect(await events(l())).toEqual([{ type: "error", kind: "rate_limited", detail: "429 Too Many Requests" }]);
  });
  it("classifies a string error instead of discarding it", async () => {
    // `error` is not always an object: a bare string would have lost the
    // message and been answered 502 instead of 429.
    async function* l() { yield JSON.stringify({ type: "turn.failed", error: "429 Too Many Requests" }); }
    expect(await events(l())).toEqual([{ type: "error", kind: "rate_limited", detail: "429 Too Many Requests" }]);
    async function* empty() { yield JSON.stringify({ type: "turn.failed", error: {} }); }
    expect(await events(empty())).toEqual([{ type: "error", kind: "cli_crashed", detail: "codex error" }]);
    // An empty string is no more of a message than a missing one: the two
    // shapes must not produce different details.
    async function* blank() { yield JSON.stringify({ type: "turn.failed", error: "" }); }
    expect(await events(blank())).toEqual([{ type: "error", kind: "cli_crashed", detail: "codex error" }]);
  });
  it("maps the real expired-credential capture to auth_expired", async () => {
    const ev = await events(linesOf("test/fixtures/codex/auth-expired.jsonl"));
    expect(ev).toHaveLength(1);                      // the first error ends the stream
    expect(ev[0]).toMatchObject({ type: "error", kind: "auth_expired" });
    expect((ev[0] as any).detail).toContain("401 Unauthorized");
  });
  it("replaces a raw DEL in the developer instructions", () => {
    // JSON.stringify escapes every control character below U+0020 but emits
    // U+007F raw, and TOML forbids it in a basic string just the same: the
    // override would not parse and the run would die with the client's own
    // text as the cause.
    const c = codexAdapter.buildCommand(cfg, astra, {
      model: "codex-gpt-6-astra", stream: false,
      messages: [{ role: "system", text: "lone \u007F end" }, { role: "user", text: "q" }],
    });
    const arg = c.args.find((a) => a.startsWith("developer_instructions="))!;
    expect(arg).not.toContain("\u007F");
    expect(Buffer.from(arg, "utf8").includes(0x7f)).toBe(false);
    expect(arg).toBe('developer_instructions="lone � end"');
  });
  it("replaces unpaired surrogates in the developer instructions", () => {
    // Client-controlled text can hold a lone surrogate; JSON.stringify escapes
    // it verbatim and the CLI's TOML parser then rejects the whole override.
    const c = codexAdapter.buildCommand(cfg, astra, {
      model: "codex-gpt-6-astra", stream: false,
      messages: [{ role: "system", text: "lone \uD800 pair \u{1F680} end" }, { role: "user", text: "q" }],
    });
    const arg = c.args.find((a) => a.startsWith("developer_instructions="))!;
    expect(arg).toBe('developer_instructions="lone � pair \u{1F680} end"');
    expect(arg).not.toContain("\\ud800");
    expect(JSON.parse(arg.slice("developer_instructions=".length))).toBe("lone � pair \u{1F680} end");
  });
  it("adds no developer instructions when the request carries no system message", () => {
    // The `if (system)` branch is skipped: the -c pairs the configuration
    // itself declares stay, and nothing else is appended before the "-".
    const c = codexAdapter.buildCommand(cfg, astra, { model: "codex-gpt-6-astra", stream: false, messages: [{ role: "user", text: "q" }] });
    expect(c.args.some((a) => a.startsWith("developer_instructions="))).toBe(false);
    expect(c.args.slice(cfg.args.length)).toEqual(["-m", "gpt-6-astra", "-c", 'model_reasoning_effort="medium"', "-"]);
    expect(c.stdin).toBe("q");
  });
  it("prefixes the prompt on stdin when the provider declares no system prompt flag", () => {
    // A `system_prompt_flag: null` in the host's file must still deliver the
    // system prompt, and never as an unnamed -c override.
    const noFlag = { ...cfg, system_prompt_flag: null };
    const c = codexAdapter.buildCommand(noFlag, astra, { model: "codex-gpt-6-astra", stream: false, messages: [{ role: "system", text: "S" }, { role: "user", text: "q" }] });
    expect(c.args.some((a) => a.startsWith("developer_instructions="))).toBe(false);
    expect(c.args.slice(cfg.args.length)).toEqual(["-m", "gpt-6-astra", "-c", 'model_reasoning_effort="medium"', "-"]);
    expect(c.stdin).toBe("System instructions:\nS\n\nq");
  });
  it("maps a bare `error` event like turn.failed", async () => {
    // A failure before the turn starts (a refused login, a rejected flag)
    // arrives as `type: "error"` with the message at the top level and no
    // `error` field at all: errorDetail falls back to the event itself.
    async function* l() { yield JSON.stringify({ type: "error", message: "401 Unauthorized" }); }
    expect(await events(l())).toEqual([{ type: "error", kind: "auth_expired", detail: "401 Unauthorized" }]);
    async function* bare() { yield JSON.stringify({ type: "error" }); }
    expect(await events(bare())).toEqual([{ type: "error", kind: "cli_crashed", detail: "codex error" }]);
    // The first error ends the stream: nothing after it is parsed.
    async function* then() {
      yield JSON.stringify({ type: "error", message: "boom" });
      yield JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "late" } });
    }
    expect(await events(then())).toHaveLength(1);
  });
});
