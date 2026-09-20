import { describe, it, expect } from "vitest";
import { UsageStore } from "../src/usage/store.js";

describe("UsageStore", () => {
  it("records calls and sums them per provider within a window", () => {
    const s = new UsageStore(":memory:");
    const now = 1_000_000_000_000;
    s.record({ provider: "claude", model: "claude-opus", inputTokens: 100, outputTokens: 10, durationMs: 5, outcome: "ok", source: "http", ts: now - 1000 });
    s.record({ provider: "claude", model: "claude-opus", inputTokens: 50, outputTokens: 5, durationMs: 5, outcome: "ok", source: "http", ts: now - 6 * 3600_000 });
    s.record({ provider: "codex", model: "codex-gpt-5.5", inputTokens: 7, outputTokens: 1, durationMs: 5, outcome: "rate_limited", source: "http", ts: now });
    expect(s.totals("claude", 5 * 3600_000, now)).toEqual({ calls: 1, inputTokens: 100, outputTokens: 10 });
    expect(s.totals("claude", 7 * 24 * 3600_000, now)).toEqual({ calls: 2, inputTokens: 150, outputTokens: 15 });
    expect(s.totals("codex", 5 * 3600_000, now).calls).toBe(1);
    s.close();
  });
  it("stores and returns the latest rate-limit windows", () => {
    const s = new UsageStore(":memory:");
    s.setWindow("claude", "five_hour", { utilization: 0.05, resetsAt: 1789896000 }, 10);
    s.setWindow("claude", "five_hour", { utilization: 0.5, resetsAt: 1789896000 }, 20);
    s.setWindow("claude", "seven_day", { utilization: 0.14, resetsAt: 1790362800 }, 20);
    expect(s.windows("claude")).toEqual({
      five_hour: { utilization: 0.5, resetsAt: 1789896000, updatedAt: 20 },
      seven_day: { utilization: 0.14, resetsAt: 1790362800, updatedAt: 20 },
    });
    expect(s.windows("codex")).toEqual({});
    s.close();
  });
});
