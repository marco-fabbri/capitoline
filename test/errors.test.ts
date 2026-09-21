import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyError, detectQuotaExhausted } from "../src/providers/errors.js";

describe("classifyError", () => {
  it.each([
    ["Login expired · Please run /login", "auth_expired"],
    ["Not logged in. Run codex login", "auth_expired"],
    ["401 Unauthorized", "auth_expired"],
    ["Error: invalid or expired OAuth token", "auth_expired"],
    ["You've hit your usage limit. Resets at 5pm", "rate_limited"],
    ["429 Too Many Requests", "rate_limited"],
    ["Rate limit reached for this model", "rate_limited"],
    ["quota exceeded for the current window", "rate_limited"],
    ["segmentation fault", "cli_crashed"],
    ["", "cli_crashed"],
  ])("classifies %j as %s", (text, kind) => {
    expect(classifyError(text)).toBe(kind);
  });
});

type StepUpdate = { state: string; step_type: string; tool_info?: { error?: { message: string } } };

function toolSteps(fixture: string): StepUpdate[] {
  const path = join(process.cwd(), "test/fixtures/antigravity", fixture);
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => JSON.parse(l) as { event: string; step_update?: StepUpdate })
    .filter((o) => o.event === "step_update" && o.step_update?.step_type === "tool")
    .map((o) => o.step_update as StepUpdate);
}

const RESET_AT = Date.parse("2026-09-26T18:40:40Z");
// 122h50m8.592940533s, rounded up: the gateway never retries early.
const RESET_DELAY_S = 442209;

describe("detectQuotaExhausted", () => {
  describe("structured 429 from the real capture (image-429.jsonl)", () => {
    const errorStep = toolSteps("image-429.jsonl").find((s) => s.state === "ERROR")!;
    const message = errorStep.tool_info!.error!.message;

    it("reads the instant, the delay and the model from the tool error message", () => {
      const hit = detectQuotaExhausted(message, 0);
      expect(hit).not.toBeNull();
      expect(hit!.resetAt).toBe(RESET_AT);
      expect(hit!.retryAfterS).toBe(RESET_DELAY_S);
      expect(hit!.model).toBe("gemini-3.1-flash-image");
      expect(hit!.matched).toMatch(/429/);
    });

    it("reads the same values from the adapter's raw event (JSON.stringify of the step)", () => {
      const hit = detectQuotaExhausted(JSON.stringify(errorStep), 0);
      expect(hit).toMatchObject({ resetAt: RESET_AT, retryAfterS: RESET_DELAY_S, model: "gemini-3.1-flash-image" });
    });

    it("prefers the structured delay over the wall clock", () => {
      // `now` far past the reset: the explicit delay still wins.
      const hit = detectQuotaExhausted(message, RESET_AT + 86_400_000);
      expect(hit!.retryAfterS).toBe(RESET_DELAY_S);
    });
  });

  describe("structured variants", () => {
    const body = (error: Record<string, unknown>) => `failed to generate content: 429 Too Many Requests, body: ${JSON.stringify({ error })}`;

    it("accepts the h/m/s delay form", () => {
      const hit = detectQuotaExhausted(body({ code: 429, status: "RESOURCE_EXHAUSTED", details: [{ metadata: { quotaResetDelay: "122h50m8.59s" } }] }));
      expect(hit!.retryAfterS).toBe(RESET_DELAY_S);
      expect(hit!.resetAt).toBeUndefined();
    });

    it("accepts the plain seconds form (RetryInfo.retryDelay)", () => {
      const hit = detectQuotaExhausted(body({ code: 429, details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "442208.59s" }] }));
      expect(hit!.retryAfterS).toBe(RESET_DELAY_S);
    });

    it("derives retryAfterS from the instant when only the instant is present", () => {
      const hit = detectQuotaExhausted(body({ code: 429, details: [{ metadata: { quotaResetTimeStamp: "2026-09-26T18:40:40Z", model: "gemini-3.1-flash-image" } }] }), RESET_AT - 3_600_000);
      expect(hit).toMatchObject({ resetAt: RESET_AT, retryAfterS: 3600, model: "gemini-3.1-flash-image" });
    });

    it("never reports a negative wait for an instant already in the past", () => {
      const hit = detectQuotaExhausted(body({ code: 429, details: [{ metadata: { quotaResetTimeStamp: "2026-09-26T18:40:40Z" } }] }), RESET_AT + 5_000);
      expect(hit!.retryAfterS).toBe(0);
    });

    it("accepts the bare body without the tool message prefix", () => {
      const hit = detectQuotaExhausted(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }));
      expect(hit).not.toBeNull();
      expect(hit!.retryAfterS).toBeUndefined();
    });

    it("ignores an embedded body that is not a 429", () => {
      const text = `failed to generate content: 500 Internal Server Error, body: ${JSON.stringify({ error: { code: 500, status: "INTERNAL" } })}`;
      expect(detectQuotaExhausted(text)).toBeNull();
    });
  });

  describe("loose markers when the JSON is broken", () => {
    it.each([
      ['garbled body: { "code" : 429, "message": "trunc', "429"],
      ["status RESOURCE_EXHAUSTED while calling the tool", "RESOURCE_EXHAUSTED"],
      ["reason QUOTA_EXHAUSTED", "QUOTA_EXHAUSTED"],
    ])("matches %j", (text, marker) => {
      const hit = detectQuotaExhausted(text);
      expect(hit).not.toBeNull();
      expect(hit!.matched).toContain(marker);
    });

    it("still pulls the reset instant and the model out of the broken JSON", () => {
      const text = 'body: { "code": 429, "metadata": { "model": "gemini-3.1-flash-image", "quotaResetTimeStamp": "2026-09-26T18:40:40Z" }, "trunc';
      const hit = detectQuotaExhausted(text, RESET_AT - 60_000);
      expect(hit).toMatchObject({ resetAt: RESET_AT, retryAfterS: 60, model: "gemini-3.1-flash-image" });
    });
  });

  describe("prose fallback", () => {
    it("reads the h/m/s reset from the agent's English prose (spike variant)", () => {
      const prose = "The image generation tool (gemini-3.1-flash-image) returned HTTP 429 RESOURCE_EXHAUSTED: You have exhausted your capacity on this model. Your quota will reset after 4h14m59s.";
      const hit = detectQuotaExhausted(prose);
      expect(hit!.retryAfterS).toBe(15299);
      expect(hit!.model).toBe("gemini-3.1-flash-image");
    });

    it.each([
      ["Sorry, the quota will reset after 4h14m59s.", 15299],
      ["quota exhausted; resets in 2h", 7200],
      ["Rate limited (429). Resets in 30m", 1800],
      ["Your quota resets in 45s", 45],
      ["Quota reset in 1h 5m 3s", 3903],
    ])("%j -> %d s", (text, seconds) => {
      expect(detectQuotaExhausted(text)!.retryAfterS).toBe(seconds);
    });

    it("reports a hit without a wait when the prose gives none", () => {
      const hit = detectQuotaExhausted("I could not generate the image: quota exceeded.");
      expect(hit).not.toBeNull();
      expect(hit!.retryAfterS).toBeUndefined();
      expect(hit!.resetAt).toBeUndefined();
    });
  });

  describe("no false positives", () => {
    it.each([
      ["./image.png\n"],
      ["done\n"],
      [""],
      ["The image has been generated and saved as image.png."],
      ["Reset in 5 minutes"],
    ])("%j -> null", (text) => {
      expect(detectQuotaExhausted(text)).toBeNull();
    });

    it("ignores the successful tool steps of image-run.jsonl", () => {
      const steps = toolSteps("image-run.jsonl");
      expect(steps.length).toBeGreaterThan(0);
      for (const s of steps) expect(detectQuotaExhausted(JSON.stringify(s))).toBeNull();
    });
  });
});
