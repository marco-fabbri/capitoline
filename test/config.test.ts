import { describe, it, expect } from "vitest";
import { loadConfig, parseConfig } from "../src/config.js";

// Every inline configuration below is built from these two helpers. The
// provider block must carry all the keys the schema requires, so a key added
// to the schema is added here once instead of in every literal, and a test
// that forgets one fails for its own reason rather than for a missing key.
// Values are YAML text: `over` varies what a test is about, a null drops the
// key entirely, and an unrecognized name injects an unknown key.
type Fields = Record<string, string | null>;

const PROVIDER: Fields = {
  binary: "x",
  concurrency: "1",
  timeout_s: "1",
  budget: "{window_5h_tokens: 0, window_7d_tokens: 0}",
  health_model: "a",
  models: "{ a: {cli_model: a} }",
  effort: "{}",
  model_flag: "--model",
  effort_flag: "null",
  effort_key: "null",
  args: "[]",
  system_prompt_flag: "null",
  prompt_via: "stdin",
};

const provider = (over: Fields = {}): string => {
  const fields = Object.entries({ ...PROVIDER, ...over }).filter(([, v]) => v !== null);
  return `{ ${fields.map(([k, v]) => `${k}: ${v}`).join(", ")} }`;
};

const configOf = (providers: Record<string, Fields>, runner = "{ sandbox_root: /tmp/x }"): string =>
  `providers:\n${Object.entries(providers).map(([id, o]) => `  ${id}: ${provider(o)}`).join("\n")}\nrunner: ${runner}\n`;

const config = (over: Fields = {}, runner?: string): string => configOf({ x: over }, runner);

describe("config", () => {
  it("loads the repository config", () => {
    const cfg = loadConfig("config/capitoline.yaml");
    expect(Object.keys(cfg.providers).sort()).toEqual(["antigravity", "claude", "codex"]);
    expect(cfg.providers.claude.models["claude-opus"].cli_model).toBe("opus");
    expect(cfg.providers.antigravity.models["agy-gemini-flash"].effort_suffix).toBe(true);
    expect(cfg.server.port).toBe(8080);
    expect(cfg.usage.db_path).toBe("capitoline.sqlite");
  });
  it("loads the repository config with the agy-image model and the collect helper", () => {
    const cfg = loadConfig("config/capitoline.yaml");
    const agy = cfg.providers.antigravity;
    expect(agy.models["agy-image"]).toEqual({ cli_model: "gemini-3.8-flash-low", effort_suffix: false, kind: "image", timeout_s: 240 });
    expect(agy.models["agy-gemini-3.7-flash"].cli_model).toBe("gemini-3.7-flash");
    expect(agy.models["agy-gemini-3.6-flash"].cli_model).toBe("gemini-3.6-flash");
    expect(agy.image.collect).toEqual(["/usr/local/bin/capitoline-collect-image"]);
    expect(agy.image.min_bytes).toBe(200000);
    expect(agy.image.quota_per_window).toBe(12);
    expect(agy.image.allowed_tools).toEqual(["generate_image"]);
    expect(agy.image.args).toEqual([]);
    expect(cfg.providers.claude.image).toEqual({ args: [], allowed_tools: ["generate_image"], collect: undefined, min_bytes: 200000 });
  });
  it("requires every provider to name the model and effort flags", () => {
    // No defaults on purpose: a file written before these keys existed — the
    // hand-edited copy in /etc on the host — must fail `npm run check-config`
    // naming the missing key, instead of inheriting a default and building a
    // different command line than the verified one.
    expect(() => parseConfig(config({ model_flag: null }))).toThrow(/providers\.x\.model_flag/);
    expect(() => parseConfig(config({ effort_flag: null }))).toThrow(/providers\.x\.effort_flag/);
    expect(() => parseConfig(config({ effort_key: null }))).toThrow(/providers\.x\.effort_key/);
    // A pre-B1 provider block is missing all three at once, and is told so.
    const before = config({ model_flag: null, effort_flag: null, effort_key: null });
    expect(() => parseConfig(before)).toThrow(/model_flag[\s\S]*effort_flag[\s\S]*effort_key/);
    // An empty flag would reach the CLI as an empty argument.
    expect(() => parseConfig(config({ model_flag: '""' }))).toThrow(/providers\.x\.model_flag/);
    expect(() => parseConfig(config({ effort_flag: '""' }))).toThrow(/providers\.x\.effort_flag/);
    const p = parseConfig(config({ effort_flag: "-c", effort_key: "model_reasoning_effort" })).providers.x;
    expect([p.model_flag, p.effort_flag, p.effort_key]).toEqual(["--model", "-c", "model_reasoning_effort"]);
  });
  it("defaults a model's kind to text with no per-model timeout", () => {
    const m = parseConfig(config()).providers.x.models.a;
    expect(m.kind).toBe("text");
    expect(m.timeout_s).toBeUndefined();
  });
  it("accepts an image model with its own timeout when the provider can collect images", () => {
    const p = parseConfig(config({
      models: "{ a: {cli_model: a}, img: {cli_model: i, kind: image, timeout_s: 240} }",
      image: "{ collect: [/usr/local/bin/collect, --flag], min_bytes: 10, args: [--x], allowed_tools: [generate_image, other] }",
    })).providers.x;
    expect(p.models.img).toEqual({ cli_model: "i", effort_suffix: false, kind: "image", timeout_s: 240 });
    expect(p.models.a.kind).toBe("text");
    expect(p.image).toEqual({ collect: ["/usr/local/bin/collect", "--flag"], min_bytes: 10, args: ["--x"], allowed_tools: ["generate_image", "other"] });
  });
  it("rejects an unknown model kind and a non-positive timeout", () => {
    const base = (models: string) => config({ models: `{ ${models} }`, image: "{ collect: [c] }" });
    expect(() => parseConfig(base("a: {cli_model: a, kind: video}"))).toThrow(/models\.a\.kind/);
    expect(() => parseConfig(base("a: {cli_model: a, timeout_s: 0}"))).toThrow(/models\.a\.timeout_s/);
  });
  it("rejects a health_model that is an image model", () => {
    const text = config({
      health_model: "img",
      models: "{ a: {cli_model: a}, img: {cli_model: i, kind: image} }",
      image: "{ collect: [c] }",
    });
    expect(() => parseConfig(text)).toThrow(/health_model "img" must be a text model/);
  });
  it("rejects an image model when the provider has no image.collect command", () => {
    const models = "{ a: {cli_model: a}, img: {cli_model: i, kind: image} }";
    expect(() => parseConfig(config({ models }))).toThrow(/providers\.x\.image\.collect: .*image models.*image\.collect/);
    expect(() => parseConfig(config({ models, image: "{ collect: [] }" }))).toThrow(/image\.collect/);
  });
  it("rejects a health_model that is not one of the provider's models", () => {
    expect(() => parseConfig(config({ health_model: "nope" }))).toThrow(/health_model/);
  });
  it("rejects the same public model name in two providers", () => {
    expect(() => parseConfig(configOf({ x: {}, y: { binary: "y" } }))).toThrow(/duplicate model name "a"/);
  });
  it("rejects reserved council names", () => {
    const text = config({ health_model: "capitoline", models: "{ capitoline: {cli_model: a} }" });
    expect(() => parseConfig(text)).toThrow(/reserved/);
  });
  it("rejects server.access with only one of team_domain and audience", () => {
    const base = config();
    expect(() => parseConfig(`server: { access: { team_domain: t.cloudflareaccess.com } }\n${base}`)).toThrow(/server\.access\.audience/);
    expect(() => parseConfig(`server: { access: { audience: abc } }\n${base}`)).toThrow(/server\.access\.team_domain/);
    expect(parseConfig(`server: { access: { team_domain: t.cloudflareaccess.com, audience: abc } }\n${base}`).server.access.audience).toBe("abc");
    expect(parseConfig(base).server.access).toEqual({ team_domain: "", audience: "" });
  });

  it("rejects an unknown key in any of the objects", () => {
    const base = config();
    // The one with teeth: `usr` for `user` used to be dropped silently, which
    // runs the CLIs as the gateway's own user with no privilege separation.
    expect(() => parseConfig(config({}, "{ sandbox_root: /tmp/x, usr: runner }")))
      .toThrow(/runner: Unrecognized key\(s\) in object: 'usr'/);
    // A wrong value, not a wrong key: `.strict()` cannot see it, and an empty
    // user takes the same no-sudo branch as null, silently.
    expect(() => parseConfig(config({}, '{ sandbox_root: /tmp/x, user: "" }')))
      .toThrow(/runner\.user/);
    expect(() => parseConfig(config({ models: "{ a: {cli_model: a, effort_sufix: true} }" })))
      .toThrow(/providers\.x\.models\.a: Unrecognized key\(s\) in object: 'effort_sufix'/);
    expect(() => parseConfig(config({ timeouts_s: "1" })))
      .toThrow(/providers\.x: Unrecognized key\(s\) in object: 'timeouts_s'/);
    expect(() => parseConfig(config({ model_flags: "--model" })))
      .toThrow(/providers\.x: Unrecognized key\(s\) in object: 'model_flags'/);
    expect(() => parseConfig(config({ budget: "{window_5h_tokens: 0, window_7d_tokens: 0, window_30d_tokens: 0}" })))
      .toThrow(/providers\.x\.budget: Unrecognized key\(s\) in object: 'window_30d_tokens'/);
    expect(() => parseConfig(config({ image: "{ collect: [c], min_byte: 1 }" })))
      .toThrow(/providers\.x\.image: Unrecognized key\(s\) in object: 'min_byte'/);
    expect(() => parseConfig(`server: { prt: 9 }\n${base}`)).toThrow(/server: Unrecognized key\(s\) in object: 'prt'/);
    expect(() => parseConfig(`server: { access: { team_domain: t, audience: a, extra: 1 } }\n${base}`))
      .toThrow(/server\.access: Unrecognized key\(s\) in object: 'extra'/);
    expect(() => parseConfig(`server: { queue: { max_wait_s: 1, min_wait_s: 1 } }\n${base}`))
      .toThrow(/server\.queue: Unrecognized key\(s\) in object: 'min_wait_s'/);
    expect(() => parseConfig(`usage: { db_path: x, dbpath: y }\n${base}`))
      .toThrow(/usage: Unrecognized key\(s\) in object: 'dbpath'/);
    expect(() => parseConfig(`usag: {}\n${base}`)).toThrow(/: Unrecognized key\(s\) in object: 'usag'/);
  });
  it("rejects a health_model that is only an Object.prototype key", () => {
    expect(() => parseConfig(config({ health_model: "toString" })))
      .toThrow(/health_model "toString" is not one of provider x's models/);
  });
  it("rejects an empty providers map", () => {
    expect(() => parseConfig(`providers: {}\nrunner: { sandbox_root: /tmp/x }\n`)).toThrow(/providers: .*at least one provider/);
  });
  it("rejects a model effort the provider's effort table does not define", () => {
    const models = "{ a: {cli_model: a, efforts: [low, high]} }";
    expect(() => parseConfig(config({ models, effort: "{ low: low }" })))
      .toThrow(/providers\.x\.models\.a\.efforts: .*"high".*effort table/);
    expect(() => parseConfig(config({ models, effort: "{ low: low, high: high }" }))).not.toThrow();
    // An empty value is the same silent drop one level down: `--effort ""`.
    expect(() => parseConfig(config({ models, effort: '{ low: "", high: high }' })))
      .toThrow(/providers\.x\.effort\.low/);
  });
  it("rejects a model that needs an effort value against an empty effort table", () => {
    const text = (model: string) => config({ models: `{ a: ${model} }`, effort: "{}" });
    // effort_suffix with nothing to append leaves the CLI with a base model id
    // that, for Antigravity, is not a model id at all.
    expect(() => parseConfig(text("{cli_model: a, effort_suffix: true}")))
      .toThrow(/providers\.x\.effort: .*"a" needs an effort value.*effort table is empty/);
    expect(() => parseConfig(text("{cli_model: a, efforts: [low]}")))
      .toThrow(/effort table is empty/);
    expect(() => parseConfig(text("{cli_model: a}"))).not.toThrow();
  });
  it("rejects every reserved capitoline* model name", () => {
    const text = (name: string) => config({ health_model: name, models: `{ ${name}: {cli_model: a} }` });
    expect(() => parseConfig(text("capitolineX"))).toThrow(/reserved/);
    expect(() => parseConfig(text("capitoline-council"))).toThrow(/reserved/);
    expect(() => parseConfig(text("capitol"))).not.toThrow();
  });
});

// test/e2e.config.yaml is a hand-copied duplicate of config/capitoline.yaml,
// and nothing kept the copy honest: a key added to the repository file and
// forgotten in the test one leaves the end-to-end suite exercising a different
// gateway than the deployed host runs, which is the one thing that file exists
// to prevent. This compares the two as the schema parses them (so comments and
// key order do not count) and allows exactly the differences the copy is for.
describe("the end-to-end configuration tracks the repository one", () => {
  // Everything that must differ, and nothing else. Adding a line here is a
  // decision: it says this key is deliberately not the same on a developer
  // machine as on the host.
  const INTENDED = [
    "providers.antigravity.binary",              // the fake CLIs replay fixtures
    "providers.antigravity.image.collect",       //   and so does the collect helper
    "providers.antigravity.timeout_s",           // seconds, not minutes, so a hung fake fails fast
    "providers.claude.binary",
    "providers.claude.timeout_s",
    "providers.codex.binary",
    "providers.codex.timeout_s",
    "runner.sandbox_root",                       // under the repository, git-ignored
    "runner.user",                               // null: no sudo on a developer machine
    "server.port",                               // 0: the OS picks a free one
    "usage.db_path",                             // in memory: the suite leaves no database behind
  ];

  const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  /** The dotted paths at which the two differ, arrays compared as whole values. */
  function differences(a: unknown, b: unknown, path = ""): string[] {
    if (isPlain(a) && isPlain(b)) {
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
      return keys.flatMap((k) => differences(a[k], b[k], path ? `${path}.${k}` : k));
    }
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null) ? [] : [path];
  }

  const repo = loadConfig("config/capitoline.yaml");
  const e2e = loadConfig("test/e2e.config.yaml");

  it("differs from it in the intended keys and in no others", () => {
    expect(differences(repo, e2e).sort()).toEqual(INTENDED);
  });

  it("differs in them for the intended reasons", () => {
    // Otherwise the test above would pass just as well with the two files
    // aligned on the wrong side: a real binary in the e2e copy, a fake one in
    // the deployed config.
    expect(e2e.server.port).toBe(0);
    expect(e2e.runner.user).toBeNull();
    expect(repo.runner.user).toBe("runner");
    expect(e2e.runner.sandbox_root).toBe("tmp/capitoline-e2e");
    expect(e2e.usage.db_path).toBe(":memory:");
    for (const [id, p] of Object.entries(e2e.providers)) {
      expect(p.binary, id).toMatch(/^test\/fake-cli\//);
      expect(p.timeout_s, id).toBeLessThanOrEqual(30);
      expect(repo.providers[id].timeout_s, id).toBeGreaterThanOrEqual(600);
    }
    expect(e2e.providers.antigravity.image.collect).toEqual(["test/fake-cli/fake-collect-image.sh"]);
    expect(repo.providers.antigravity.image.collect).toEqual(["/usr/local/bin/capitoline-collect-image"]);
  });
});
