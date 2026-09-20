import { describe, it, expect } from "vitest";
import { classifyError } from "../src/providers/errors.js";

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
