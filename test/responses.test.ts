import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Server } from "node:http";
import request from "supertest";
import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RequestHandler } from "express";
import { createApp } from "../src/server/app.js";
import { createMcpHandler } from "../src/mcp/server.js";
import { Core } from "../src/core/core.js";
import { UsageStore } from "../src/usage/store.js";
import { ConversationStore } from "../src/conversations/store.js";
import { createLogger } from "../src/log.js";
import type { InternalRequest, ProviderEvent } from "../src/core/types.js";
import { FakeProvider } from "./fake-provider.js";

// The Responses API (POST /v1/responses) and the MCP ask_model conversation:
// a conversation kept on the server, replayed as text through Core, and the
// caller's own. The fake provider answers with the number of messages it was
// sent, so a test can see the history arrive without reading the prompt.
const answer = (req: InternalRequest): ProviderEvent[] => [
  { type: "text", delta: "seen " }, { type: "text", delta: String(req.messages.length) },
  { type: "done", usage: { input: 7, output: 2 } },
];

let provider: FakeProvider, conversations: ConversationStore, app: ReturnType<typeof createApp>;
// Who is calling comes from a test header, standing in for the key middleware.
const asHeader: RequestHandler = (req, res, next) => {
  res.locals.identity = { type: "key", name: req.header("x-test-caller") ?? "app-one", sub: "key:x" };
  next();
};

function build(limits = { maxTurns: 100, maxBytes: 2_000_000 }) {
  provider = new FakeProvider("claude", ["claude-opus", { name: "claude-image", kind: "image" }], answer, 4);
  const usage = new UsageStore(":memory:");
  const core = new Core([provider], usage, { maxWaitMs: 5_000, budgets: {}, log: createLogger("t") });
  conversations = new ConversationStore(":memory:", 30);
  const conv = { store: conversations, limits };
  app = createApp(core, { log: createLogger("t"), access: asHeader, conversations: conv, mcp: createMcpHandler(core, createLogger("t"), { conversations: conv }) });
}

const post = (body: object, caller = "app-one") => request(app).post("/v1/responses").set("x-test-caller", caller).send(body);

describe("POST /v1/responses", () => {
  beforeEach(() => build());

  it("answers with a response object and keeps it", async () => {
    const r = await post({ model: "claude-opus", input: "hi" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ object: "response", status: "completed", model: "claude-opus", output_text: "seen 1", store: true, previous_response_id: null });
    expect(r.body.id).toMatch(/^resp_/);
    expect(r.body.output[0]).toMatchObject({ type: "message", role: "assistant", content: [{ type: "output_text", text: "seen 1" }] });
    expect(r.body.usage).toMatchObject({ input_tokens: 7, output_tokens: 2, total_tokens: 9 });
    expect(conversations.get(r.body.id, "app-one")?.output).toBe("seen 1");
  });

  it("replays the kept turns on previous_response_id, without the earlier instructions", async () => {
    const first = await post({ model: "claude-opus", input: "hi", instructions: "be terse" });
    expect(provider.calls[0].messages[0]).toEqual({ role: "system", text: "be terse" });
    const second = await post({ model: "claude-opus", input: [{ role: "user", content: [{ type: "input_text", text: "again" }] }], previous_response_id: first.body.id });
    expect(second.status).toBe(200);
    expect(provider.calls[1].messages).toEqual([
      { role: "user", text: "hi" }, { role: "assistant", text: "seen 2" }, { role: "user", text: "again" },
    ]);
    expect(second.body.previous_response_id).toBe(first.body.id);
  });

  it("answers 404 to another caller, and to an id it never issued", async () => {
    const first = await post({ model: "claude-opus", input: "hi" });
    const other = await post({ model: "claude-opus", input: "mine?", previous_response_id: first.body.id }, "app-two");
    expect(other.status).toBe(404);
    expect(other.body.error.code).toBe("not_found");
    expect((await request(app).get(`/v1/responses/${first.body.id}`).set("x-test-caller", "app-two")).status).toBe(404);
    expect((await post({ model: "claude-opus", input: "x", previous_response_id: "resp_nothing" })).status).toBe(404);
  });

  it("writes nothing with store: false", async () => {
    const r = await post({ model: "claude-opus", input: "hi", store: false });
    expect(r.status).toBe(200);
    expect(r.body.store).toBe(false);
    expect(conversations.get(r.body.id, "app-one")).toBeNull();
  });

  it("retrieves a kept response and deletes its whole conversation", async () => {
    const first = await post({ model: "claude-opus", input: "hi" });
    const second = await post({ model: "claude-opus", input: "again", previous_response_id: first.body.id });
    const got = await request(app).get(`/v1/responses/${second.body.id}`).set("x-test-caller", "app-one");
    expect(got.body).toMatchObject({ id: second.body.id, output_text: "seen 3", previous_response_id: first.body.id });
    const del = await request(app).delete(`/v1/responses/${second.body.id}`).set("x-test-caller", "app-one");
    expect(del.body).toEqual({ id: second.body.id, object: "response", deleted: true });
    expect((await request(app).get(`/v1/responses/${first.body.id}`).set("x-test-caller", "app-one")).status).toBe(404);
  });

  it("refuses an image model and the features it does not serve", async () => {
    expect((await post({ model: "claude-image", input: "a fox" })).status).toBe(400);
    expect((await post({ model: "claude-opus", input: "hi", tools: [{ type: "function", name: "f" }] })).body.error.message).toMatch(/"tools" is not supported/);
    expect((await post({ model: "claude-opus", input: "hi", tools: [], text: { format: { type: "text" } } })).status).toBe(200);
  });

  it("refuses a history over its limits, or drops its oldest turns with truncation auto", async () => {
    build({ maxTurns: 2, maxBytes: 2_000_000 });
    const a = await post({ model: "claude-opus", input: "one" });
    const b = await post({ model: "claude-opus", input: "two", previous_response_id: a.body.id });
    const refused = await post({ model: "claude-opus", input: "three", previous_response_id: b.body.id });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/truncation "auto"/);
    const cut = await post({ model: "claude-opus", input: "three", previous_response_id: b.body.id, truncation: "auto" });
    expect(cut.status).toBe(200);
    expect(provider.calls.at(-1)!.messages.map((m) => m.text)).toEqual(["two", "seen 3", "three"]);
  });

  it("streams the typed events of the Responses API, in order", async () => {
    const r = await post({ model: "claude-opus", input: "hi", stream: true });
    const events = r.text.split("\n\n").filter((f) => f.startsWith("event:")).map((f) => JSON.parse(f.split("\ndata: ")[1]) as { type: string; delta?: string; response?: { output_text: string; id: string } });
    expect(events.map((e) => e.type)).toEqual([
      "response.created", "response.in_progress", "response.output_item.added", "response.content_part.added",
      "response.output_text.delta", "response.output_text.delta",
      "response.output_text.done", "response.content_part.done", "response.output_item.done", "response.completed",
    ]);
    expect(events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join("")).toBe("seen 1");
    const done = events.at(-1)!.response!;
    expect(done.output_text).toBe("seen 1");
    expect(conversations.get(done.id, "app-one")?.output).toBe("seen 1");
  });
});

describe("the official OpenAI SDK against /v1/responses", () => {
  let server: Server, client: OpenAI;
  beforeEach(async () => {
    build();
    await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
    client = new OpenAI({ baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKey: "unused" });
  });
  afterEach(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));

  it("keeps nothing of an answer the client walked away from", async () => {
    provider.delayMs = 200;
    const ac = new AbortController();
    const port = (server.address() as { port: number }).port;
    const pending = fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", signal: ac.signal,
      headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-opus", input: "hi" }) }).catch(() => undefined);
    setTimeout(() => ac.abort(), 50);
    await pending;
    await new Promise((r) => setTimeout(r, 900));
    const rows = (conversations as unknown as { db: { prepare(q: string): { get(): { n: number } } } }).db.prepare("SELECT count(*) AS n FROM turns").get();
    expect(rows.n).toBe(0);
  });

  it("creates, continues, streams, retrieves and deletes", async () => {
    const first = await client.responses.create({ model: "claude-opus", input: "hi" });
    expect(first.output_text).toBe("seen 1");
    const second = await client.responses.create({ model: "claude-opus", input: "again", previous_response_id: first.id });
    expect(second.output_text).toBe("seen 3");
    const stream = await client.responses.create({ model: "claude-opus", input: "and once more", previous_response_id: second.id, stream: true });
    let text = "", completed = "";
    for await (const ev of stream) {
      if (ev.type === "response.output_text.delta") text += ev.delta;
      if (ev.type === "response.completed") completed = ev.response.output_text;
    }
    expect(text).toBe("seen 5");
    expect(completed).toBe("seen 5");
    expect((await client.responses.retrieve(first.id)).output_text).toBe("seen 1");
    await client.responses.delete(first.id);
    await expect(client.responses.retrieve(second.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("MCP ask_model with a conversation", () => {
  let server: Server, url: string;
  beforeEach(async () => {
    build();
    await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  });
  afterEach(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));

  async function as(caller: string) {
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { "x-test-caller": caller } } }));
    return c;
  }

  it("keeps nothing without one, opens one with \"new\", and replays it on the returned id", async () => {
    const c = await as("app-one");
    const plain = await c.callTool({ name: "ask_model", arguments: { model: "claude-opus", prompt: "hi" } });
    expect((plain.structuredContent as { conversation?: string }).conversation).toBeUndefined();
    const first = await c.callTool({ name: "ask_model", arguments: { model: "claude-opus", prompt: "hi", conversation: "new" } });
    const id = (first.structuredContent as { conversation: string }).conversation;
    expect(id).toMatch(/^resp_/);
    expect((first.content as { text: string }[]).at(-1)!.text).toBe(`conversation: ${id}`);
    const second = await c.callTool({ name: "ask_model", arguments: { model: "claude-opus", prompt: "again", conversation: id } });
    expect((second.structuredContent as { text: string }).text).toBe("seen 3");
    await c.close();
    // The same store as the Responses API: the conversation continues over HTTP.
    const next = (second.structuredContent as { conversation: string }).conversation;
    expect((await post({ model: "claude-opus", input: "over http", previous_response_id: next })).body.output_text).toBe("seen 5");
    const other = await as("app-two");
    const refused = await other.callTool({ name: "ask_model", arguments: { model: "claude-opus", prompt: "mine?", conversation: id } });
    expect(refused.isError).toBe(true);
    await other.close();
  });
});
