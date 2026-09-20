import { describe, it, expect } from "vitest";
import request from "supertest";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/server/app.js";
import { Core } from "../src/core/core.js";
import { UsageStore } from "../src/usage/store.js";
import { FakeProvider } from "./fake-provider.js";
import { createLogger } from "../src/log.js";
import type { ProviderEvent } from "../src/core/types.js";
import type { RequestHandler } from "express";

const OK: ProviderEvent[] = [{ type: "text", delta: "hel" }, { type: "text", delta: "lo" }, { type: "done", usage: { input: 3, output: 2 } }];
function make(script: ProviderEvent[] = OK, access?: RequestHandler) {
  const p = new FakeProvider("claude", ["claude-opus"], script, 1);
  const usage = new UsageStore(":memory:");
  const core = new Core([p], usage, { maxWaitMs: 100, budgets: {}, log: createLogger("t") });
  const outcomes = () => (usage as unknown as { db: { prepare(q: string): { all(): { outcome: string }[] } } }).db
    .prepare("SELECT outcome FROM calls WHERE source = 'http' ORDER BY id").all().map((r) => r.outcome);
  return { p, core, outcomes, app: createApp(core, { log: createLogger("t"), access }) };
}
// Stand-in for the Access middleware: any request without the header is refused.
const deny: RequestHandler = (req, res, next) => (req.header("Cf-Access-Jwt-Assertion") ? next() : res.status(401).json({ error: { code: "unauthorized" } }));
const body = (extra: object = {}) => ({ model: "claude-opus", messages: [{ role: "user", content: "hi" }], ...extra });
const sseLines = (text: string) => text.split("\n\n").filter(Boolean).map((l) => l.replace(/^data: /, ""));

describe("GET /v1/models", () => {
  it("lists available models with owned_by", async () => {
    const { app } = make();
    const r = await request(app).get("/v1/models");
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([expect.objectContaining({ id: "claude-opus", object: "model", owned_by: "claude" })]);
  });
});

describe("POST /v1/chat/completions", () => {
  it("returns a completion with usage and the capitoline field", async () => {
    const { app, p } = make();
    const r = await request(app).post("/v1/chat/completions").send(body({ temperature: 0.2, reasoning_effort: "high" }));
    expect(r.status).toBe(200);
    expect(r.body.choices[0].message).toEqual({ role: "assistant", content: "hello" });
    expect(r.body.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    expect(r.body.capitoline.provider).toBe("claude");
    expect(r.headers["x-capitoline-ignored"]).toBe("temperature");
    expect(p.calls[0].effort).toBe("high");
  });
  it("streams SSE chunks ending with [DONE]", async () => {
    const { app } = make();
    const r = await request(app).post("/v1/chat/completions").send(body({ stream: true }));
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/event-stream/);
    const chunks = sseLines(r.text);
    expect(chunks.at(-1)).toBe("[DONE]");
    const parsed = chunks.slice(0, -1).map((c) => JSON.parse(c));
    expect(parsed[0].choices[0].delta.role).toBe("assistant");
    expect(parsed.map((c) => c.choices[0].delta.content ?? "").join("")).toBe("hello");
    expect(parsed.at(-1).choices[0].finish_reason).toBe("stop");
    expect(parsed.at(-1).usage.total_tokens).toBe(5);
  });
  it("passes the full message history through, mapping developer to system", async () => {
    const { app, p } = make();
    await request(app).post("/v1/chat/completions").send(body({ messages: [{ role: "developer", content: "S" }, { role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] }));
    expect(p.calls[0].messages).toEqual([{ role: "system", text: "S" }, { role: "user", text: "a" }, { role: "assistant", text: "b" }, { role: "user", text: "c" }]);
  });
  it("decodes data-URL images into attachments", async () => {
    const { app, p } = make();
    const png = Buffer.from("fakepng").toString("base64");
    await request(app).post("/v1/chat/completions").send(body({ messages: [{ role: "user", content: [{ type: "text", text: "what" }, { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }] }] }));
    expect(p.calls[0].messages[0].text).toBe("what");
    expect(p.calls[0].attachments![0]).toEqual({ mime: "image/png", bytes: Buffer.from("fakepng") });
  });
  it.each([
    [{ tools: [{}] }, /tools/], [{ n: 2 }, /n/], [{ logprobs: true }, /logprobs/], [{ response_format: { type: "json_object" } }, /response_format/],
    [{ messages: [] }, /messages/], [{ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] }] }, /data URL/],
  ])("rejects %j with 400", async (extra, re) => {
    const { app } = make();
    const r = await request(app).post("/v1/chat/completions").send(body(extra));
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(re);
  });
  it.each([
    [{ logprobs: false }], [{ tool_choice: "none" }], [{ tools: [] }], [{ response_format: { type: "text" } }], [{ n: 1 }],
  ])("accepts %j, the gateway default, with 200", async (extra) => {
    const { app } = make();
    const r = await request(app).post("/v1/chat/completions").send(body(extra));
    expect(r.status).toBe(200);
    expect(r.headers["x-capitoline-ignored"]).toBeUndefined();
  });
  it("lists unknown parameters in X-Capitoline-Ignored", async () => {
    const { app } = make();
    const r = await request(app).post("/v1/chat/completions").send(body({ stream_options: { include_usage: true }, max_tokens: 10 }));
    expect(r.status).toBe(200);
    expect(r.headers["x-capitoline-ignored"].split(",").sort()).toEqual(["max_tokens", "stream_options"]);
  });
  it("answers a malformed JSON body with a 400 JSON error and no stack trace", async () => {
    const { app } = make();
    const r = await request(app).post("/v1/chat/completions").set("Content-Type", "application/json").send("{not json");
    expect(r.status).toBe(400);
    expect(r.headers["content-type"]).toMatch(/application\/json/);
    expect(r.body.error.code).toBe("bad_request");
    expect(r.text).not.toContain("node_modules");
  });
  it("answers an oversized body with a 413 JSON error and no stack trace", async () => {
    const { app } = make();
    const r = await request(app).post("/v1/chat/completions").send(body({ pad: "x".repeat(21 * 1024 * 1024) }));
    expect(r.status).toBe(413);
    expect(r.headers["content-type"]).toMatch(/application\/json/);
    expect(r.body.error.code).toBe("bad_request");
    expect(r.text).not.toContain("node_modules");
  });
  it("returns 404 for an unknown model", async () => {
    const { app } = make();
    expect((await request(app).post("/v1/chat/completions").send(body({ model: "nope" }))).status).toBe(404);
  });
  it("returns 404 without Retry-After for a declared model whose provider is unhealthy", async () => {
    const { app, p, core } = make();
    p.healthResult = { ok: false, kind: "auth_expired", detail: "expired", checkedAt: 0 };
    await core.checkHealth();
    const r = await request(app).post("/v1/chat/completions").send(body());
    expect(r.status).toBe(404);
    expect(r.headers["retry-after"]).toBeUndefined();
    expect(r.body.error.code).toBe("model_unavailable");
    expect(p.calls).toHaveLength(0);
  });
  it.each([
    ["auth_expired", 503], ["rate_limited", 429], ["timeout", 504], ["cli_crashed", 502], ["bad_output", 502],
  ] as const)("maps provider error %s to %d", async (kind, status) => {
    const { app } = make([{ type: "error", kind, detail: "secret stderr" }]);
    const r = await request(app).post("/v1/chat/completions").send(body());
    expect(r.status).toBe(status);
    expect(r.body.error.code).toBe(kind);
    expect(JSON.stringify(r.body)).not.toContain("secret stderr");
  });
  it("reports a provider error after output started as an SSE error line and ends without [DONE]", async () => {
    const { app } = make([{ type: "text", delta: "par" }, { type: "error", kind: "cli_crashed", detail: "secret stderr" }]);
    const r = await request(app).post("/v1/chat/completions").send(body({ stream: true }));
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/event-stream/);
    const chunks = sseLines(r.text);
    expect(chunks).not.toContain("[DONE]");
    const last = JSON.parse(chunks.at(-1)!);
    expect(last.error.code).toBe("cli_crashed");
    expect(last.error.message).toBe("the provider process failed");
    expect(r.text).not.toContain("secret stderr");
  });
  it("aborts the provider run when the client disconnects mid-stream", async () => {
    const script: ProviderEvent[] = Array.from({ length: 20 }, () => ({ type: "text", delta: "x" } as ProviderEvent)).concat([{ type: "done", usage: { input: 1, output: 20 } }]);
    const { app, p, outcomes } = make(script);
    p.delayMs = 20;
    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const ac = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body({ stream: true })), signal: ac.signal,
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      await reader.read(); // first chunk: the stream is live
      ac.abort();
      await expect(reader.read()).rejects.toThrow();
      const deadline = Date.now() + 2000;
      while (outcomes().length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      expect(outcomes()).toEqual(["aborted"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("GET /health", () => {
  it("reports providers", async () => {
    const { app } = make();
    const r = await request(app).get("/health");
    expect(r.status).toBe(200);
    expect(r.body.providers[0].id).toBe("claude");
  });
});

describe("access middleware placement", () => {
  it("protects /v1 and /mcp before the body is parsed, leaves /health open", async () => {
    const { app } = make(OK, deny);
    expect((await request(app).get("/v1/models")).status).toBe(401);
    expect((await request(app).post("/mcp").send({})).status).toBe(401);
    expect((await request(app).get("/health")).status).toBe(200);
    // A malformed body without a token is refused as unauthenticated, not as a bad request.
    const r = await request(app).post("/v1/chat/completions").set("Content-Type", "application/json").send("{not json");
    expect(r.status).toBe(401);
    expect((await request(app).get("/v1/models").set("Cf-Access-Jwt-Assertion", "x")).status).toBe(200);
  });
});
