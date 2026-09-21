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
  // The invariant, not two literals: `.nvmrc` is the single place a Node bump
  // is written, and `engines` has to be the major it names, nothing else. The
  // URLs are resolved against this file, not against process.cwd().
  it("pins the deployment Node major in .nvmrc and derives package.json engines from it", () => {
    const major = readFileSync(new URL("../.nvmrc", import.meta.url), "utf8").trim();
    expect(major).toMatch(/^\d+$/);
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { engines: { node: string } };
    expect(pkg.engines.node).toBe(`>=${major} <${Number(major) + 1}`);
  });
});
