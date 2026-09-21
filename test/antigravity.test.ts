import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { antigravityAdapter } from "../src/providers/antigravity.js";
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
    expect(msg.message.content).toContain('Use the generate_image tool exactly once, with ImageName "image", to create this image: a red bicycle');
    expect(msg.message.content).toContain("reply only with the single word: done");
    expect(c.stdin.endsWith("\n")).toBe(true);
  });
  it("parses stream-json into text deltas and done with usage", async () => {
    const ev = await events(linesOf("test/fixtures/antigravity/stream-json.jsonl"));
    expect(ev.filter((e) => e.type === "text").map((e) => (e as any).delta).join("")).toBe("ok ok\n");
    expect(ev.at(-1)).toEqual({ type: "done", usage: { input: 14198, output: 2 } });
  });
  it("maps an ERROR result to a typed error", async () => {
    const ev = await events(linesOf("test/fixtures/antigravity/stream-input-error.jsonl"));
    expect(ev.at(-1)!.type).toBe("error");
    expect((ev.at(-1) as any).detail).toContain("missing the \"event\" field");
  });
});
