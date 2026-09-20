import { describe, it, expect } from "vitest";
import { createLogger } from "../src/log.js";
describe("scaffold", () => {
  it("creates a logger", () => {
    expect(createLogger("test").level).toBeDefined();
  });
});
