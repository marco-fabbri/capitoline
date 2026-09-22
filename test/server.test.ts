import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/server/app.js";
import { Core, type Context } from "../src/core/core.js";
import { UsageStore } from "../src/usage/store.js";
import { FakeProvider } from "./fake-provider.js";
import { createLogger } from "../src/log.js";
import type { InternalRequest, ProviderEvent } from "../src/core/types.js";
import type { Script } from "./fake-provider.js";
import type { RequestHandler } from "express";
import type { Identity } from "../src/server/access.js";
import { Council, type CouncilEvent } from "../src/council/council.js";
import type { CouncilConfig, Deliberation, Seat } from "../src/council/types.js";

const OK: ProviderEvent[] = [{ type: "text", delta: "hel" }, { type: "text", delta: "lo" }, { type: "done", usage: { input: 3, output: 2 } }];

/**
 * The queue budget every Core in this file is built with. Seconds, not the
 * tenth of a second it was until 2026-09-22.
 *
 * Nothing here tests queueing: the fake providers answer at once, and the one
 * test that means to see a `queue_full` injects the event rather than racing
 * the semaphore for it. What a tenth of a second bought was a failure mode —
 * a worker busy enough to delay a slot by 100 ms turns any of these into a 503
 * with `queue_full`, under whatever name the losing test happened to have,
 * which is the shape of the flake recorded in docs/backlog.md. The council
 * block below is the likeliest loser: a deliberation makes several calls
 * through providers of concurrency one, so its members really do queue behind
 * each other, and only the scheduler decides by how much.
 *
 * Raising it costs nothing. A test that hangs is caught by vitest's own
 * timeout, which is what should catch it.
 */
const QUEUE_WAIT_MS = 5_000;
function make(script: ProviderEvent[] = OK, access?: RequestHandler) {
  const p = new FakeProvider("claude", ["claude-opus"], script, 1);
  const usage = new UsageStore(":memory:");
  const core = new Core([p], usage, { maxWaitMs: QUEUE_WAIT_MS, budgets: {}, log: createLogger("t") });
  const outcomes = () => (usage as unknown as { db: { prepare(q: string): { all(): { outcome: string }[] } } }).db
    .prepare("SELECT outcome FROM calls WHERE source = 'http' ORDER BY id").all().map((r) => r.outcome);
  return { p, core, usage, outcomes, app: createApp(core, { log: createLogger("t"), access }) };
}
// Stand-in for a verified Access token: the middleware's only job here is to
// leave the identity behind, which is where the caller of a row comes from.
const asCaller = (who: Identity): RequestHandler => (_req, res, next) => { res.locals.identity = who; next(); };
// Stand-in for the Access middleware: any request without the header is refused.
const deny: RequestHandler = (req, res, next) => (req.header("Cf-Access-Jwt-Assertion") ? next() : res.status(401).json({ error: { code: "unauthorized" } }));
const body = (extra: object = {}) => ({ model: "claude-opus", messages: [{ role: "user", content: "hi" }], ...extra });
// The frames as they went over the wire, comments included: a keep-alive is
// one of those, and the test that is about it is the only one that looks.
const sseFrames = (text: string) => text.split("\n\n").filter(Boolean);
// What a client's parser sees: a frame whose field name is empty — the
// keep-alive of app.ts — is not a chunk and is dropped here as the SSE
// grammar drops it.
const sseLines = (text: string) => sseFrames(text).filter((f) => !f.startsWith(":")).map((l) => l.replace(/^data: /, ""));

describe("GET /v1/models", () => {
  it("lists available models with owned_by", async () => {
    const { app } = make();
    const r = await request(app).get("/v1/models");
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([expect.objectContaining({ id: "claude-opus", object: "model", owned_by: "claude" })]);
  });
  it("reports the kind of every model in the capitoline block", async () => {
    const { app } = makeImages();
    const r = await request(app).get("/v1/models");
    expect(r.body.data.map((m: { id: string; capitoline: { kind: string } }) => [m.id, m.capitoline.kind])).toEqual([["agy-text", "text"], ["agy-image", "image"]]);
  });
  it("exposes the image quota of an image model, and only of an image model", async () => {
    const { app } = makeImages();
    const before = await request(app).get("/v1/models");
    const quotaOf = (r: { body: { data: { id: string; capitoline: Record<string, unknown> }[] } }, id: string) =>
      r.body.data.find((m) => m.id === id)!.capitoline.quota;
    expect(quotaOf(before, "agy-image")).toEqual({ used: 0, limit: 12, window_started_at: null });
    expect(quotaOf(before, "agy-text")).toBeUndefined();
    await request(app).post("/v1/images/generations").send({ prompt: "a lighthouse", model: "agy-image" });
    const after = await request(app).get("/v1/models");
    expect(quotaOf(after, "agy-image")).toEqual({ used: 1, limit: 12, window_started_at: expect.any(Number) });
  });
  it("drops an image model whose quota is exhausted, and says so nowhere in this list", async () => {
    const { app } = makeImages([{ type: "error", kind: "rate_limited", detail: "429", retryAfterS: 442_209 }]);
    const sent = Date.now();
    expect((await request(app).post("/v1/images/generations").send({ prompt: "a lighthouse", model: "agy-image" })).status).toBe(429);
    // The quota hit paused the provider past the reset it reported, so every
    // model of that provider is unavailable and this list has dropped it
    // (spec 6.4). That is why the block here carries no reset instant: it
    // could never be anything but null. The reset is read from /health.
    expect((await request(app).get("/v1/models")).body.data).toEqual([]);
    const health = await request(app).get("/health");
    expect(health.body.providers[0].imageQuota.resetAt).toBeGreaterThanOrEqual(sent + 442_209 * 1000);
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
    ["auth_expired", 503], ["rate_limited", 429], ["busy", 503], ["timeout", 504], ["cli_crashed", 502], ["bad_output", 502],
  ] as const)("maps provider error %s to %d", async (kind, status) => {
    const { app } = make([{ type: "error", kind, detail: "secret stderr" }]);
    const r = await request(app).post("/v1/chat/completions").send(body());
    expect(r.status).toBe(status);
    expect(r.body.error.code).toBe(kind);
    expect(JSON.stringify(r.body)).not.toContain("secret stderr");
  });
  it("reports the model that actually answered, and stays quiet when the CLI said nothing", async () => {
    // app-one stores the model of every recipe and could only store the
    // alias, while the gateway knew the dated id and kept it to itself
    // (issue #2). `model` stays the alias an OpenAI client asked for; the
    // resolved id rides in the gateway's own field.
    const { app } = make([{ type: "text", delta: "hi" }, { type: "done", usage: { input: 1, output: 1 }, cliModelId: "claude-opus-5-5" }]);
    const r = await request(app).post("/v1/chat/completions").send(body());
    expect(r.body.model).toBe("claude-opus");
    expect(r.body.capitoline).toEqual({ provider: "claude", cliModelId: "claude-opus-5-5", ignored: [] });

    // Codex and Antigravity report nothing, and the field is then absent
    // rather than null: a client falls back to the name it asked for.
    const plain = make([{ type: "text", delta: "hi" }, { type: "done", usage: { input: 1, output: 1 } }]);
    const r2 = await request(plain.app).post("/v1/chat/completions").send(body());
    expect(r2.body.capitoline).toEqual({ provider: "claude", ignored: [] });
  });
  it("carries the model that answered on the final chunk of a stream", async () => {
    const { app } = make([{ type: "text", delta: "hi" }, { type: "done", usage: { input: 1, output: 1 }, cliModelId: "claude-opus-5-5" }]);
    const r = await request(app).post("/v1/chat/completions").send({ ...body(), stream: true });
    const chunks = r.text.split("\n\n").filter((c) => c.startsWith("data: ") && !c.includes("[DONE]")).map((c) => JSON.parse(c.slice(6)));
    const last = chunks.at(-1);
    expect(last.choices[0].finish_reason).toBe("stop");
    expect(last.capitoline).toEqual({ provider: "claude", cliModelId: "claude-opus-5-5", ignored: [] });
  });
  it("tells a client to come back in seconds when the provider was busy, not in a minute", async () => {
    // A full server clears by itself. The minute a rate limit gets would send
    // the client away from a provider that is already answering again, and
    // nothing was paused, so there is no pause for it to wait out.
    const { app, core } = make([{ type: "error", kind: "busy", detail: "503 no capacity" }]);
    const r = await request(app).post("/v1/chat/completions").send(body());
    expect(r.status).toBe(503);
    expect(r.headers["retry-after"]).toBe("5");
    expect(core.providerStates()[0]).toMatchObject({ pausedUntil: null, strikes: 0 });
  });
  it("answers Retry-After with the pause Core installed (provider figure plus the minute of slack)", async () => {
    const { app } = make([{ type: "error", kind: "rate_limited", detail: "429", retryAfterS: 120 }]);
    const r = await request(app).post("/v1/chat/completions").send(body());
    expect(r.status).toBe(429);
    expect(r.headers["retry-after"]).toBe("180");
  });
  it("takes Retry-After from the model's own pause when the refusal named the model", async () => {
    // The refusal installed a pause on the model alone, so the provider has
    // none: only the third argument of core.pauseRemainingS(provider, model)
    // finds it. Without it the header would fall back to the CLI's own figure
    // (10) and the client would come back 60 s before the model is free.
    const { app, core } = make([{ type: "error", kind: "rate_limited", detail: "reached your claude-opus limit", scope: "model", retryAfterS: 10 }]);
    const r = await request(app).post("/v1/chat/completions").send(body());
    expect(r.status).toBe(429);
    expect(core.pauseRemainingS("claude")).toBeUndefined();          // the provider is untouched
    expect(core.pauseRemainingS("claude", "claude-opus")).toBe(70);  // 10 s reported + Core's minute of slack
    expect(r.headers["retry-after"]).toBe("70");
  });
  it("keeps a header-unsafe unknown key out of X-Capitoline-Ignored and still answers 200", async () => {
    const { app } = make();
    const r = await request(app).post("/v1/chat/completions").send(body({ "weird\r\nX-Evil: 1": "v", max_tokens: 10 }));
    expect(r.status).toBe(200);
    expect(r.headers["x-capitoline-ignored"]).toBe("max_tokens");
    expect(r.headers["x-evil"]).toBeUndefined();
    expect(r.body.capitoline.ignored.sort()).toEqual(["max_tokens", "weird\r\nX-Evil: 1"]);
  });
  it("returns 400 for a chat request against an image model", async () => {
    const { app, p } = makeImages();
    const r = await request(app).post("/v1/chat/completions").send(body({ model: "agy-image" }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("bad_request");
    expect(p.calls).toHaveLength(0);
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

// A JPEG header is enough for the fake: the route never inspects the bytes.
const JPEG = Buffer.from("ffd8ffe000104a464946", "hex");
const IMG: ProviderEvent = { type: "image", mime: "image/jpeg", bytes: JPEG, width: 1376, height: 768 };
function makeImages(script: ProviderEvent[] = [IMG, { type: "done" }], access?: RequestHandler) {
  const p = new FakeProvider("antigravity", ["agy-text", { name: "agy-image", kind: "image" }], OK, 1);
  p.imageScript = script;
  const usage = new UsageStore(":memory:");
  const core = new Core([p], usage, { maxWaitMs: QUEUE_WAIT_MS, budgets: {}, log: createLogger("t"), imageQuotas: { antigravity: 12 } });
  return { p, core, usage, app: createApp(core, { log: createLogger("t"), access }) };
}

describe("POST /v1/images/generations", () => {
  it("returns the image as b64_json with the capitoline block", async () => {
    const { app, p } = makeImages();
    const r = await request(app).post("/v1/images/generations").send({ prompt: "a lighthouse", model: "agy-image" });
    expect(r.status).toBe(200);
    expect(r.body.created).toEqual(expect.any(Number));
    expect(r.body.data).toHaveLength(1);
    expect(Buffer.from(r.body.data[0].b64_json, "base64")).toEqual(JPEG);
    expect(r.body.capitoline).toEqual({ provider: "antigravity", model: "agy-image", mime: "image/jpeg", width: 1376, height: 768, bytes: JPEG.length, ignored: [] });
    expect(r.headers["x-capitoline-ignored"]).toBeUndefined();
    expect(p.imageCalls).toEqual([{ model: "agy-image", prompt: "a lighthouse" }]);
    expect(p.calls).toHaveLength(0);
  });
  it("defaults to the first image model when model is omitted", async () => {
    const { app, p } = makeImages();
    const r = await request(app).post("/v1/images/generations").send({ prompt: "a lighthouse" });
    expect(r.status).toBe(200);
    expect(r.body.capitoline.model).toBe("agy-image");
    expect(p.imageCalls[0].model).toBe("agy-image");
  });
  it("defaults to an available image model, skipping one whose provider is unhealthy", async () => {
    const first = new FakeProvider("one", [{ name: "one-image", kind: "image" }], OK, 1);
    const second = new FakeProvider("two", [{ name: "two-image", kind: "image" }], OK, 1);
    first.imageScript = [IMG, { type: "done" }]; second.imageScript = [IMG, { type: "done" }];
    first.healthResult = { ok: false, kind: "auth_expired", detail: "expired", checkedAt: 0 };
    const core = new Core([first, second], new UsageStore(":memory:"), { maxWaitMs: QUEUE_WAIT_MS, budgets: {}, log: createLogger("t") });
    await core.checkHealth();
    const app = createApp(core, { log: createLogger("t") });
    const r = await request(app).post("/v1/images/generations").send({ prompt: "a lighthouse" });
    expect(r.status).toBe(200);
    expect(r.body.capitoline).toMatchObject({ provider: "two", model: "two-image" });
    expect(first.imageCalls).toHaveLength(0);
  });
  it("returns 400 when model is omitted and no image model exists", async () => {
    const { app } = make();
    const r = await request(app).post("/v1/images/generations").send({ prompt: "a lighthouse" });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("bad_request");
  });
  it("ignores size, quality and style and says so in the header", async () => {
    const { app } = makeImages();
    const r = await request(app).post("/v1/images/generations").send({ prompt: "a lighthouse", size: "1024x1024", quality: "hd", style: "vivid" });
    expect(r.status).toBe(200);
    expect(r.headers["x-capitoline-ignored"].split(",").sort()).toEqual(["quality", "size", "style"]);
    expect(r.body.capitoline.ignored.sort()).toEqual(["quality", "size", "style"]);
    expect(r.body.capitoline.width).toBe(1376);
  });
  it("lists every unknown key, not only the style ones, in the header and the body", async () => {
    const { app } = makeImages();
    const r = await request(app).post("/v1/images/generations").send({ prompt: "x", user: "u", banana: 1 });
    expect(r.status).toBe(200);
    expect(r.headers["x-capitoline-ignored"].split(",").sort()).toEqual(["banana", "user"]);
    expect(r.body.capitoline.ignored.sort()).toEqual(["banana", "user"]);
  });
  it("keeps a header-unsafe unknown key out of X-Capitoline-Ignored and still answers 200", async () => {
    const { app } = makeImages();
    const r = await request(app).post("/v1/images/generations").send({ prompt: "x", "weird\r\nX-Evil: 1": "v" });
    expect(r.status).toBe(200);
    expect(r.headers["x-capitoline-ignored"]).toBeUndefined();
    expect(r.headers["x-evil"]).toBeUndefined();
    expect(r.body.capitoline.ignored).toEqual(["weird\r\nX-Evil: 1"]);
  });
  it("caps the header at 32 names while the body keeps them all", async () => {
    const { app } = makeImages();
    const extra = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, 1]));
    const r = await request(app).post("/v1/images/generations").send({ prompt: "x", ...extra });
    expect(r.status).toBe(200);
    expect(r.headers["x-capitoline-ignored"].split(",")).toHaveLength(32);
    expect(r.body.capitoline.ignored).toHaveLength(40);
  });
  it("drops the agent's prose: only the image reaches the client", async () => {
    const { app } = makeImages([{ type: "text", delta: "saved as ./image.png" }, IMG, { type: "done" }]);
    const r = await request(app).post("/v1/images/generations").send({ prompt: "a lighthouse" });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain("./image.png");
    expect(Buffer.from(r.body.data[0].b64_json, "base64")).toEqual(JPEG);
  });
  it.each([
    [{ n: 2 }, /"n" must be 1/], [{ response_format: "url" }, /response_format/], [{ output_format: "png" }, /output_format/],
    [{ prompt: "" }, /prompt/], [{ prompt: undefined }, /prompt/],
  ])("rejects %j with 400", async (extra, re) => {
    const { app, p } = makeImages();
    const r = await request(app).post("/v1/images/generations").send({ prompt: "a lighthouse", ...extra });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("bad_request");
    expect(r.body.error.message).toMatch(re);
    expect(p.imageCalls).toHaveLength(0);
  });
  it.each([[{ n: 1 }], [{ response_format: "b64_json" }], [{ output_format: "jpeg" }], [{ n: null }]])("accepts %j with 200", async (extra) => {
    const { app } = makeImages();
    const r = await request(app).post("/v1/images/generations").send({ prompt: "a lighthouse", ...extra });
    expect(r.status).toBe(200);
    expect(r.headers["x-capitoline-ignored"]).toBeUndefined();
  });
  it("returns 400 for an image request against a text model", async () => {
    const { app, p } = makeImages();
    const r = await request(app).post("/v1/images/generations").send({ prompt: "a lighthouse", model: "agy-text" });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("bad_request");
    expect(p.imageCalls).toHaveLength(0);
    expect(p.calls).toHaveLength(0);
  });
  it("returns 404 for an unknown model", async () => {
    const { app } = makeImages();
    expect((await request(app).post("/v1/images/generations").send({ prompt: "x", model: "nope" })).status).toBe(404);
  });
  it("maps rate_limited with an explicit retry-after to 429 and the Retry-After Core installed", async () => {
    const { app, core } = makeImages([{ type: "error", kind: "rate_limited", detail: "429 secret body", retryAfterS: 442_209 }]);
    const r = await request(app).post("/v1/images/generations").send({ prompt: "a lighthouse" });
    expect(r.status).toBe(429);
    expect(r.headers["retry-after"]).toBe("442269");
    expect(Number(r.headers["retry-after"])).toBe(core.pauseRemainingS("antigravity"));
    expect(r.body.error.code).toBe("rate_limited");
    expect(r.body.error.message).toBe("provider rate limit reached");
    expect(r.text).not.toContain("secret body");
  });
  it("still sends Retry-After on a 429 when the provider's reset instant is already behind us (retryAfterS 0)", async () => {
    const { app } = makeImages([{ type: "error", kind: "rate_limited", detail: "429", retryAfterS: 0 }]);
    const r = await request(app).post("/v1/images/generations").send({ prompt: "a lighthouse" });
    expect(r.status).toBe(429);
    expect(r.headers["retry-after"]).toBeDefined();
    expect(Number(r.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });
  it.each([
    ["auth_expired", 503], ["busy", 503], ["timeout", 504], ["cli_crashed", 502], ["bad_output", 502],
  ] as const)("maps provider error %s to %d", async (kind, status) => {
    const { app } = makeImages([{ type: "error", kind, detail: "secret stderr" }]);
    const r = await request(app).post("/v1/images/generations").send({ prompt: "a lighthouse" });
    expect(r.status).toBe(status);
    expect(r.body.error.code).toBe(kind);
    expect(r.text).not.toContain("secret stderr");
  });
  it("answers 502 bad_output when the provider ends without an image", async () => {
    const { app } = makeImages([{ type: "done" }]);
    const r = await request(app).post("/v1/images/generations").send({ prompt: "a lighthouse" });
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe("bad_output");
  });
  it("aborts the generation when the client disconnects", async () => {
    const { app, p, core } = makeImages();
    p.delayMs = 100;
    const outcomes = () => (core as unknown as { usage: { db: { prepare(q: string): { all(): { outcome: string }[] } } } }).usage.db
      .prepare("SELECT outcome FROM calls WHERE source = 'http' ORDER BY id").all().map((r) => r.outcome);
    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const ac = new AbortController();
      const pending = fetch(`http://127.0.0.1:${port}/v1/images/generations`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "a lighthouse" }), signal: ac.signal,
      });
      await new Promise((r) => setTimeout(r, 30));      // the provider is busy on the first event
      ac.abort();
      await expect(pending).rejects.toThrow();
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
  it("reports the image quota of a provider, and null for one without image models", async () => {
    const { app } = makeImages();
    const before = await request(app).get("/health");
    expect(before.body.providers[0].imageQuota).toEqual({ used: 0, limit: 12, windowStartedAt: null, resetAt: null });
    await request(app).post("/v1/images/generations").send({ prompt: "a lighthouse", model: "agy-image" });
    const after = await request(app).get("/health");
    expect(after.body.providers[0].imageQuota).toMatchObject({ used: 1, limit: 12, windowStartedAt: expect.any(Number), resetAt: null });
    expect(after.body.models.find((m: { name: string }) => m.name === "agy-image").quota.used).toBe(1);
    const textOnly = await request(make().app).get("/health");
    expect(textOnly.body.providers[0].imageQuota).toBeNull();
  });
  it("reports the quota reset after an image rate limit", async () => {
    const { app } = makeImages([{ type: "error", kind: "rate_limited", detail: "429", retryAfterS: 442_209 }]);
    const sent = Date.now();
    const gen = await request(app).post("/v1/images/generations").send({ prompt: "a lighthouse", model: "agy-image" });
    expect(gen.status).toBe(429);
    const r = await request(app).get("/health");
    expect(r.body.providers[0].imageQuota.resetAt).toBeGreaterThanOrEqual(sent + 442_209 * 1000);
    expect(r.body.providers[0].imageQuota.used).toBe(0);
  });
});


// --- The council on the HTTP surface ------------------------------------
//
// The routing itself is Core's business (test/core.test.ts); what the two
// endpoints do with a virtual model is here. Two seats and a judge is the
// repository's panel in miniature: enough for a quorum, and small enough that
// taking one provider down breaks it.
const COUNCIL_SEATS: Seat[] = [{ family: "anthropic", models: ["claude-opus"] }, { family: "openai", models: ["codex-astra"] }];
const THREE_SEATS: Seat[] = [...COUNCIL_SEATS, { family: "google", models: ["agy-pro"] }];
const COUNCIL_JUDGE: Seat = { family: "anthropic", models: ["claude-haiku"] };
const COUNCIL_CFG: CouncilConfig = { seats: COUNCIL_SEATS, judge: COUNCIL_JUDGE, judgeAllowMember: false, judgeBlind: true, minMembers: 2, ranking: true, stageTimeoutS: 5 };

// The panel's answers, one per model and none of them naming a model: they are
// pasted into the ranking and synthesis prompts, and the first test below
// reads both ends of the same request — the deliberation the client is shown,
// which names the models, and the prompts the panel was sent, which must not.
const COUNCIL_ANSWERS: Record<string, string> = {
  "claude-opus": "Retry once, and only on a refusal nobody predicted.",
  "codex-astra": "Retrying twice turns one question into four calls.",
  "agy-pro": "It depends whether the refusal is the model's or the subscription's.",
};
const COUNCIL_SYNTHESIS = "Retry exactly once.";
// The stage a call belongs to, read from the prompt the council actually sent:
// a fake panel has to answer stage 2 in JSON and stage 3 in prose, and the text
// of the prompt is the only thing that tells them apart.
const councilReply = (req: InternalRequest): ProviderEvent[] => {
  const prompt = req.messages[0].text;
  const shown = [...prompt.matchAll(/^(Response [A-Z]+):$/gm)].map((m) => m[1]);
  const text = prompt.includes("Reply with JSON only")
    ? JSON.stringify(shown.map((label, i) => ({ label, rank: i + 1, reason: "ranked in the order shown" })))
    : prompt.includes("You are writing the final answer") ? COUNCIL_SYNTHESIS
      : COUNCIL_ANSWERS[req.model] ?? "no opinion";
  return [{ type: "text", delta: text }, { type: "done", usage: { input: 10, output: 2 } }];
};

function makeCouncil(seats: Seat[] = COUNCIL_SEATS, agyScript: Script = councilReply) {
  const claude = new FakeProvider("claude", ["claude-opus", "claude-haiku"], councilReply, 2);
  const codex = new FakeProvider("codex", ["codex-astra"], councilReply, 1);
  const agy = new FakeProvider("agy", ["agy-pro"], agyScript, 1);
  const usage = new UsageStore(":memory:");
  const core = new Core([claude, codex, agy], usage, { maxWaitMs: QUEUE_WAIT_MS, budgets: {}, log: createLogger("t") });
  const council = new Council("capitoline", { ...COUNCIL_CFG, seats }, core, createLogger("t"));
  core.registerVirtual("capitoline", (q, ctx) => council.deliberate(q, ctx), (models) => council.seatable(models));
  return { core, claude, codex, agy, app: createApp(core, { log: createLogger("t") }) };
}

/** A deliberation detail with nothing in it: these tests carry it, none of them reads it. */
const DETAIL: Deliberation = {
  deliberationId: "d-1", strategyVersion: 1, shape: "ranked", members: [], lost: [], rankings: [], aggregate: [],
  judge: { model: "claude-haiku", blind: true }, calls: 2,
};
const SYNTHESIS: CouncilEvent[] = [{ type: "text", delta: "the synthesis" }, { type: "done", usage: { input: 6, output: 2 }, detail: DETAIL }];

// A council that answers at once, for the tests that are about the request and
// not about the deliberation: nine real calls would prove nothing here.
function makeVirtual(events: CouncilEvent[] = SYNTHESIS) {
  return makeVirtualRun(async function* () { yield* events; });
}

// The same, with the deliberation written by hand: a test that is about *when*
// a byte is written needs an engine it can hold still, which a scripted array
// cannot do.
function makeVirtualRun(run: (question: string, ctx: Context) => AsyncIterable<CouncilEvent>) {
  const p = new FakeProvider("claude", ["claude-opus"], OK, 1);
  const usage = new UsageStore(":memory:");
  const core = new Core([p], usage, { maxWaitMs: QUEUE_WAIT_MS, budgets: {}, log: createLogger("t") });
  core.registerVirtual("capitoline", run);
  return { core, app: createApp(core, { log: createLogger("t") }) };
}

describe("a council over HTTP", () => {
  it("is listed while its quorum can be filled, and is dropped with its reason on /health once it cannot", async () => {
    const { app, core, claude, codex } = makeCouncil();
    const listing = async () => (await request(app).get("/v1/models")).body.data as { id: string; owned_by: string; capitoline: { kind: string } }[];
    expect((await listing()).map((m) => [m.id, m.owned_by, m.capitoline.kind])).toContainEqual(["capitoline", "capitoline", "council"]);
    codex.healthResult = { ok: false, kind: "auth_expired", detail: "expired", checkedAt: 0 };
    await core.checkHealth("codex");
    // /v1/models carries the available models and nothing else (spec 6.4), so
    // a council that cannot seat its quorum leaves the list exactly as a
    // paused model does. The reason is read from /health — and from the MCP
    // list_models tool, which also reports the unavailable ones.
    expect((await listing()).map((m) => m.id)).not.toContain("capitoline");
    const health = await request(app).get("/health");
    const listed = health.body.models.find((m: { name: string }) => m.name === "capitoline");
    expect(listed).toMatchObject({ available: false, kind: "council", provider: "capitoline" });
    expect(listed.reason).toMatch(/1 of 2 seats/);
    expect(listed.reason).toMatch(/quorum is 2/);
    expect(listed.reason).not.toMatch(/expired/);          // never the provider's own words
    // And the request is refused with it, instead of spending the one call
    // left and answering with a single model under the council's name.
    const r = await request(app).post("/v1/chat/completions").send({ model: "capitoline", messages: [{ role: "user", content: "why?" }] });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("model_unavailable");
    expect(claude.calls.length).toBe(0);
  });

  it("declares reasoning_effort ignored for a council instead of dropping it", async () => {
    const { app } = makeVirtual();
    const r = await request(app).post("/v1/chat/completions")
      .send({ model: "capitoline", messages: [{ role: "user", content: "why?" }], reasoning_effort: "high" });
    expect(r.status).toBe(200);
    expect(r.body.choices[0].message.content).toBe("the synthesis");
    // The gateway honors reasoning_effort on every real model, so dropping it
    // here in silence would be a lie about what was asked (spec 6.1).
    expect(r.headers["x-capitoline-ignored"]).toBe("reasoning_effort");
    expect(r.body.capitoline.ignored).toEqual(["reasoning_effort"]);
    const real = await request(make().app).post("/v1/chat/completions").send(body({ reasoning_effort: "high" }));
    expect(real.headers["x-capitoline-ignored"]).toBeUndefined();
  });

  it("refuses a council request whose message is an image", async () => {
    const { app } = makeVirtual();
    const r = await request(app).post("/v1/chat/completions").send({
      model: "capitoline",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] }],
    });
    // The image travels in `attachments` and the message keeps only its text,
    // which here is nothing: served, this would have been nine calls on the
    // empty question with the image seen by nobody.
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("bad_request");
  });

  it("returns the synthesis as the message content, with the whole deliberation in the capitoline field", async () => {
    const { app, claude, codex } = makeCouncil();
    const r = await request(app).post("/v1/chat/completions").send({ model: "capitoline", messages: [{ role: "user", content: "retry?" }] });
    expect(r.status).toBe(200);
    expect(r.body.model).toBe("capitoline");
    expect(r.body.choices[0].message).toEqual({ role: "assistant", content: COUNCIL_SYNTHESIS });
    // Two answers, two rankings, one synthesis: five calls, and the usage is
    // the sum of all five (§12.7 counts them under the real models; this is
    // what the client is charged for the question).
    expect(r.body.usage).toEqual({ prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 });
    expect(r.body.capitoline.provider).toBe("capitoline");
    // Un-blinded, after the fact: the labels the panel ranked under sit next
    // to the real model names, where no prompt could reach them (§12.4/12.6).
    const d = r.body.capitoline.council as Deliberation;
    expect(d.members.map((m) => [m.family, m.model, m.answer])).toEqual([
      ["anthropic", "claude-opus", COUNCIL_ANSWERS["claude-opus"]],
      ["openai", "codex-astra", COUNCIL_ANSWERS["codex-astra"]],
    ]);
    expect(d.members.map((m) => m.label).sort()).toEqual(["Response A", "Response B"]);
    expect(d.rankings.map((r2) => r2.by).sort()).toEqual(["claude-opus", "codex-astra"]);
    expect(d.aggregate.map((a) => a.votes)).toEqual([2, 2]);
    // The shape travels over HTTP with the rest of the record: `detail` is
    // passed whole, and nothing but this asserts that it arrives.
    expect(d.shape).toBe("ranked");
    expect(d.judge).toEqual({ model: "claude-haiku", blind: true });
    expect(d.calls).toBe(5);
    expect(d.deliberationId).toEqual(expect.any(String));
    // And the other end of the same request: the five prompts the panel was
    // actually sent. The rankings and the blind judge see the answers under
    // their labels only, so no prompt may carry a real model name — the
    // un-blinding of §12.4 happens after the fact, in the field read above.
    const prompts = [...claude.calls, ...codex.calls].map((c) => c.messages[0].text);
    expect(prompts.length).toBe(5);
    for (const p of prompts) {
      expect(p).not.toContain("claude-opus");
      expect(p).not.toContain("codex-astra");
      expect(p).not.toContain("claude-haiku");
    }
  });

  it("declares a lost seat in the deliberation, with the kind and never the provider's words", async () => {
    const { app } = makeCouncil(THREE_SEATS, [{ type: "error", kind: "cli_crashed", detail: "SECRET-STDERR: Traceback" }]);
    const r = await request(app).post("/v1/chat/completions").send({ model: "capitoline", messages: [{ role: "user", content: "retry?" }] });
    expect(r.status).toBe(200);
    const d = r.body.capitoline.council as Deliberation;
    expect(d.members.map((m) => m.model)).toEqual(["claude-opus", "codex-astra"]);
    expect(d.lost).toEqual([{ family: "google", model: "agy-pro", reason: "cli_crashed" }]);
    expect(JSON.stringify(r.body)).not.toContain("SECRET-STDERR");
  });

  it("streams the progress of the two silent stages, then the synthesis, then the deliberation", async () => {
    const { app } = makeCouncil();
    const r = await request(app).post("/v1/chat/completions").send({ model: "capitoline", stream: true, messages: [{ role: "user", content: "retry?" }] });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/event-stream/);
    const chunks = sseLines(r.text);
    expect(chunks.at(-1)).toBe("[DONE]");
    const parsed = chunks.slice(0, -1).map((c) => JSON.parse(c));
    expect(parsed[0].choices[0].delta).toEqual({ role: "assistant", content: "" });

    // A progress chunk is an ordinary OpenAI chunk with an empty content
    // delta: a client that knows nothing of the council renders nothing, and
    // a curious one reads the stage out of the capitoline field (§12.6).
    const progress = parsed.filter((c) => c.capitoline?.stage !== undefined);
    for (const c of progress) {
      expect(c.object).toBe("chat.completion.chunk");
      expect(c.id).toBe(parsed[0].id);
      expect(c.model).toBe("capitoline");
      expect(c.choices).toEqual([{ index: 0, delta: { content: "" }, finish_reason: null }]);
    }
    expect(progress.map((c) => [c.capitoline.stage, c.capitoline.done, c.capitoline.total])).toEqual([
      ["answers", 0, 2], ["answers", 1, 2], ["answers", 2, 2],
      ["rankings", 0, 2], ["rankings", 1, 2], ["rankings", 2, 2],
      ["synthesis", 0, 1], ["synthesis", 1, 1],
    ]);
    // The synthesis itself is ordinary content, as from any other model.
    expect(parsed.filter((c) => c.capitoline?.stage === undefined).map((c) => c.choices[0].delta.content ?? "").join("")).toBe(COUNCIL_SYNTHESIS);
    const last = parsed.at(-1);
    expect(last.choices[0].finish_reason).toBe("stop");
    expect(last.usage).toEqual({ prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 });
    expect(last.capitoline.provider).toBe("capitoline");
    expect((last.capitoline.council as Deliberation).members.map((m) => m.model)).toEqual(["claude-opus", "codex-astra"]);
  });

  // The reason the stream cannot wait for the first token: two stages produce
  // none, up to `stage_timeout_s` each, and Cloudflare's edge answers the
  // client 524 after 100 s of silence while the nine calls carry on being
  // spent for nobody (docs/deploy.md §9).
  it("opens the stream before the first stage, not on the first token", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const { app } = makeVirtualRun(async function* () {
      yield { type: "progress", stage: "answers", done: 0, total: 2 };
      await held;                     // the panel is thinking, and says nothing
      yield* SYNTHESIS;
    });
    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "capitoline", stream: true, messages: [{ role: "user", content: "retry?" }] }),
        signal: AbortSignal.timeout(3000),
      });
      // The headers are out while stage 1 is still running: this line is the
      // whole test, and it hangs until the timeout without the early open.
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let head = "";
      while (sseLines(head).length < 2) head += decoder.decode((await reader.read()).value, { stream: true });
      const open = sseLines(head).map((c) => JSON.parse(c));
      expect(open[0].choices[0].delta).toEqual({ role: "assistant", content: "" });
      expect(open[1].capitoline).toEqual({ stage: "answers", done: 0, total: 2 });
      release();
      let rest = head;
      for (let step = await reader.read(); step.done !== true; step = await reader.read()) rest += decoder.decode(step.value, { stream: true });
      expect(sseLines(rest).at(-1)).toBe("[DONE]");
      expect(rest).toContain("the synthesis");
    } finally {
      release();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // Opening the stream early only moves the silence: between `answers 0/n` and
  // `answers 1/n`, and above all between `synthesis 0/1` — written before the
  // judge is even seated — and the judge's first token, nothing is written for
  // as long as a member takes. That is the same 100 s the early open exists to
  // survive, and it would now break a stream the client has already been given
  // a 200 for. Only setInterval is faked: the socket, the fetch and the
  // deliberation stay real, and this test would otherwise wait 20 s.
  it("keeps the stream alive while a stage runs, with a frame no client reads as a chunk", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const { app } = makeVirtualRun(async function* () {
      yield { type: "progress", stage: "synthesis", done: 0, total: 1 };
      await held;                     // the judge is reading four long answers
      yield* SYNTHESIS;
    });
    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "capitoline", stream: true, messages: [{ role: "user", content: "retry?" }] }),
        signal: AbortSignal.timeout(3000),
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const read = async () => decoder.decode((await reader.read()).value, { stream: true });
      let head = "";
      while (sseFrames(head).length < 2) head += await read();
      // Twenty seconds into a stage that writes nothing. Without the tick the
      // next byte is the judge's first token, minutes away.
      await vi.advanceTimersByTimeAsync(20_000);
      let beat = "";
      while (beat === "") beat += await read();
      expect(sseFrames(beat)).toEqual([": keep-alive"]);
      expect(sseLines(beat)).toEqual([]);     // no field, so no chunk: a parser drops it
      release();
      let rest = "";
      for (let step = await reader.read(); step.done !== true; step = await reader.read()) rest += decoder.decode(step.value, { stream: true });
      expect(sseLines(rest).at(-1)).toBe("[DONE]");
      expect(rest).toContain("the synthesis");
    } finally {
      release();
      vi.useRealTimers();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("refuses a council that produced no answer with the kind of the failure that ended it", async () => {
    const { app } = makeVirtual([{ type: "error", kind: "rate_limited", detail: "every seat was refused" }]);
    const r = await request(app).post("/v1/chat/completions").send({ model: "capitoline", messages: [{ role: "user", content: "retry?" }] });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe("rate_limited");
    expect(r.body.error.message).toBe("provider rate limit reached");
    expect(r.text).not.toContain("every seat was refused");   // the council's own account stays in the log
    expect(r.headers["retry-after"]).toBe("60");               // nothing named a wait: the default of httpStatus
  });

  it("answers a rate-limited council with the wait the refused member was given", async () => {
    const { app } = makeVirtual([{ type: "error", kind: "rate_limited", detail: "every seat was refused", retryAfterS: 1200 }]);
    const r = await request(app).post("/v1/chat/completions").send({ model: "capitoline", messages: [{ role: "user", content: "retry?" }] });
    expect(r.status).toBe(429);
    // Twenty minutes, not the minute the default would have sent the client
    // back in — into a refusal the gateway would answer from the standing
    // pause, which is the one thing Retry-After exists to avoid.
    expect(r.headers["retry-after"]).toBe("1200");
  });

  it("ends a stream that already started with an error chunk and no [DONE]", async () => {
    const { app } = makeVirtual([
      { type: "progress", stage: "answers", done: 0, total: 2 },
      { type: "error", kind: "queue_full", detail: "the provider queue did not open" },
    ]);
    const r = await request(app).post("/v1/chat/completions").send({ model: "capitoline", stream: true, messages: [{ role: "user", content: "retry?" }] });
    expect(r.status).toBe(200);
    const chunks = sseLines(r.text);
    expect(chunks).not.toContain("[DONE]");
    expect(JSON.parse(chunks.at(-1)!).error).toEqual({ message: "the gateway is busy: the provider queue did not open in time", type: "server_error", code: "queue_full" });
  });
});

// B4: with more than one application behind the gateway, the row has to say
// which one spent the window. The identity is the Access middleware's, and it
// is the only source: with verification disabled the caller is null.
describe("usage attribution", () => {
  it("records the caller the Access middleware identified", async () => {
    const { app, usage } = make(OK, asCaller({ email: "me@example.com", sub: "u1", type: "user" }));
    expect((await request(app).post("/v1/chat/completions").send(body())).status).toBe(200);
    expect(usage.callers(60_000)).toEqual([{ caller: "me@example.com", calls: 1, inputTokens: 3, outputTokens: 2 }]);
  });
  it("records a service token by the name it carries", async () => {
    const { app, usage } = make(OK, asCaller({ sub: "", type: "service", name: "claude-code" }));
    await request(app).post("/v1/chat/completions").send(body());
    expect(usage.callers(60_000)).toEqual([{ caller: "claude-code", calls: 1, inputTokens: 3, outputTokens: 2 }]);
  });
  it("records no caller when Access verification is disabled", async () => {
    const { app, usage } = make();
    await request(app).post("/v1/chat/completions").send(body());
    expect(usage.callers(60_000)).toEqual([{ caller: null, calls: 1, inputTokens: 3, outputTokens: 2 }]);
  });
  it("attributes an image generation as well as a completion", async () => {
    const { app, usage } = makeImages([IMG, { type: "done" }], asCaller({ email: "me@example.com", sub: "u1", type: "user" }));
    expect((await request(app).post("/v1/images/generations").send({ prompt: "a lighthouse", model: "agy-image" })).status).toBe(200);
    expect(usage.callers(60_000)).toEqual([{ caller: "me@example.com", calls: 1, inputTokens: 0, outputTokens: 0 }]);
  });
  // The breakdown names people, so it lives under /v1, behind Access, and not
  // on the one route left open to anyone who can reach 127.0.0.1 on the host.
  it("breaks the last 24 hours down by caller on /v1/usage, and never on /health", async () => {
    const { app } = make(OK, asCaller({ email: "me@example.com", sub: "u1", type: "user" }));
    await request(app).post("/v1/chat/completions").send(body());
    await request(app).post("/v1/chat/completions").send(body());
    const r = await request(app).get("/v1/usage");
    expect(r.status).toBe(200);
    expect(r.body.callers).toEqual([{ caller: "me@example.com", calls: 2, inputTokens: 6, outputTokens: 4 }]);
    expect((await request(app).get("/health")).body).not.toHaveProperty("callers");
  });
});

describe("access middleware placement", () => {
  it("protects /v1 and /mcp before the body is parsed, leaves /health open", async () => {
    const { app } = make(OK, deny);
    expect((await request(app).get("/v1/models")).status).toBe(401);
    expect((await request(app).get("/v1/usage")).status).toBe(401);
    expect((await request(app).post("/mcp").send({})).status).toBe(401);
    expect((await request(app).get("/health")).status).toBe(200);
    // A malformed body without a token is refused as unauthenticated, not as a bad request.
    const r = await request(app).post("/v1/chat/completions").set("Content-Type", "application/json").send("{not json");
    expect(r.status).toBe(401);
    expect((await request(app).get("/v1/models").set("Cf-Access-Jwt-Assertion", "x")).status).toBe(200);
  });
});
