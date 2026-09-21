import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server/app.js";
import { createMcpHandler } from "../src/mcp/server.js";
import { Core } from "../src/core/core.js";
import { UsageStore } from "../src/usage/store.js";
import type { ProviderEvent } from "../src/core/types.js";
import pino from "pino";
import { FakeProvider } from "./fake-provider.js";
import { createLogger } from "../src/log.js";
import type { RequestHandler } from "express";
import type { Identity } from "../src/server/access.js";
import request from "supertest";

// A JPEG header is enough for the fake: the tool never inspects the bytes.
const JPEG = Buffer.from("ffd8ffe000104a464946", "hex");
const IMG: ProviderEvent = { type: "image", mime: "image/jpeg", bytes: JPEG, width: 1376, height: 768 };

let server: Server, url: string, provider: FakeProvider, images: FakeProvider, core: Core, usage: UsageStore;
// What the MCP layer logged: a tool error is a warn line, and some of the
// rules under test are about which line an operator ends up reading.
let warnings: Record<string, unknown>[];

// Fresh providers, Core and app per test: a test that scripts a 429 leaves the
// provider paused for days inside Core, which no reassignment of the fake's
// script can undo, and the next generate_image test would silently get a 429.
beforeEach(async () => {
  provider = new FakeProvider("claude", ["claude-opus"], [{ type: "text", delta: "answer" }, { type: "done", usage: { input: 5, output: 1 } }]);
  images = new FakeProvider("antigravity", [{ name: "agy-image", kind: "image" }], []);
  images.imageScript = [{ type: "text", delta: "saved as ./image.png" }, IMG, { type: "done" }];
  usage = new UsageStore(":memory:");
  core = new Core([provider, images], usage, { maxWaitMs: 100, budgets: {}, log: createLogger("t") });
  warnings = [];
  const mcpLog = pino({ name: "t", level: "warn" }, { write: (line: string) => { warnings.push(JSON.parse(line) as Record<string, unknown>); } });
  // /mcp sits behind Access in production, so the handler sees an identity:
  // the service token Claude Code is configured with. This stub authenticates
  // every request — it is here for attribution, not for placement, which the
  // last test of this file and test/server.test.ts pin with a denying one.
  const identity: Identity = { sub: "", type: "service", name: "claude-code" };
  const access: RequestHandler = (_req, res, next) => { res.locals.identity = identity; next(); };
  const app = createApp(core, { log: createLogger("t"), access, mcp: createMcpHandler(core, mcpLog, { progressIntervalMs: 20 }) });
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
});
// closeAllConnections: a test that hangs up mid-call leaves a socket the
// server would otherwise wait on forever.
afterEach(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));

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
      { name: "agy-image", provider: "antigravity", kind: "image", available: true, over_budget: false, quota: { used: 0, limit: null, windowStartedAt: null, resetAt: null } },
    ]);
    await c.close();
  });
  it("list_models still carries the quota, with its reset, once the image quota is exhausted", async () => {
    images.imageScript = [{ type: "error", kind: "rate_limited", detail: "429", retryAfterS: 442_209 }];
    const sent = Date.now();
    const c = await client();
    await c.callTool({ name: "generate_image", arguments: { prompt: "a lighthouse", model: "agy-image" } });
    const r = await c.callTool({ name: "list_models", arguments: {} });
    const models = JSON.parse((r.content as Block[])[0].text!) as { name: string; available: boolean; reason?: string; quota?: { resetAt: number | null } }[];
    const image = models.find((m) => m.name === "agy-image")!;
    // /v1/models drops an unavailable model, so this tool is where a client
    // reads when the exhausted quota frees up.
    expect(image).toMatchObject({ available: false, reason: "rate_limited" });
    expect(image.quota!.resetAt).toBeGreaterThanOrEqual(sent + 442_209 * 1000);
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
    // The reason, not only the kind: it is Capitoline's own text (spec 8.3
    // covers CLI output), and it is what lets the agent pick another model.
    expect((r.content as Block[])[0].text).toMatch(/bad_request.*generates images/);
    // execute() is the call the kind guard must stop: imageCalls could never
    // grow here, whether or not the guard exists.
    expect(images.calls).toHaveLength(0);
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
    it("still defaults to a declared image model when no image model is available", async () => {
      images.imageScript = [{ type: "error", kind: "rate_limited", detail: "429", retryAfterS: 30 }];
      const c = await client();
      await c.callTool({ name: "generate_image", arguments: { prompt: "a lighthouse", model: "agy-image" } });
      // agy-image is now unavailable (its provider is paused). The default must
      // still land on it, so the caller gets that provider's own 429 rather
      // than "no image model is configured", which would be a wrong diagnosis.
      const r = await c.callTool({ name: "generate_image", arguments: { prompt: "a lighthouse" } });
      expect(r.isError).toBe(true);
      expect((r.content as Block[])[0].text).toMatch(/rate_limited/);
      expect(images.imageCalls).toHaveLength(1);
      await c.close();
    });
    it("refuses an empty prompt", async () => {
      const c = await client();
      const r = await c.callTool({ name: "generate_image", arguments: { prompt: "" } });
      expect(r.isError).toBe(true);
      expect(images.imageCalls).toHaveLength(0);
      await c.close();
    });
    it("refuses an empty model in the schema, not as a missing default", async () => {
      const c = await client();
      const r = await c.callTool({ name: "generate_image", arguments: { prompt: "a lighthouse", model: "" } });
      expect(r.isError).toBe(true);
      expect((r.content as Block[])[0].text).toMatch(/model/);
      expect((r.content as Block[])[0].text).not.toMatch(/no image model is configured/);
      expect(images.imageCalls).toHaveLength(0);
      await c.close();
    });
    it("refuses a text model as a tool error", async () => {
      const c = await client();
      // The distinctive reason, not just the kind: "provider cannot generate
      // images" is bad_request too and would hide a missing kind check.
      const r = await c.callTool({ name: "generate_image", arguments: { prompt: "a lighthouse", model: "claude-opus" } });
      expect(r.isError).toBe(true);
      expect((r.content as Block[])[0].text).toMatch(/bad_request.*is a text model/);
      await c.close();
    });
    it("reports a provider that ends without an image as bad_output", async () => {
      images.imageScript = [{ type: "text", delta: "I could not draw that" }, { type: "done" }];
      const c = await client();
      const r = await c.callTool({ name: "generate_image", arguments: { prompt: "a lighthouse" } });
      expect(r.isError).toBe(true);
      expect((r.content as Block[])[0].text).toMatch(/bad_output/);
      await c.close();
    });
    it("answers a cancelled call as cancelled, not as a provider that returned no image", async () => {
      // A cancelled generation and a broken one look the same from the loop:
      // no image event, no error event. The script has no image at all, so a
      // handler that ignored the signal would log bad_output here.
      images.imageScript = [{ type: "text", delta: "drawing" }, { type: "done" }];
      images.delayMs = 100;
      const c = await client();
      // The client hangs up while the CLI is still drawing (Esc in Claude
      // Code): the transport closes and the SDK aborts the handler's signal.
      const call = c.callTool({ name: "generate_image", arguments: { prompt: "a lighthouse" } });
      setTimeout(() => { void c.close(); }, 50);
      await expect(call).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 250)); // let the handler finish
      expect(warnings).toHaveLength(0);
    });
    it("sends progress notifications while the generation runs, when the client asked for them", async () => {
      images.delayMs = 60;
      const c = await client();
      const seen: number[] = [];
      const r = await c.callTool({ name: "generate_image", arguments: { prompt: "a lighthouse" } }, undefined, { onprogress: (p) => { seen.push(p.progress); } });
      expect(r.isError).toBeFalsy();
      expect(seen.length).toBeGreaterThanOrEqual(2);
      expect(seen).toEqual([...seen].sort((a, b) => a - b));
      await c.close();
    });
    it("sends no progress notification when the client did not ask for one", async () => {
      images.delayMs = 60; // long enough for several ticks of the 20 ms timer
      const c = await client();
      const seen: unknown[] = [];
      c.fallbackNotificationHandler = async (n) => { seen.push(n); };
      const r = await c.callTool({ name: "generate_image", arguments: { prompt: "a lighthouse" } });
      expect(r.isError).toBeFalsy();
      expect(seen).toHaveLength(0);
      await c.close();
    });
    it("reports a rate limit as a tool error with the wait Core installed", async () => {
      images.imageScript = [{ type: "error", kind: "rate_limited", detail: "429 secret body", retryAfterS: 442_209 }];
      const c = await client();
      const r = await c.callTool({ name: "generate_image", arguments: { prompt: "a lighthouse" } });
      expect(r.isError).toBe(true);
      const text = (r.content as Block[])[0].text!;
      expect(text).toMatch(/rate_limited/);
      // The pause Core installed (the CLI's figure plus its minute of slack),
      // not the raw 442_209 the provider reported.
      expect(Number(/retry after (\d+)s/.exec(text)![1])).toBe(442_269);
      expect(text).not.toContain("secret body");
      await c.close();
    });
  });

  it("puts the model's own pause in the retry hint when the refusal named the model", async () => {
    // Same rule as the HTTP layer: the pause landed on the model alone, so
    // only core.pauseRemainingS(provider, model) sees it. Without the model
    // the hint would be the CLI's raw 10 s and the caller would retry into a
    // pause that still has a minute to run.
    provider.script = [{ type: "error", kind: "rate_limited", detail: "reached your claude-opus limit", scope: "model", retryAfterS: 10 }];
    const c = await client();
    const r = await c.callTool({ name: "ask_model", arguments: { model: "claude-opus", prompt: "q" } });
    expect(r.isError).toBe(true);
    const text = (r.content as Block[])[0].text!;
    expect(text).toMatch(/rate_limited/);
    expect(Number(/retry after (\d+)s/.exec(text)![1])).toBe(70);
    expect(core.pauseRemainingS("claude")).toBeUndefined();
    await c.close();
  });

  // B4: an MCP call is attributed like an HTTP one. The identity is the same
  // Access identity, which the handler reads off the response it was mounted on.
  it("records the caller of a tool call", async () => {
    const c = await client();
    await c.callTool({ name: "ask_model", arguments: { model: "claude-opus", prompt: "q" } });
    expect(usage.callers(60_000)).toEqual([{ caller: "claude-code", calls: 1, inputTokens: 5, outputTokens: 1 }]);
    await c.close();
  });

  it("reports provider errors as tool errors", async () => {
    provider.script = [{ type: "error", kind: "rate_limited", detail: "429" }];
    const c = await client();
    const r = await c.callTool({ name: "ask_model", arguments: { model: "claude-opus", prompt: "q" } });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0].text).toMatch(/rate_limited/);
    await c.close();
  });

  // Every other test in this file runs behind a stub that authenticates
  // unconditionally, so none of them would notice a refactor that mounted
  // /mcp ahead of the Access middleware. This one builds its own app with a
  // denying stub: the tool call never gets that far, a 401 does.
  it("is mounted behind the Access middleware, unlike /health", async () => {
    const deny: RequestHandler = (_req, res) => { res.status(401).json({ error: { code: "unauthorized" } }); };
    const app = createApp(core, { log: createLogger("t"), access: deny, mcp: createMcpHandler(core, createLogger("t")) });
    expect((await request(app).post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
    expect((await request(app).get("/health")).status).toBe(200);
  });
});
