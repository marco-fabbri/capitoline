import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server/app.js";
import { createMcpHandler } from "../src/mcp/server.js";
import { Core } from "../src/core/core.js";
import { UsageStore } from "../src/usage/store.js";
import { FakeProvider } from "./fake-provider.js";
import { createLogger } from "../src/log.js";

let server: Server, url: string, provider: FakeProvider;

beforeAll(async () => {
  provider = new FakeProvider("claude", ["claude-opus"], [{ type: "text", delta: "answer" }, { type: "done", usage: { input: 5, output: 1 } }]);
  const core = new Core([provider], new UsageStore(":memory:"), { maxWaitMs: 100, budgets: {}, log: createLogger("t") });
  const app = createApp(core, { log: createLogger("t"), mcp: createMcpHandler(core, createLogger("t")) });
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function client() {
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(url)));
  return c;
}

describe("MCP", () => {
  it("lists the two tools", async () => {
    const c = await client();
    const tools = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["ask_model", "list_models"]);
    await c.close();
  });
  it("list_models returns the registry", async () => {
    const c = await client();
    const r = await c.callTool({ name: "list_models", arguments: {} });
    const text = (r.content as { type: string; text: string }[])[0].text;
    expect(JSON.parse(text)).toEqual([{ name: "claude-opus", provider: "claude", available: true, over_budget: false }]);
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
  it("reports provider errors as tool errors", async () => {
    provider.script = [{ type: "error", kind: "rate_limited", detail: "429" }];
    const c = await client();
    const r = await c.callTool({ name: "ask_model", arguments: { model: "claude-opus", prompt: "q" } });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0].text).toMatch(/rate_limited/);
    await c.close();
  });
});
