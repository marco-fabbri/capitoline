import { describe, it, expect } from "vitest";
import { splitSystem, flatten, nearestEffort } from "../src/core/prompt.js";
import type { Effort, Message } from "../src/core/types.js";

describe("splitSystem", () => {
  it("joins all system messages and removes them from the rest", () => {
    const r = splitSystem([{ role: "system", text: "A" }, { role: "user", text: "hi" }, { role: "system", text: "B" }]);
    expect(r.system).toBe("A\n\nB");
    expect(r.rest).toEqual([{ role: "user", text: "hi" }]);
  });
  it("returns null system when absent", () => {
    expect(splitSystem([{ role: "user", text: "hi" }]).system).toBeNull();
  });
});

describe("flatten", () => {
  it("returns a single user message verbatim", () => {
    expect(flatten([{ role: "user", text: "just this" }])).toBe("just this");
  });
  it("adds role markers for multi-turn history and ends with the last user turn", () => {
    const out = flatten([{ role: "user", text: "q1" }, { role: "assistant", text: "a1" }, { role: "user", text: "q2" }]);
    expect(out).toBe("User: q1\n\nAssistant: a1\n\nUser: q2");
  });
});

describe("nearestEffort", () => {
  it("returns the wanted effort when allowed", () => {
    expect(nearestEffort("medium", ["low", "medium", "high"])).toBe("medium");
  });
  it("prefers the higher neighbour on a tie", () => {
    expect(nearestEffort("medium", ["low", "high"])).toBe("high");
  });
  it("clamps to the closest available", () => {
    expect(nearestEffort("high", ["low"])).toBe("low");
    expect(nearestEffort("low", ["medium", "high"])).toBe("medium");
  });
});

describe("prompt guards", () => {
  it("flatten throws on a system message instead of rendering it as 'undefined:'", () => {
    const messages: Message[] = [{ role: "user", text: "q" }, { role: "system", text: "leaked" }];
    expect(() => flatten(messages)).toThrow(/system message/i);
  });
  it("flatten throws on a lone system message too", () => {
    expect(() => flatten([{ role: "system", text: "leaked" }])).toThrow(/system message/i);
  });
  it("nearestEffort throws on an empty allowed list instead of returning undefined", () => {
    expect(() => nearestEffort("medium", [])).toThrow(/allowed/i);
  });
  it("nearestEffort throws on an unknown wanted level instead of clamping it to the lowest", () => {
    expect(() => nearestEffort("extreme" as Effort, ["low", "medium", "high"])).toThrow(/extreme/);
  });
});
