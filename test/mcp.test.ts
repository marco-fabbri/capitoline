import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server/app.js";
import { createMcpHandler } from "../src/mcp/server.js";
import { Core } from "../src/core/core.js";
import { UsageStore } from "../src/usage/store.js";
import type { ProviderEvent } from "../src/core/types.js";
import { FakeProvider } from "./fake-provider.js";
import { createLogger } from "../src/log.js";

// A JPEG header is enough for the fake: the tool never inspects the bytes.
const JPEG = Buffer.from("ffd8ffe000104a464946", "hex");
const IMG: ProviderEvent = { type: "image", mime: "image/jpeg", bytes: JPEG, width: 1376, height: 768 };

let server: Server, url: string, provider: FakeProvider, images: FakeProvider, core: Core;

beforeAll(async () => {
  provider = new FakeProvider("claude", ["claude-opus"], [{ type: "text", delta: "answer" }, { type: "done", usage: { input: 5, output: 1 } }]);
  images = new FakeProvider("antigravity", [{ name: "agy-image", kind: "image" }], []);
  images.imageScript = [{ type: "text", delta: "saved as ./image.png" }, IMG, { type: "done" }];
  core = new Core([provider, images], new UsageStore(":memory:"), { maxWaitMs: 100, budgets: {}, log: createLogger("t") });
  const app = createApp(core, { log: createLogger("t"), mcp: createMcpHandler(core, createLogger("t"), { progressIntervalMs: 20 }) });
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function client() {
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(url)));
  return c;
}

type Block = { type: string; text?: string; data?: string; mimeType?: string };

describe("MCP", () => {
  it("lists the three tools", async () => {
    const c = await client();
    const tools = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["ask_model", "generate_image", "list_models"]);
    await c.close();
  });
  it("list_models returns the registry with each model's kind", async () => {
    const c = await client();
    const r = await c.callTool({ name: "list_models", arguments: {} });
    const text = (r.content as { type: string; text: string }[])[0].text;
    expect(JSON.parse(text)).toEqual([
      { name: "claude-opus", provider: "claude", kind: "text", available: true, over_budget: false },
      { name: "agy-image", provider: "antigravity", kind: "image", available: true, over_budget: false },
    ]);
    await c.close();
  });
  it("ask_model returns the answer, usage and passes effort and system", async () => {
    const c = await client();
    const r = await c.callTool({ name: "ask_model", arguments: { model: "claude-opus", prompt: "q", effort: "low", system: "S" } });
    expect((r.content as { text: string }[])[0].text).toBe("answer");
    expect(r.structuredContent).toEqual({ model: "claude-opus", provider: "claude", usage: { prompt_tokens: 5, completion_tokens: 1 } });
    expect(provider.calls.at(-1)!.messages).toEqual([{ role: "system", text: "S" }, { role: "user", text: "q" }]);
    expect(provider.calls.at(-1)!.effort).toBe("low");
    await c.close();
  });
  it("ask_model refuses an image model as a tool error", async () => {
    const c = await client();
    const r = await c.callTool({ name: "ask_model", arguments: { model: "agy-image", prompt: "q" } });
    expect(r.isError).toBe(true);
    expect((r.content as Block[])[0].text).toMatch(/bad_request/);
    expect(images.imageCalls).toHaveLength(0);
    await c.close();
  });

  describe("generate_image", () => {
    it("returns the image as an image block plus the structured description, without the agent's prose", async () => {
      const c = await client();
      const r = await c.callTool({ name: "generate_image", arguments: { prompt: "a lighthouse", model: "agy-image" } });
      expect(r.isError).toBeFalsy();
      const content = r.content as Block[];
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe("image");
      expect(content[0].mimeType).toBe("image/jpeg");
      expect(Buffer.from(content[0].data!, "base64")).toEqual(JPEG);
      expect(JSON.stringify(r)).not.toContain("./image.png");
      expect(r.structuredContent).toEqual({ model: "agy-image", provider: "antigravity", mime: "image/jpeg", width: 1376, height: 768, bytes: JPEG.length });
      expect(images.imageCalls.at(-1)).toEqual({ model: "agy-image", prompt: "a lighthouse" });
      await c.close();
    });
    it("defaults to the first image model when model is omitted", async () => {
      const c = await client();
      const r = await c.callTool({ name: "generate_image", arguments: { prompt: "a lighthouse" } });
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent).toMatchObject({ model: "agy-image", provider: "antigravity" });
      expect(images.imageCalls.at(-1)).toEqual({ model: "agy-image", prompt: "a lighthouse" });
      await c.close();
    });
    it("refuses an empty prompt", async () => {
      const c = await client();
      const before = images.imageCalls.length;
      const r = await c.callTool({ name: "generate_image", arguments: { prompt: "" } });
      expect(r.isError).toBe(true);
      expect(images.imageCalls).toHaveLength(before);
      await c.close();
    });
    it("refuses a text model as a tool error", async () => {
      const c = await client();
      const before = provider.calls.length;
      const r = await c.callTool({ name: "generate_image", arguments: { prompt: "a lighthouse", model: "claude-opus" } });
      expect(r.isError).toBe(true);
      expect((r.content as Block[])[0].text).toMatch(/bad_request/);
      expect(provider.calls).toHaveLength(before);
      await c.close();
    });
    it("sends progress notifications while the generation runs, when the client asked for them", async () => {
      images.delayMs = 60;
      try {
        const c = await client();
        const seen: number[] = [];
        const r = await c.callTool({ name: "generate_image", arguments: { prompt: "a lighthouse" } }, undefined, { onprogress: (p) => { seen.push(p.progress); } });
        expect(r.isError).toBeFalsy();
        expect(seen.length).toBeGreaterThanOrEqual(2);
        expect(seen).toEqual([...seen].sort((a, b) => a - b));
        await c.close();
      } finally { images.delayMs = 0; }
    });
    it("reports a rate limit as a tool error with the wait Core installed", async () => {
      images.imageScript = [{ type: "error", kind: "rate_limited", detail: "429 secret body", retryAfterS: 442_209 }];
      const c = await client();
      const r = await c.callTool({ name: "generate_image", arguments: { prompt: "a lighthouse" } });
      expect(r.isError).toBe(true);
      const text = (r.content as Block[])[0].text!;
      expect(text).toMatch(/rate_limited/);
      expect(text).toMatch(/retry after \d+s/);
      expect(Number(/retry after (\d+)s/.exec(text)![1])).toBe(core.pauseRemainingS("antigravity"));
      expect(text).not.toContain("secret body");
      await c.close();
    });
  });

  it("reports provider errors as tool errors", async () => {
    provider.script = [{ type: "error", kind: "rate_limited", detail: "429" }];
    const c = await client();
    const r = await c.callTool({ name: "ask_model", arguments: { model: "claude-opus", prompt: "q" } });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0].text).toMatch(/rate_limited/);
    await c.close();
  });
});
