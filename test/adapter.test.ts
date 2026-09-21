import { describe, it, expect } from "vitest";
import { loadConfig, type ProviderConfig } from "../src/config.js";
import { effortValue, jsonLines, modelSpecs, systemPromptArgs, type ModelSpec } from "../src/providers/adapter.js";

const base = loadConfig("config/capitoline.yaml").providers.claude;
// The cast is the point of these cases: a table missing a level is what the
// schema cannot forbid once the file is hand-edited on the host.
const withEffort = (effort: Partial<ProviderConfig["effort"]>): ProviderConfig => ({ ...base, effort: effort as ProviderConfig["effort"] });
const model = (efforts?: ModelSpec["efforts"]): ModelSpec =>
  ({ name: "m", provider: "p", cliModel: "m", effortSuffix: false, kind: "text", efforts });

describe("effortValue", () => {
  it("returns the requested level when the model and the table both have it", () => {
    expect(effortValue(base, model(["low", "high"]), "low")).toEqual({ effort: "low", value: "low" });
  });
  it("defaults to medium when the request asks for no effort", () => {
    expect(effortValue(base, model(), undefined)).toEqual({ effort: "medium", value: "medium" });
  });
  it("falls back to a level the provider's table defines when the model offers one it does not", () => {
    // The mismatch the configuration cannot catch: a model declaring an effort
    // the provider's table no longer prices. Picking the nearest level first
    // landed on "high", found no value for it and dropped the effort entirely.
    const cfg = withEffort({ low: "L" });
    expect(effortValue(cfg, model(["low", "high"]), "high")).toEqual({ effort: "low", value: "L" });
  });
  it("returns null when the model offers no level the table defines", () => {
    const cfg = withEffort({ medium: "M" });
    expect(effortValue(cfg, model(["low", "high"]), "high")).toBeNull();
  });
  it("returns null when the provider declares no effort table", () => {
    expect(effortValue(withEffort({}), model(["low"]), "low")).toBeNull();
  });
  it("resolves a level the model does not offer to the higher neighbour", () => {
    // The tie-break is deliberate and pinned here: "medium" on a low/high
    // model runs high. See the note above effortValue for why.
    expect(effortValue(base, model(["low", "high"]), "medium")).toEqual({ effort: "high", value: "high" });
    const cfg = withEffort({ low: "L", high: "H" });
    expect(effortValue(cfg, model(), "medium")).toEqual({ effort: "high", value: "H" });
  });
});

describe("systemPromptArgs", () => {
  // One implementation for all three adapters: before it, only codex.ts read
  // the prefix, so a `-c` on the host's `providers.claude` block validated and
  // changed nothing on the command line.
  const withFlags = (flag: string | null, prefix: string | null): ProviderConfig =>
    ({ ...base, system_prompt_flag: flag, system_prompt_flag_prefix: prefix });

  it("passes the text after the flag when the provider declares no prefix", () => {
    expect(systemPromptArgs(withFlags("--system-prompt", null), 'Be "terse"')).toEqual(["--system-prompt", 'Be "terse"']);
  });
  it("builds a quoted configuration override when the provider declares a prefix", () => {
    expect(systemPromptArgs(withFlags("developer_instructions", "-c"), 'Say "hi"\nthen stop'))
      .toEqual(["-c", 'developer_instructions="Say \\"hi\\"\\nthen stop"']);
    expect(systemPromptArgs(withFlags("developer_instructions", "--config"), "S"))
      .toEqual(["--config", 'developer_instructions="S"']);
  });
  it("replaces what TOML cannot carry, and only in the override form", () => {
    const text = "lone \uD800 and \u007F";
    expect(systemPromptArgs(withFlags("developer_instructions", "-c"), text))
      .toEqual(["-c", 'developer_instructions="lone � and �"']);
    // A bare flag hands the text to the CLI as its own argument: no TOML
    // parser ever reads it, so nothing is replaced and the prompt arrives
    // exactly as the client wrote it.
    expect(systemPromptArgs(withFlags("--system-prompt", null), text)).toEqual(["--system-prompt", text]);
  });
  it("returns nothing when the provider names no key for the system prompt", () => {
    // The caller then prepends the text to the prompt, which is all that is
    // left to do with it. The second pair is refused by the configuration (a
    // prefix with no flag to introduce); the helper still has to answer.
    expect(systemPromptArgs(withFlags(null, null), "S")).toEqual([]);
    expect(systemPromptArgs(withFlags(null, "-c"), "S")).toEqual([]);
  });
});

describe("modelSpecs", () => {
  it("turns a provider's model table into specs, keeping every per-model key", () => {
    const agy = loadConfig("config/capitoline.yaml").providers.antigravity;
    const specs = modelSpecs("antigravity", agy);
    expect(specs.map((s) => s.name)).toEqual(Object.keys(agy.models));
    expect(specs.find((s) => s.name === "agy-gemini-flash")).toEqual({
      name: "agy-gemini-flash", provider: "antigravity", cliModel: "gemini-3.8-flash",
      effortSuffix: true, efforts: undefined, kind: "text", timeoutS: undefined,
    });
    // The two per-model overrides with consequences: `kind` decides which
    // endpoint may route to the model at all, and `timeout_s` is the only
    // thing keeping an image run from inheriting the provider's 600 s.
    expect(specs.find((s) => s.name === "agy-image")).toEqual({
      name: "agy-image", provider: "antigravity", cliModel: "gemini-3.8-flash-low",
      effortSuffix: false, efforts: undefined, kind: "image", timeoutS: 240,
    });
    expect(specs.find((s) => s.name === "agy-gemini-pro")!.efforts).toEqual(["low", "high"]);
  });
  it("stamps the provider id it was given, not one read from the file", () => {
    // The id is the registry key, and it is what Core pauses and what the
    // usage rows are attributed to: it comes from the caller on purpose.
    expect(modelSpecs("elsewhere", base).every((s) => s.provider === "elsewhere")).toBe(true);
  });
  it("returns nothing for a provider declaring no models", () => {
    expect(modelSpecs("p", { ...base, models: {} })).toEqual([]);
  });
});

describe("jsonLines", () => {
  const collect = async (...lines: string[]) => {
    const out: Record<string, unknown>[] = [];
    for await (const o of jsonLines((async function* () { for (const l of lines) yield l; })())) out.push(o);
    return out;
  };
  it("yields the objects of the well-formed lines, in order", async () => {
    expect(await collect('{"a":1}', '{"b":2}')).toEqual([{ a: 1 }, { b: 2 }]);
  });
  it("tolerates the blank lines and the padding a line-buffered CLI leaves", async () => {
    expect(await collect('  {"a":1}\t', "", "   ")).toEqual([{ a: 1 }]);
  });
  it("skips a malformed line and keeps reading the rest", async () => {
    // A truncated line is what a CLI killed mid-write leaves behind: the run
    // must still be parsed from the lines that did arrive whole, instead of
    // dying on a SyntaxError the client would see as an internal error.
    expect(await collect('{"a":1}', '{"b":', '{"c":3}')).toEqual([{ a: 1 }, { c: 3 }]);
  });
  it("ignores stdout that is not a JSON object at all", async () => {
    // A CLI banner, a JSON array, a bare scalar: none of them is an event, and
    // none of them may end the stream.
    expect(await collect("Welcome to the CLI", "[1,2]", '"a string"', "null", '{"a":1}')).toEqual([{ a: 1 }]);
  });
});
