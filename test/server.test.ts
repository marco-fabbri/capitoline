import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../src/server/app.js";
import { Core } from "../src/core/core.js";
import { UsageStore } from "../src/usage/store.js";
import { FakeProvider } from "./fake-provider.js";
import { createLogger } from "../src/log.js";
import type { ProviderEvent } from "../src/core/types.js";

const OK: ProviderEvent[] = [{ type: "text", delta: "hel" }, { type: "text", delta: "lo" }, { type: "done", usage: { input: 3, output: 2 } }];
function make(script: ProviderEvent[] = OK) {
  const p = new FakeProvider("claude", ["claude-opus"], script, 1);
  const core = new Core([p], new UsageStore(":memory:"), { maxWaitMs: 100, budgets: {}, log: createLogger("t") });
  return { p, app: createApp(core, { log: createLogger("t") }) };
}
const body = (extra: object = {}) => ({ model: "claude-opus", messages: [{ role: "user", content: "hi" }], ...extra });

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
    const chunks = r.text.split("\n\n").filter(Boolean).map((l) => l.replace(/^data: /, ""));
    expect(chunks.at(-1)).toBe("[DONE]");
    const parsed = chunks.slice(0, -1).map((c) => JSON.parse(c));
    expect(parsed[0].choices[0].delta.role).toBe("assistant");
    expect(parsed.map((c) => c.choices[0].delta.content ?? "").join("")).toBe("hello");
    expect(parsed.at(-1).choices[0].finish_reason).toBe("stop");
    expect(parsed.at(-1).usage.total_tokens).toBe(5);
  });
  it("flattens multi-turn history and extracts the system prompt", async () => {
    const { app, p } = make();
    await request(app).post("/v1/chat/completions").send(body({ messages: [{ role: "system", content: "S" }, { role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] }));
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
  it("returns 404 for an unknown model", async () => {
    const { app } = make();
    expect((await request(app).post("/v1/chat/completions").send(body({ model: "nope" }))).status).toBe(404);
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
});

describe("GET /health", () => {
  it("reports providers", async () => {
    const { app } = make();
    const r = await request(app).get("/health");
    expect(r.status).toBe(200);
    expect(r.body.providers[0].id).toBe("claude");
  });
});
