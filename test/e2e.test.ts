import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { start } from "../src/main.js";
import { IMAGE_PROMPT } from "../src/providers/antigravity.js";

// Resolved from this module, not from process.cwd(): vitest runs from wherever
// it was invoked, and a path that misses would blow up at import time.
const SAMPLE = readFileSync(fileURLToPath(new URL("fixtures/images/sample.jpg", import.meta.url)));

let app: Awaited<ReturnType<typeof start>>;
// 30 s, not vitest's default 10 s hook timeout: this hook starts the whole
// gateway, sweeps the sandbox root and runs the first health check, which
// spawns three fake CLIs. Under load that can pass 10 s, and the failure would
// then read "hook timed out" with nothing saying which step was slow.
beforeAll(async () => { app = await start("test/e2e.config.yaml", { port: 0 }); }, 30_000);
afterAll(async () => { await app.close(); });

describe("end to end with fake CLIs", () => {
  it("serves all configured models as available after the startup health check, the council among them", async () => {
    const r = await fetch(`http://127.0.0.1:${app.port}/v1/models`);
    const data = ((await r.json()) as { data: { id: string; owned_by: string; capitoline: { kind: string } }[] }).data;
    // `capitoline` is in the list because main.ts registered the configured
    // council as a virtual model and its four seats can all be filled: a
    // client asks for it in `model` exactly as for the real ones (design §12).
    expect(data.map((m) => m.id).sort()).toEqual(["agy-claude-opus", "agy-claude-sonnet", "agy-gemini-3.6-flash", "agy-gemini-3.7-flash", "agy-gemini-flash", "agy-gemini-pro", "agy-gpt-oss", "agy-image", "capitoline", "claude-fable", "claude-haiku", "claude-opus", "claude-sonnet", "codex-gpt-5.5", "codex-gpt-5.6-sol", "codex-gpt-6-astra"]);
    // Owned by the gateway and of a kind of its own: it is served by no
    // provider, and its nine calls are accounted under the models that served
    // them (§12.7).
    expect(data.find((m) => m.id === "capitoline")).toMatchObject({ owned_by: "capitoline", capitoline: { kind: "council" } });
  });
  it.each([["claude-opus", "ok"], ["codex-gpt-5.5", "OK"], ["agy-gemini-flash", "ok ok\n"]])("answers through %s", async (model, expected) => {
    const r = await fetch(`http://127.0.0.1:${app.port}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { choices: { message: { content: string } }[]; usage: { total_tokens: number } };
    expect(body.choices[0].message.content).toBe(expected);
    expect(body.usage.total_tokens).toBeGreaterThan(0);
  });
  it("streams through the fake claude", async () => {
    const r = await fetch(`http://127.0.0.1:${app.port}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    // The stream is parsed, not sniffed for its last line: an empty answer, a
    // wrong id per chunk or a missing usage block all ended with "data: [DONE]"
    // just the same, so the trailer alone asserted almost nothing.
    const frames = (await r.text()).split("\n\n").map((f) => f.trim()).filter((f) => f.length > 0);
    expect(frames.every((f) => f.startsWith("data: "))).toBe(true);
    const payloads = frames.map((f) => f.slice("data: ".length));
    expect(payloads.at(-1)).toBe("[DONE]");
    type Chunk = { id: string; object: string; model: string; choices: { delta: { role?: string; content?: string }; finish_reason: string | null }[]; usage?: Record<string, number> };
    const chunks = payloads.slice(0, -1).map((p) => JSON.parse(p) as Chunk);
    expect(chunks.length).toBeGreaterThanOrEqual(3);            // opener, at least one delta, terminator
    expect(chunks.every((c) => c.object === "chat.completion.chunk" && c.model === "claude-opus")).toBe(true);
    expect(new Set(chunks.map((c) => c.id)).size).toBe(1);      // one completion, one id
    // The opener carries the role and no content; only the last chunk finishes.
    expect(chunks[0].choices[0]).toEqual({ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null });
    expect(chunks.slice(0, -1).every((c) => c.choices[0].finish_reason === null)).toBe(true);
    // The recorded fixture's own answer, reassembled from the deltas.
    expect(chunks.slice(1, -1).map((c) => c.choices[0].delta.content).join("")).toBe("ok");
    const last = chunks.at(-1)!;
    expect(last.choices[0]).toEqual({ index: 0, delta: {}, finish_reason: "stop" });
    // Usage rides on the terminating chunk and nowhere else, with the cache
    // tokens of the fixture counted as input (2 + 518 + 2113).
    expect(last.usage).toEqual({ prompt_tokens: 2633, completion_tokens: 4, total_tokens: 2637 });
    expect(chunks.slice(0, -1).every((c) => c.usage === undefined)).toBe(true);
  });
  it("reports the kind of every model, image included", async () => {
    const r = await fetch(`http://127.0.0.1:${app.port}/v1/models`);
    const data = ((await r.json()) as { data: { id: string; capitoline: { kind: string; quota?: { used: number; limit: number | null } } }[] }).data;
    const kinds = Object.fromEntries(data.map((m) => [m.id, m.capitoline.kind]));
    // The configured quota travelled from the YAML through main.ts into Core:
    // a wrong provider key there would leave this null with every unit test
    // still green.
    expect(data.find((m) => m.id === "agy-image")!.capitoline.quota).toEqual({ used: 0, limit: 12, window_started_at: null });
    expect(kinds["agy-image"]).toBe("image");
    expect(kinds["agy-gemini-3.7-flash"]).toBe("text");
    expect(kinds["agy-gemini-3.6-flash"]).toBe("text");
    expect(kinds["agy-gemini-flash"]).toBe("text");
  });
});

// The fake CLI answers one binary for both kinds of run, as the real `agy` does:
// what it replays is decided by the prompt it is handed on stdin. Without this
// the image route would be exercised against the chat recording, which carries
// no tool step at all.
describe("the fake antigravity CLI picks its recording from the prompt", () => {
  const AGY = fileURLToPath(new URL("fake-cli/fake-agy.sh", import.meta.url));
  const userEvent = (content: string) => JSON.stringify({ event: "user", message: { role: "user", content } }) + "\n";
  const run = (stdin: string) => spawnSync(AGY, ["--output-format", "stream-json"], { input: stdin, encoding: "utf8" });

  it("replays the recorded image run when the prompt asks for the generate_image tool", () => {
    // The production prompt itself, so that rewording it breaks this test
    // instead of silently sending the image route back to the chat recording.
    const r = run(userEvent(IMAGE_PROMPT("a lighthouse")));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`"step_type":"tool"`);
    expect(r.stdout).toContain(`"tool_name":"generate_image"`);
    expect(r.stdout).toContain("40fc0b5c-042f-453a-9eaf-6162913de55e");
  });
  it("replays the chat stream for an ordinary prompt", () => {
    const r = run(userEvent("hi"));
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(`"step_type":"tool"`);
    expect(r.stdout).toContain("fdc15146-e14d-4592-a062-8bebca386077");
  });
});

describe("image generation end to end", () => {
  // The fake collect helper hands back the sample JPEG only for the conversation
  // id of the recorded image run: if the fake CLI ever replayed the chat stream
  // instead, these tests fail rather than being handed an image out of nowhere.
  beforeAll(() => { process.env.FAKE_COLLECT = "image-run"; });
  afterAll(() => { delete process.env.FAKE_COLLECT; });

  const post = (body: unknown, path = "/v1/images/generations") =>
    fetch(`http://127.0.0.1:${app.port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("generates an image with the default image model and returns it inline", async () => {
    const r = await post({ prompt: "a lighthouse on a cliff at dawn, watercolour" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { data: { b64_json: string }[]; capitoline: Record<string, unknown> };
    const bytes = Buffer.from(body.data[0].b64_json, "base64");
    // FF D8: the bytes really are the JPEG the collect helper handed over.
    expect(bytes.subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(bytes.equals(SAMPLE)).toBe(true);
    // Exact, not partial: no provider detail (stderr, conversation id, host
    // paths) may leak into the response, here or in the body's top level.
    expect(body.capitoline).toEqual({
      provider: "antigravity", model: "agy-image", mime: "image/jpeg", width: 1376, height: 768, bytes: SAMPLE.length, ignored: [],
    });
    expect(Object.keys(body).sort()).toEqual(["capitoline", "created", "data"]);
  });
  it("ignores size and says so in the header", async () => {
    const r = await post({ prompt: "a lighthouse", size: "1024x1024" });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-capitoline-ignored")).toBe("size");
  });
  it("refuses an image request against a text model", async () => {
    const r = await post({ model: "agy-gemini-flash", prompt: "a lighthouse" });
    expect(r.status).toBe(400);
    // The message pins the refusal to the kind check in core, not to some other
    // bad_request (a zod rejection carries the same code).
    expect((await r.json()) as { error: { code: string; message: string } })
      .toMatchObject({ error: { code: "bad_request", message: expect.stringContaining("use the chat endpoint") } });
  });
  it("refuses a chat request against the image model", async () => {
    const r = await post({ model: "agy-image", messages: [{ role: "user", content: "hi" }] }, "/v1/chat/completions");
    expect(r.status).toBe(400);
    expect((await r.json()) as { error: { code: string; message: string } })
      .toMatchObject({ error: { code: "bad_request", message: expect.stringContaining("use the images endpoint") } });
  });
});
