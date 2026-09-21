import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { start } from "../src/main.js";

const SAMPLE = readFileSync(join(process.cwd(), "test/fixtures/images/sample.jpg"));

let app: Awaited<ReturnType<typeof start>>;
beforeAll(async () => { app = await start("test/e2e.config.yaml", { port: 0 }); });
afterAll(async () => { await app.close(); });

describe("end to end with fake CLIs", () => {
  it("serves all configured models as available after the startup health check", async () => {
    const r = await fetch(`http://127.0.0.1:${app.port}/v1/models`);
    const ids = ((await r.json()) as { data: { id: string }[] }).data.map((m) => m.id).sort();
    expect(ids).toEqual(["agy-claude-opus", "agy-claude-sonnet", "agy-gemini-3.6-flash", "agy-gemini-3.7-flash", "agy-gemini-flash", "agy-gemini-pro", "agy-image", "claude-fable", "claude-haiku", "claude-opus", "claude-sonnet", "codex-gpt-5.5", "codex-gpt-5.6-sol", "codex-gpt-6-astra"]);
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
    const text = await r.text();
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
  });
  it("reports the kind of every model, image included", async () => {
    const r = await fetch(`http://127.0.0.1:${app.port}/v1/models`);
    const data = ((await r.json()) as { data: { id: string; capitoline: { kind: string } }[] }).data;
    const kinds = Object.fromEntries(data.map((m) => [m.id, m.capitoline.kind]));
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
  const AGY = join(process.cwd(), "test/fake-cli/fake-agy.sh");
  const userEvent = (content: string) => JSON.stringify({ event: "user", message: { role: "user", content } }) + "\n";
  const run = (stdin: string) => spawnSync(AGY, ["--output-format", "stream-json"], { input: stdin, encoding: "utf8" });

  it("replays the recorded image run when the prompt asks for the generate_image tool", () => {
    const r = run(userEvent('Use the generate_image tool exactly once, with ImageName "image", to create this image: a lighthouse'));
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
    expect(body.capitoline).toMatchObject({
      provider: "antigravity", model: "agy-image", mime: "image/jpeg", width: 1376, height: 768, bytes: SAMPLE.length, ignored: [],
    });
  });
  it("ignores size and says so in the header", async () => {
    const r = await post({ prompt: "a lighthouse", size: "1024x1024" });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-capitoline-ignored")).toBe("size");
  });
  it("refuses an image request against a text model", async () => {
    const r = await post({ model: "agy-gemini-flash", prompt: "a lighthouse" });
    expect(r.status).toBe(400);
    expect((await r.json()) as { error: { code: string } }).toMatchObject({ error: { code: "bad_request" } });
  });
  it("refuses a chat request against the image model", async () => {
    const r = await post({ model: "agy-image", messages: [{ role: "user", content: "hi" }] }, "/v1/chat/completions");
    expect(r.status).toBe(400);
    expect((await r.json()) as { error: { code: string } }).toMatchObject({ error: { code: "bad_request" } });
  });
});
