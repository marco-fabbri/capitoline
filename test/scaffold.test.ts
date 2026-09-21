import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { createLogger } from "../src/log.js";

/** Collects what pino writes, so the fallback warning can be asserted. */
function sink(): { lines: object[]; write(s: string): void } {
  const lines: object[] = [];
  return { lines, write(s: string) { lines.push(JSON.parse(s)); } };
}

const original = process.env.LOG_LEVEL;
afterEach(() => {
  if (original === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = original;
});

describe("scaffold", () => {
  it("creates a logger bound to its name, at info by default", () => {
    delete process.env.LOG_LEVEL;
    const log = createLogger("test");
    expect(log.bindings().name).toBe("test");
    expect(log.level).toBe("info");
  });
  it("honours a valid LOG_LEVEL", () => {
    process.env.LOG_LEVEL = "debug";
    expect(createLogger("test").level).toBe("debug");
    process.env.LOG_LEVEL = "silent";
    expect(createLogger("test").level).toBe("silent");
  });
  it("falls back to info with a warning on an unknown LOG_LEVEL", () => {
    process.env.LOG_LEVEL = "verbose";
    const dest = sink();
    const log = createLogger("test", dest);
    expect(log.level).toBe("info");
    expect(dest.lines).toHaveLength(1);
    expect(dest.lines[0]).toMatchObject({ level: 40, name: "test", requested: "verbose" });
    expect(JSON.stringify(dest.lines[0])).toMatch(/LOG_LEVEL/);
  });
  it("treats an empty LOG_LEVEL as unset, without a warning", () => {
    process.env.LOG_LEVEL = "";
    const dest = sink();
    expect(createLogger("test", dest).level).toBe("info");
    expect(dest.lines).toEqual([]);
  });
});

describe("repository", () => {
  it("pins the deployment Node major in .nvmrc and package.json engines", () => {
    expect(readFileSync(".nvmrc", "utf8").trim()).toBe("24");
    expect(JSON.parse(readFileSync("package.json", "utf8")).engines.node).toBe(">=24 <25");
  });
});
