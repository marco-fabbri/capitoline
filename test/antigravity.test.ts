import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { antigravityAdapter, IMAGE_PROMPT } from "../src/providers/antigravity.js";
import { detectQuotaExhausted } from "../src/providers/errors.js";
import { loadConfig } from "../src/config.js";
import { modelSpecs } from "../src/providers/adapter.js";
import type { AdapterEvent } from "../src/core/types.js";

const cfg = loadConfig("config/capitoline.yaml").providers.antigravity;
const models = modelSpecs("antigravity", cfg);
const flash = models.find((m) => m.name === "agy-gemini-flash")!;
const pro = models.find((m) => m.name === "agy-gemini-pro")!;
const opus = models.find((m) => m.name === "agy-claude-opus")!;
async function* linesOf(path: string) { for (const l of readFileSync(path, "utf8").split("\n")) yield l; }
async function events(src: AsyncIterable<string>) { const out: AdapterEvent[] = []; for await (const e of antigravityAdapter.parse(src)) out.push(e); return out; }

describe("antigravity adapter", () => {
  it("encodes effort in the model id and sends the prompt as an NDJSON user event", () => {
    const c = antigravityAdapter.buildCommand(cfg, flash, { model: "agy-gemini-flash", stream: true, effort: "high", messages: [{ role: "user", text: "q" }] });
    expect(c.args[c.args.indexOf("--model") + 1]).toBe("gemini-3.8-flash-high");
    expect(JSON.parse(c.stdin.trim())).toEqual({ event: "user", message: { role: "user", content: "q" } });
    expect(c.stdin.endsWith("\n")).toBe(true);
  });
  it("approximates a missing effort level to the nearest allowed one", () => {
    const c = antigravityAdapter.buildCommand(cfg, pro, { model: "agy-gemini-pro", stream: true, effort: "medium", messages: [{ role: "user", text: "q" }] });
    expect(c.args[c.args.indexOf("--model") + 1]).toBe("gemini-3.1-pro-high");
  });
  it("leaves the id alone for models without an effort suffix and prepends the system prompt", () => {
    const c = antigravityAdapter.buildCommand(cfg, opus, { model: "agy-claude-opus", stream: true, messages: [{ role: "system", text: "S" }, { role: "user", text: "q" }] });
    expect(c.args[c.args.indexOf("--model") + 1]).toBe("claude-opus-4-6-thinking");
    expect(JSON.parse(c.stdin).message.content).toBe("System instructions:\nS\n\nq");
  });
  it("builds an image command with the image args, no effort suffix and a fixed tool prompt", () => {
    const image = models.find((m) => m.name === "agy-image")!;
    // The repo config declares no image.args: give some, so their absence would be noticed.
    const withArgs = { ...cfg, image: { ...cfg.image, args: ["--image-flag"] } };
    const c = antigravityAdapter.buildImageCommand!(withArgs, image, { model: "agy-image", prompt: "a red bicycle" });
    expect(c.args).toEqual([...cfg.args, "--image-flag", "--model", "gemini-3.8-flash-low"]);
    expect(c.args).not.toContain("gemini-3.8-flash-low-low"); // image models never get the effort suffix
    const msg = JSON.parse(c.stdin.trim());
    expect(msg.event).toBe("user");
    // The prompt is the first line of defence against other tool calls: its
    // whole text is pinned, so dropping the forbidding sentence fails here.
    expect(msg.message.content).toBe(IMAGE_PROMPT("a red bicycle"));
    expect(IMAGE_PROMPT("a red bicycle")).toBe(
      'Use the generate_image tool exactly once, with ImageName "image", to create this image: a red bicycle\n' +
      "Do not create, read, copy or modify any file, do not run commands, do not open a browser. When the tool has finished, reply only with the single word: done",
    );
    expect(c.stdin.endsWith("\n")).toBe(true);
  });
  it("parses stream-json into text deltas and done with usage", async () => {
    const ev = await events(linesOf("test/fixtures/antigravity/stream-json.jsonl"));
    expect(ev.filter((e) => e.type === "text").map((e) => (e as any).delta).join("")).toBe("ok ok\n");
    expect(ev.at(-1)).toEqual({ type: "done", usage: { input: 14198, output: 2 } });
  });
  it("yields meta, tool call/done, text and done in order for a real image run", async () => {
    const ev = await events(linesOf("test/fixtures/antigravity/image-run.jsonl"));
    expect(ev.map((e) => e.type)).toEqual(["meta", "tool", "tool", "text", "text", "done"]);
    expect(ev[0]).toEqual({ type: "meta", conversationId: "40fc0b5c-042f-453a-9eaf-6162913de55e" });
    expect(ev[1]).toMatchObject({ type: "tool", phase: "call", name: "generate_image" });
    expect(ev[2]).toMatchObject({ type: "tool", phase: "done", name: "generate_image" });
    // raw is the whole step_update, so the provider can inspect parameters or errors.
    expect(JSON.parse((ev[1] as any).raw).tool_info.parameters).toEqual({ ImageName: "image", Prompt: "a lighthouse on a cliff at dawn, watercolour" });
    expect(ev.filter((e) => e.type === "text").map((e) => (e as any).delta).join("")).toBe("./image.png\n");
    expect(ev.at(-1)).toMatchObject({ type: "done", usage: { input: 26711, output: 60 } });
  });
  it("yields a tool error carrying the 429 body, then text and a successful done (the silent failure)", async () => {
    const ev = await events(linesOf("test/fixtures/antigravity/image-429.jsonl"));
    expect(ev.map((e) => e.type)).toEqual(["meta", "tool", "tool", "text", "done"]);
    expect(ev[1]).toMatchObject({ type: "tool", phase: "call", name: "generate_image" });
    expect(ev[2]).toMatchObject({ type: "tool", phase: "error", name: "generate_image" });
    // raw is the whole step_update as JSON, and it is what the provider hands
    // to detectQuotaExhausted: both halves of that contract are pinned here.
    const raw = (ev[2] as any).raw as string;
    expect(JSON.parse(raw).tool_info.error.type).toBe("TOOL_ERROR");
    expect(raw).toContain("429 Too Many Requests");
    expect(detectQuotaExhausted(raw, Date.parse("2026-09-21T12:00:00Z"))).toMatchObject({
      model: "gemini-3.1-flash-image", resetAt: Date.parse("2026-09-26T18:40:40Z"), retryAfterS: 442209,
    });
    expect(ev[3]).toEqual({ type: "text", delta: "done\n" });
    expect(ev.at(-1)!.type).toBe("done"); // status SUCCESS: no error event from the result
    expect(ev.some((e) => e.type === "error")).toBe(false);
  });
  it("reads the conversation id from init.conversation_id when it is not top-level", async () => {
    const ev = await events((async function* () {
      yield JSON.stringify({ event: "init", init: { conversation_id: "11111111-2222-4333-8444-555555555555", model: "m" } });
      yield JSON.stringify({ event: "result", result: { conversation_id: "11111111-2222-4333-8444-555555555555", status: "SUCCESS", usage: { input_tokens: 1, output_tokens: 1 } } });
    })());
    expect(ev.map((e) => e.type)).toEqual(["meta", "done"]);
    expect(ev[0]).toEqual({ type: "meta", conversationId: "11111111-2222-4333-8444-555555555555" });
  });
  it("yields meta from the result's conversation_id when no init was seen, and never twice", async () => {
    const ev = await events((async function* () {
      yield JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "hi" } });
      yield JSON.stringify({ event: "result", result: { conversation_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", status: "SUCCESS", usage: { input_tokens: 1, output_tokens: 1 } } });
    })());
    expect(ev.map((e) => e.type)).toEqual(["text", "meta", "done"]);
    expect(ev[1]).toEqual({ type: "meta", conversationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" });
    const withInit = await events(linesOf("test/fixtures/antigravity/image-run.jsonl"));
    expect(withInit.filter((e) => e.type === "meta")).toHaveLength(1);
  });
  it("reports a tool step as a call on its first sighting, whatever its state", async () => {
    // The CLI does not always send ACTIVE before DONE (user_input and
    // agent_response steps in the fixtures appear once, already DONE): a
    // forbidden tool reported only in its terminal state must still reach the
    // provider's guard as a call.
    const step = (step_index: number, state: string | undefined, tool_name: string) =>
      JSON.stringify({ event: "step_update", step_update: { step_index, ...(state ? { state } : {}), step_type: "tool", tool_name, tool_info: { name: tool_name } } });
    const ev = await events((async function* () {
      yield step(2, "DONE", "run_command");
      yield step(3, "ERROR", "write_to_file");
      yield step(4, "CANCELLED", "generate_image");
      yield step(4, "CANCELLED", "generate_image");
      yield step(5, undefined, "generate_image");
      yield JSON.stringify({ event: "result", result: { status: "SUCCESS", usage: { input_tokens: 1, output_tokens: 1 } } });
    })());
    expect(ev.map((e) => e.type === "tool" ? `${e.phase}:${e.name}` : e.type)).toEqual([
      "call:run_command", "done:run_command",
      "call:write_to_file", "error:write_to_file",
      "call:generate_image", "call:generate_image", // unknown states stay calls: fail closed
      "call:generate_image",
      "done",
    ]);
  });
  it("falls back to tool_info.name and treats a step without an index as a new call every time", async () => {
    const line = JSON.stringify({ event: "step_update", step_update: { state: "ACTIVE", step_type: "tool", tool_info: { name: "generate_image" } } });
    const ev = await events((async function* () { yield line; yield line; })());
    expect(ev).toEqual([
      { type: "tool", phase: "call", name: "generate_image", raw: JSON.stringify(JSON.parse(line).step_update) },
      { type: "tool", phase: "call", name: "generate_image", raw: JSON.stringify(JSON.parse(line).step_update) },
    ]);
  });
  it("ignores a conversation id that is not a UUID, wherever it is announced", async () => {
    // The id becomes an argument of the collect command: only the UUID shape leaves the adapter.
    const ev = await events((async function* () {
      yield JSON.stringify({ event: "init", conversation_id: "../../../etc/passwd", init: { conversation_id: "../../../etc/passwd" } });
      yield JSON.stringify({ event: "result", result: { conversation_id: "40fc0b5c-042f-453a-9eaf-6162913de55e; rm -rf /", status: "SUCCESS", usage: { input_tokens: 1, output_tokens: 1 } } });
    })());
    expect(ev.map((e) => e.type)).toEqual(["done"]);
  });
  it("maps an ERROR result to a typed error", async () => {
    const ev = await events(linesOf("test/fixtures/antigravity/stream-input-error.jsonl"));
    expect(ev.at(-1)!.type).toBe("error");
    expect((ev.at(-1) as any).detail).toContain("missing the \"event\" field");
  });
});
