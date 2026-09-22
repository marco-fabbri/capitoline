import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { antigravityAdapter, IMAGE_PROMPT } from "../src/providers/antigravity.js";
import { detectQuotaExhausted } from "../src/providers/errors.js";
import { loadConfig } from "../src/config.js";
import { modelSpecs } from "../src/providers/adapter.js";
import type { AdapterEvent } from "../src/core/types.js";

const cfg = loadConfig("config/capitoline.yaml").providers.antigravity;
const models = modelSpecs("antigravity", cfg);
const flash = models.find((m) => m.name === "antigravity-gemini-flash")!;
const pro = models.find((m) => m.name === "antigravity-gemini-pro")!;
const opus = models.find((m) => m.name === "antigravity-claude-opus")!;
async function* linesOf(path: string) { for (const l of readFileSync(path, "utf8").split("\n")) yield l; }
async function events(src: AsyncIterable<string>) { const out: AdapterEvent[] = []; for await (const e of antigravityAdapter.parse(src)) out.push(e); return out; }

describe("antigravity adapter", () => {
  it("encodes effort in the model id and sends the prompt as an NDJSON user event", () => {
    const c = antigravityAdapter.buildCommand(cfg, flash, { model: "antigravity-gemini-flash", stream: true, effort: "high", messages: [{ role: "user", text: "q" }] });
    expect(c.args[c.args.indexOf("--model") + 1]).toBe("gemini-3.8-flash-high");
    expect(JSON.parse(c.stdin.trim())).toEqual({ event: "user", message: { role: "user", content: "q" } });
    expect(c.stdin.endsWith("\n")).toBe(true);
  });
  it("approximates a missing effort level to the nearest allowed one", () => {
    const c = antigravityAdapter.buildCommand(cfg, pro, { model: "antigravity-gemini-pro", stream: true, effort: "medium", messages: [{ role: "user", text: "q" }] });
    expect(c.args[c.args.indexOf("--model") + 1]).toBe("gemini-3.1-pro-high");
  });
  it("leaves the id alone for models without an effort suffix and prepends the system prompt", () => {
    const c = antigravityAdapter.buildCommand(cfg, opus, { model: "antigravity-claude-opus", stream: true, messages: [{ role: "system", text: "S" }, { role: "user", text: "q" }] });
    expect(c.args[c.args.indexOf("--model") + 1]).toBe("claude-opus-4-6-thinking");
    expect(JSON.parse(c.stdin).message.content).toBe("System instructions:\nS\n\nq");
  });
  it("builds an image command with the image args, no effort suffix and a fixed tool prompt", () => {
    const image = models.find((m) => m.name === "antigravity-image")!;
    // The repo config declares no image.args: give some, so their absence would be noticed.
    const withArgs = { ...cfg, image: { ...cfg.image, args: ["--image-flag"] } };
    const c = antigravityAdapter.buildImageCommand!(withArgs, image, { model: "antigravity-image", prompt: "a red bicycle" });
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
  it("takes the model flag from the configuration, for a chat and for an image", () => {
    // This CLI carries the effort inside the model id, so the repository
    // config declares no effort flag: the adapter must then add none.
    expect([cfg.model_flag, cfg.effort_flag, cfg.effort_key]).toEqual(["--model", null, null]);
    const renamed = { ...cfg, model_flag: "--model-id" };
    const c = antigravityAdapter.buildCommand(renamed, flash, { model: "antigravity-gemini-flash", stream: true, effort: "high", messages: [{ role: "user", text: "q" }] });
    expect(c.args.slice(cfg.args.length)).toEqual(["--model-id", "gemini-3.8-flash-high"]);
    const image = models.find((m) => m.name === "antigravity-image")!;
    const ci = antigravityAdapter.buildImageCommand!(renamed, image, { model: "antigravity-image", prompt: "a red bicycle" });
    expect(ci.args.slice(cfg.args.length)).toEqual(["--model-id", "gemini-3.8-flash-low"]);
  });
  it("adds the effort flag as well when the provider declares one", () => {
    const withFlag = { ...cfg, effort_flag: "--effort" };
    const c = antigravityAdapter.buildCommand(withFlag, opus, { model: "antigravity-claude-opus", stream: true, effort: "low", messages: [{ role: "user", text: "q" }] });
    expect(c.args.slice(cfg.args.length)).toEqual(["--model", "claude-opus-4-6-thinking", "--effort", "low"]);
  });
  it("leaves a suffixed model with one carrier of the effort even when a flag is declared", () => {
    // The level is already inside the model id, so the flag added to the file
    // must not repeat it: the id keeps "-high" and nothing else is appended.
    const withFlag = { ...cfg, effort_flag: "--effort" };
    const c = antigravityAdapter.buildCommand(withFlag, flash, { model: "antigravity-gemini-flash", stream: true, effort: "high", messages: [{ role: "user", text: "q" }] });
    expect(c.args.slice(cfg.args.length)).toEqual(["--model", "gemini-3.8-flash-high"]);
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
  it("counts the cached reads as input and the thinking tokens no more than once", async () => {
    // Reconstructed on purpose: the fixture is not a CLI print but the two
    // usage objects a host run of 2026-09-22 left written down in
    // plans/2026-09-22-backlog-close.md (gemini-3.1-pro-high, the same prompt
    // twice so the second run reads cache, both runs with non-zero thinking
    // tokens), so it carries status and usage where every other fixture here
    // is the whole result object. Recapture it as the CLI prints it, response
    // field included, when the host is next in reach.
    // What it pins is the one identity those numbers show, asserted at the
    // end: total_tokens is input_tokens + output_tokens, so the cached reads
    // are outside the total and belong in the input. It says nothing about
    // which side the thinking tokens sit on — docs/backlog.md keeps that open
    // — so the two expectations below pin today's choice, not a measurement.
    const runs = JSON.parse(readFileSync("test/fixtures/antigravity/usage-reasoning.json", "utf8")) as { result: { usage: Record<string, number> } }[];
    const usage: { input: number; output: number }[] = [];
    for (const line of runs) {
      const ev = await events((async function* () { yield JSON.stringify(line); })());
      expect(ev.map((e) => e.type)).toEqual(["done"]);
      usage.push((ev[0] as any).usage);
    }
    expect(usage[0]).toEqual({ input: 12887, output: 397 });
    expect(usage[1]).toEqual({ input: 12881, output: 357 });
    runs.forEach((line, i) => {
      const u = line.result.usage;
      // The identity itself: the CLI's total is input plus output and
      // nothing else, which is what puts the cached reads in the input.
      expect(u.total_tokens).toBe(u.input_tokens + u.output_tokens);
      expect(u.thinking_tokens).toBeGreaterThan(0);
      expect(usage[i].input + usage[i].output - u.cache_read_tokens).toBe(u.total_tokens);
    });
  });
  it("maps the real expired-credential capture to auth_expired", async () => {
    // The capture is the CLI's --print-json result object; in stream mode the
    // same object arrives inside an `event: result` envelope.
    const result = JSON.parse(readFileSync("test/fixtures/antigravity/auth-expired.json", "utf8")) as Record<string, unknown>;
    expect(result.status).toBe("ERROR");
    const ev = await events((async function* () { yield JSON.stringify({ event: "result", result }); })());
    expect(ev).toEqual([{ type: "error", kind: "auth_expired", detail: "authentication failed or timed out" }]);
  });
  it("maps an ERROR result to a typed error", async () => {
    const ev = await events(linesOf("test/fixtures/antigravity/stream-input-error.jsonl"));
    // The kind as well as the type: without it the Claude and Codex tests
    // pinned their classification and this one did not, so a refusal from
    // this CLI could be answered 502 with nothing failing here.
    expect(ev.at(-1)).toMatchObject({ type: "error", kind: "cli_crashed" });
    expect((ev.at(-1) as any).detail).toContain("missing the \"event\" field");
  });
  it("classifies the error text of an ERROR result", async () => {
    // Synthetic on purpose: no real rate-limit or expired-window capture from
    // the text path of this CLI exists yet (the backlog tracks it). The
    // wordings are the ones classifyError is written against, and the point is
    // that this adapter routes its own error text through it at all.
    const result = async (error?: string) =>
      (await events((async function* () { yield JSON.stringify({ event: "result", result: { status: "ERROR", ...(error === undefined ? {} : { error }) } }); })()))[0];
    expect(await result("429 Too Many Requests")).toEqual({ type: "error", kind: "rate_limited", detail: "429 Too Many Requests" });
    expect(await result("RESOURCE_EXHAUSTED: you have reached your usage limit")).toMatchObject({ kind: "rate_limited" });
    expect(await result("401 Unauthorized")).toEqual({ type: "error", kind: "auth_expired", detail: "401 Unauthorized" });
    expect(await result("not logged in: run agy login")).toMatchObject({ kind: "auth_expired" });
    expect(await result("segmentation fault")).toMatchObject({ kind: "cli_crashed" });
    // No error text at all: the status is the detail, so the log still says
    // which terminal state the run reached.
    expect(await result()).toEqual({ type: "error", kind: "cli_crashed", detail: "ERROR" });
  });
  it("keeps the configuration's own args as the command prefix, and adds nothing else", () => {
    // Nothing else pinned cfg.args as a prefix: dropping --input-format
    // stream-json or --sandbox from the adapter would have left every other
    // test here green while the real CLI stopped reading the NDJSON prompt and
    // lost its sandbox. The count is asserted too, so a stray argument fails.
    const c = antigravityAdapter.buildCommand(cfg, flash, { model: "antigravity-gemini-flash", stream: true, effort: "high", messages: [{ role: "user", text: "q" }] });
    expect(c.args.slice(0, cfg.args.length)).toEqual(cfg.args);
    expect(c.args).toHaveLength(cfg.args.length + 2);   // <model_flag> <id>; this provider declares no effort flag
    const image = models.find((m) => m.name === "antigravity-image")!;
    const withArgs = { ...cfg, image: { ...cfg.image, args: ["--image-flag"] } };
    const ci = antigravityAdapter.buildImageCommand!(withArgs, image, { model: "antigravity-image", prompt: "a red bicycle" });
    expect(ci.args.slice(0, cfg.args.length)).toEqual(cfg.args);
    expect(ci.args).toHaveLength(cfg.args.length + 1 + 2);   // then image.args, then <model_flag> <id>
  });
});
