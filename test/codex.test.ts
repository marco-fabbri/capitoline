import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CODEX_IMAGE_PROMPT, codexAdapter } from "../src/providers/codex.js";
import { loadConfig } from "../src/config.js";
import { modelSpecs } from "../src/providers/adapter.js";
import type { AdapterEvent } from "../src/core/types.js";

const cfg = loadConfig("config/capitoline.yaml").providers.codex;
const astra = modelSpecs("codex", cfg).find((m) => m.name === "codex-gpt-6-astra")!;
async function* linesOf(path: string) { for (const l of readFileSync(path, "utf8").split("\n")) yield l; }
async function events(src: AsyncIterable<string>) { const out: AdapterEvent[] = []; for await (const e of codexAdapter.parse(src)) out.push(e); return out; }

describe("codex adapter", () => {
  it("builds the image command with the lockdown first and image generation switched back on after it", () => {
    const image = modelSpecs("codex", cfg).find((m) => m.name === "codex-image")!;
    const c = codexAdapter.buildImageCommand!(cfg, image, { model: "codex-image", prompt: "a fox in the snow" });
    // Later overrides of one key win, so the image run's `true` must come
    // after the text lockdown's `false` — checked on the host with this order.
    const off = c.args.indexOf("features.image_generation=false");
    const on = c.args.indexOf("features.image_generation=true");
    expect(off).toBeGreaterThan(0);
    expect(on).toBeGreaterThan(off);
    // The agent is gpt-6-luna at its lowest effort; the prompt is the fixed one.
    expect(c.args[c.args.indexOf("-m") + 1]).toBe("gpt-6-luna");
    expect(c.args).toContain('model_reasoning_effort="low"');
    expect(c.args.at(-1)).toBe("-");
    expect(c.stdin).toBe(CODEX_IMAGE_PROMPT("a fox in the snow"));
  });
  it("reports the thread id of an image run, and no tool step, from the real capture", async () => {
    // 2026-09-23: the stream of a generation holds the thread id, "done" and
    // the usage, and nothing for the tool. The thread id names the directory
    // the image lands in.
    const ev = await events(linesOf("test/fixtures/codex/image-run.jsonl"));
    expect(ev[0]).toEqual({ type: "meta", conversationId: "01a0ccba-58c9-7980-9b15-63528791112c" });
    expect(ev.some((e) => e.type === "tool")).toBe(false);
  });
  it("reports every step that is not the model's own words as a tool step, and a Codex warning as none", async () => {
    async function* l() {
      yield JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "error", message: "Codex is ignoring 1 unrecognized configuration setting." } });
      yield JSON.stringify({ type: "item.started", item: { id: "item_1", type: "mcp_tool_call", tool: "list_mcp_resources", status: "in_progress" } });
      yield JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "mcp_tool_call", tool: "list_mcp_resources", status: "completed" } });
      yield JSON.stringify({ type: "item.completed", item: { id: "item_2", type: "file_change", status: "failed" } });
    }
    const ev = (await events(l())).map((e) => (e.type === "tool" ? [e.phase, e.name] : e.type));
    expect(ev).toEqual([["call", "list_mcp_resources"], ["done", "list_mcp_resources"], ["call", "file_change"], ["error", "file_change"]]);
  });
  it("honours a standing preamble when one is configured, before the client's system prompt", () => {
    const withPre = { ...cfg, system_preamble: "P" };
    const c = codexAdapter.buildCommand(withPre, astra, { model: "codex-gpt-6-astra", stream: false, messages: [{ role: "system", text: "S" }, { role: "user", text: "hi" }] });
    expect(c.args).toContain(`developer_instructions=${JSON.stringify("P\n\nS")}`);
    expect(cfg.system_preamble).toBeNull();
  });
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
  it("takes the flag that introduces the system prompt override from the configuration", () => {
    // The last flag still written in the adapter: the configuration named the
    // override key (developer_instructions) while the "-c" that carries it was
    // a literal, so a CLI that renamed it would have needed a code change.
    expect(cfg.system_prompt_flag_prefix).toBe("-c");
    const req = { model: "codex-gpt-6-astra", stream: false, effort: "low" as const, messages: [{ role: "system" as const, text: "S" }, { role: "user" as const, text: "q" }] };
    expect(codexAdapter.buildCommand(cfg, astra, req).args.slice(cfg.args.length))
      .toEqual(["-m", "gpt-6-astra", "-c", 'model_reasoning_effort="low"', "-c", 'developer_instructions="S"', "-"]);
    // Only the override form is asserted here: ADAPTERS maps this adapter to
    // the `codex` provider alone, so the CLI it serves is the real one, which
    // takes the system prompt as `-c developer_instructions="..."` and not as
    // a bare `developer_instructions "<text>"` beside the `-`. The bare form
    // is exercised where it is real, on claude.ts, and on the shared helper.
    const renamed = { ...cfg, system_prompt_flag_prefix: "--config" };
    const c = codexAdapter.buildCommand(renamed, astra, req);
    expect(c.args.slice(cfg.args.length))
      .toEqual(["-m", "gpt-6-astra", "-c", 'model_reasoning_effort="low"', "--config", 'developer_instructions="S"', "-"]);
    expect(c.stdin).toBe("q");
  });
  it("passes a bare effort value when the provider declares no effort key", () => {
    const bare = { ...cfg, effort_key: null };
    const c = codexAdapter.buildCommand(bare, astra, { model: "codex-gpt-6-astra", stream: false, effort: "low", messages: [{ role: "user", text: "q" }] });
    expect(c.args.slice(cfg.args.length)).toEqual(["-m", "gpt-6-astra", "-c", "low", "-"]);
  });
  it("parses exec --json output into one text event and done with usage", async () => {
    const ev = await events(linesOf("test/fixtures/codex/exec-json-locked.jsonl"));
    // The thread id comes first, as meta: the image path needs it to find the
    // generated file, and the text path drops it (CliProvider.execute).
    expect(ev[0]).toMatchObject({ type: "meta" });
    expect(ev.slice(1)).toEqual([{ type: "text", delta: "OK" }, { type: "done", usage: { input: 10566, output: 5, cachedInput: 8448 } }]);
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
    const ev = (await events(linesOf("test/fixtures/codex/auth-expired.jsonl"))).filter((e) => e.type !== "meta");
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

describe("codex adapter, images", () => {
  it("names each image with --image, after the stdin marker that --image would otherwise swallow", () => {
    const c = codexAdapter.buildCommand(cfg, astra, { model: "codex-gpt-6-astra", stream: false, messages: [{ role: "user", text: "q" }],
      attachments: [{ mime: "image/png", bytes: Buffer.from("a") }, { mime: "image/jpeg", bytes: Buffer.from("b") }] });
    expect(c.args.slice(c.args.lastIndexOf("-"))).toEqual(["-", "--image", "attachment-1.png", "--image", "attachment-2.jpg"]);
  });
  it("adds nothing to a request with no image", () => {
    const c = codexAdapter.buildCommand(cfg, astra, { model: "codex-gpt-6-astra", stream: false, messages: [{ role: "user", text: "q" }] });
    expect(c.args.at(-1)).toBe("-");
    expect(c.args).not.toContain("--image");
  });
});
