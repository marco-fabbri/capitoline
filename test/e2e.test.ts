import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { start } from "../src/main.js";

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
});
