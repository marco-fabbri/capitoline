import { describe, it, expect } from "vitest";
import { loadConfig, parseConfig } from "../src/config.js";

describe("config", () => {
  it("loads the repository config", () => {
    const cfg = loadConfig("config/capitoline.yaml");
    expect(Object.keys(cfg.providers).sort()).toEqual(["antigravity", "claude", "codex"]);
    expect(cfg.providers.claude.models["claude-opus"].cli_model).toBe("opus");
    expect(cfg.providers.antigravity.models["agy-gemini-flash"].effort_suffix).toBe(true);
    expect(cfg.server.port).toBe(8080);
    expect(cfg.usage.db_path).toBe("capitoline.sqlite");
  });
  it("rejects a health_model that is not one of the provider's models", () => {
    const text = `
providers:
  x: { binary: x, concurrency: 1, timeout_s: 1, budget: {window_5h_tokens: 0, window_7d_tokens: 0},
       health_model: nope, models: { a: {cli_model: a} }, effort: {}, args: [], system_prompt_flag: null, prompt_via: stdin }
runner: { sandbox_root: /tmp/x }
`;
    expect(() => parseConfig(text)).toThrow(/health_model/);
  });
  it("rejects the same public model name in two providers", () => {
    const text = `
providers:
  x: { binary: x, concurrency: 1, timeout_s: 1, budget: {window_5h_tokens: 0, window_7d_tokens: 0},
       health_model: a, models: { a: {cli_model: a} }, effort: {}, args: [], system_prompt_flag: null, prompt_via: stdin }
  y: { binary: y, concurrency: 1, timeout_s: 1, budget: {window_5h_tokens: 0, window_7d_tokens: 0},
       health_model: a, models: { a: {cli_model: a} }, effort: {}, args: [], system_prompt_flag: null, prompt_via: stdin }
runner: { sandbox_root: /tmp/x }
`;
    expect(() => parseConfig(text)).toThrow(/duplicate model name "a"/);
  });
  it("rejects reserved council names", () => {
    const text = `
providers:
  x: { binary: x, concurrency: 1, timeout_s: 1, budget: {window_5h_tokens: 0, window_7d_tokens: 0},
       health_model: capitoline, models: { capitoline: {cli_model: a} }, effort: {}, args: [], system_prompt_flag: null, prompt_via: stdin }
runner: { sandbox_root: /tmp/x }
`;
    expect(() => parseConfig(text)).toThrow(/reserved/);
  });
});
