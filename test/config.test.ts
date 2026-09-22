import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { loadConfig, loadConfigWithOverlay, mergeConfig, parseConfig } from "../src/config.js";

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
  system_prompt_flag_prefix: "null",
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
    expect(cfg.providers.codex.system_prompt_flag).toBe("developer_instructions");
    expect(cfg.providers.codex.system_prompt_flag_prefix).toBe("-c");
    expect(cfg.providers.claude.system_prompt_flag_prefix).toBeNull();
    expect(cfg.providers.antigravity.system_prompt_flag_prefix).toBeNull();
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
  it("requires every provider to name the model, effort and system-prompt flags", () => {
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
    // Same rule for the flag that introduces the system prompt override: a
    // default of null would quietly drop Codex's "-c" and pass the override as
    // a bare argument, which is the drift the other three keys exist to stop.
    expect(() => parseConfig(config({ system_prompt_flag_prefix: null }))).toThrow(/providers\.x\.system_prompt_flag_prefix/);
    expect(() => parseConfig(config({ system_prompt_flag_prefix: '""' }))).toThrow(/providers\.x\.system_prompt_flag_prefix/);
    // And for the key it introduces: with `system_prompt_flag: ""` the adapter
    // builds `-c ="<text>"`, TOML the CLI cannot parse, so every run carrying
    // a system prompt dies on the client's own text.
    expect(() => parseConfig(config({ system_prompt_flag: '""' }))).toThrow(/providers\.x\.system_prompt_flag/);
    const p = parseConfig(config({ effort_flag: "-c", effort_key: "model_reasoning_effort", system_prompt_flag: "developer_instructions", system_prompt_flag_prefix: "-c" })).providers.x;
    expect([p.model_flag, p.effort_flag, p.effort_key, p.system_prompt_flag_prefix]).toEqual(["--model", "-c", "model_reasoning_effort", "-c"]);
  });
  it("refuses a system prompt prefix with no flag for it to introduce", () => {
    // The two keys are one setting: the prefix only ever introduces
    // `<system_prompt_flag>="<text>"`. With the flag null it names nothing, so
    // it would be dropped in silence and the system prompt would go back to
    // being prepended to the user prompt, while the file says it travels to
    // the CLI as a configuration override.
    expect(() => parseConfig(config({ system_prompt_flag: "null", system_prompt_flag_prefix: "-c" })))
      .toThrow(/providers\.x\.system_prompt_flag_prefix/);
    // The pair the other way round is how Claude is declared: a flag that
    // carries the text itself needs no prefix.
    const p = parseConfig(config({ system_prompt_flag: "--system-prompt", system_prompt_flag_prefix: "null" })).providers.x;
    expect([p.system_prompt_flag, p.system_prompt_flag_prefix]).toEqual(["--system-prompt", null]);
  });
  it("names Codex's override flag with one value everywhere it appears", () => {
    // `-c` is written three times in the codex block: inside `args` (the fixed
    // overrides), as `effort_flag` and as `system_prompt_flag_prefix`. They
    // are one flag of one CLI, so a rename reaching only some of them would
    // validate and build a mixed command line on the host, half `-c` and half
    // the new name. Pinned here so a partial rename fails in CI instead.
    for (const file of ["config/capitoline.yaml", "test/e2e.config.yaml"]) {
      const codex = loadConfig(file).providers.codex;
      // The `args` entries that introduce a key="value" override, by shape.
      const carriers = codex.args.filter((_, i) => /^[A-Za-z_][\w.]*=/.test(codex.args[i + 1] ?? ""));
      expect(carriers.length).toBeGreaterThan(0);
      expect([...new Set([...carriers, codex.effort_flag, codex.system_prompt_flag_prefix])]).toEqual(["-c"]);
    }
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

// The host overlay. /etc/capitoline/capitoline.yaml used to be a full
// hand-made copy of the repository file, and it drifted twice in one day: a
// required key added upstream reached the host only when someone retyped it,
// once through a restart loop. The base now arrives with the pull that changes
// it, and the host writes only what is genuinely local.
describe("mergeConfig", () => {
  it("merges objects key by key", () => {
    expect(mergeConfig({ a: { b: 1, c: 2 }, d: 3 }, { a: { c: 9 } })).toEqual({ a: { b: 1, c: 9 }, d: 3 });
  });
  it("replaces an array instead of appending to it", () => {
    // What a host that changes a flag needs: `args` is the whole command line,
    // and a concatenation would leave the base's flags in place next to the
    // ones meant to replace them.
    expect(mergeConfig({ a: ["x", "y"] }, { a: ["z"] })).toEqual({ a: ["z"] });
    expect(mergeConfig({ a: ["x"] }, { a: [] })).toEqual({ a: [] });
  });
  it("treats null as a value, not as a deletion", () => {
    // `effort_flag: null` and `runner.user: null` are declared values in this
    // schema, so an overlay must be able to set them.
    expect(mergeConfig({ a: "--effort" }, { a: null })).toEqual({ a: null });
  });
  it("lets a scalar in the overlay replace a whole object", () => {
    expect(mergeConfig({ a: { b: 1 } }, { a: "x" })).toEqual({ a: "x" });
    expect(mergeConfig({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });
  it("leaves the base untouched", () => {
    // The base is the parsed repository file; a merge that wrote into it would
    // make a second load return something else than the first.
    const base = { a: { b: 1 } };
    expect(mergeConfig(base, { a: { b: 2 } })).toEqual({ a: { b: 2 } });
    expect(base).toEqual({ a: { b: 1 } });
  });
  it("does not let a key named __proto__ reach the prototype", () => {
    // The overlay is a file on the host, parsed before the schema sees it: a
    // plain assignment would run the setter and change every object in the
    // process instead of adding a key the strict schema would reject by name.
    const merged = mergeConfig({}, JSON.parse('{"__proto__": {"polluted": true}}')) as Record<string, unknown>;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
  });
});

describe("loadConfig with a host overlay", () => {
  /** An overlay written to a directory of its own; returns its path. */
  function overlayFile(text: string): string {
    const path = join(mkdtempSync(join(tmpdir(), "capitoline-overlay-")), "overlay.yaml");
    writeFileSync(path, text);
    return path;
  }
  const REPO = "config/capitoline.yaml";

  it("behaves exactly as today when no overlay is passed", () => {
    // The deployed service runs a full hand-made copy until its runbook step is
    // applied by hand, so the single-file path must stay untouched.
    const asToday = parseConfig(readFileSync(REPO, "utf8"));
    expect(loadConfig(REPO)).toEqual(asToday);
    expect(loadConfig(REPO, undefined)).toEqual(asToday);
    expect(loadConfigWithOverlay(REPO).overlayKeys).toEqual([]);
  });

  it("changes one binary and leaves the rest of the provider intact", () => {
    const repo = loadConfig(REPO);
    const cfg = loadConfig(REPO, overlayFile("providers:\n  claude:\n    binary: /home/runner/.npm-global/bin/claude\n"));
    expect(cfg.providers.claude.binary).toBe("/home/runner/.npm-global/bin/claude");
    // Everything else of that provider, and the other two providers whole.
    expect({ ...cfg.providers.claude, binary: repo.providers.claude.binary }).toEqual(repo.providers.claude);
    expect(cfg.providers.codex).toEqual(repo.providers.codex);
    expect(cfg.providers.antigravity).toEqual(repo.providers.antigravity);
    expect({ ...cfg, providers: repo.providers }).toEqual(repo);
  });

  it("replaces an array rather than appending to it", () => {
    const cfg = loadConfig(REPO, overlayFile("providers:\n  claude:\n    args: [-p, --settings, /home/runner/.claude/capitoline.json]\n"));
    expect(cfg.providers.claude.args).toEqual(["-p", "--settings", "/home/runner/.claude/capitoline.json"]);
    expect(cfg.providers.claude.args).not.toContain("--verbose");
  });

  it("keeps a null the overlay sets", () => {
    const cfg = loadConfig(REPO, overlayFile("runner:\n  user: null\nproviders:\n  claude:\n    effort_flag: null\n"));
    expect(cfg.runner.user).toBeNull();
    expect(loadConfig(REPO).providers.claude.effort_flag).toBe("--effort");
    expect(cfg.providers.claude.effort_flag).toBeNull();
  });

  it("rejects an unknown key the overlay adds, naming the overlay", () => {
    // The whole point of the strict schema, now applied to the file the host
    // actually edits: `usr` for `user` would run the CLIs as the gateway's own
    // user. The message names both files, because the key is in only one.
    const path = overlayFile("runner:\n  usr: nobody\n");
    expect(() => loadConfig(REPO, path)).toThrow(/runner: Unrecognized key\(s\) in object: 'usr'/);
    expect(() => loadConfig(REPO, path)).toThrow(path);
    expect(() => loadConfig(REPO, path)).toThrow(REPO);
    // With no overlay the message is the one the runbook quotes, unchanged.
    expect(() => parseConfig("providers: {}\nrunner: { sandbox_root: /tmp/x }\n")).toThrow(/^invalid configuration:\n/);
  });

  it("names the overlay when it is empty or is not a mapping", () => {
    // The realistic case is an operator who creates /etc/capitoline/overlay.yaml
    // and fills it afterwards, or a write cut short. A non-object replaces the
    // base by the merge rules, so without this the message is the schema's
    // `expected object, received null` with no key and no file in it.
    const empty = overlayFile("");
    expect(() => loadConfig(REPO, empty)).toThrow(`the configuration overlay ${empty} is empty`);
    const comments = overlayFile("# written later\n");
    expect(() => loadConfig(REPO, comments)).toThrow(/is empty/);
    const list = overlayFile("- runner\n");
    expect(() => loadConfig(REPO, list)).toThrow(`the configuration overlay ${list} must be a mapping of configuration keys`);
  });

  it("raises when the overlay file is not there", () => {
    // Naming a file that does not exist is a mistake, not a request to skip it:
    // a silent skip would start the gateway with the repository's own paths,
    // sandboxes and database, as the wrong user.
    const absent = join(mkdtempSync(join(tmpdir(), "capitoline-overlay-")), "absent.yaml");
    expect(() => loadConfig(REPO, absent)).toThrow(absent);
    expect(() => loadConfig(REPO, absent)).toThrow(/overlay/);
  });
});

// The overlay the host writes, kept honest the same way test/e2e.config.yaml
// is: it is the template docs/deploy.md §7 points at, so a key added to it by
// mistake, or a host difference dropped from it, fails here.
describe("config/overlay.example.yaml", () => {
  const EXAMPLE = "config/overlay.example.yaml";
  // Exactly the host-specific keys, and nothing else: anything else belongs to
  // the repository file and must arrive with the pull that changes it.
  const HOST_KEYS = [
    "providers.antigravity.binary",
    "providers.antigravity.image.collect",
    "providers.claude.args",              // the whole list: arrays replace, and the host's carries --settings
    "providers.claude.binary",
    "providers.codex.binary",
    "runner.sandbox_root",
    "runner.user",
    "server.access.audience",
    "server.access.team_domain",
    "usage.db_path",
  ];

  it("sets exactly the host-specific keys", () => {
    const { overlayKeys } = loadConfigWithOverlay("config/capitoline.yaml", EXAMPLE);
    expect([...overlayKeys].sort()).toEqual(HOST_KEYS);
    // Paths, never values: this is what the startup log prints, and the log
    // must not grow the habit of carrying the file's contents.
    for (const k of overlayKeys) expect(k).toMatch(/^[A-Za-z_][\w.-]*$/);
  });

  it("merges over the repository configuration into the host's own", () => {
    const cfg = loadConfig("config/capitoline.yaml", EXAMPLE);
    expect(cfg.runner.user).toBe("runner");
    expect(cfg.runner.sandbox_root).toBe("/var/lib/capitoline/sandboxes");
    expect(cfg.usage.db_path).toBe("/var/lib/capitoline/usage.sqlite");
    expect(cfg.providers.claude.binary).toBe("/home/runner/.npm-global/bin/claude");
    expect(cfg.providers.codex.binary).toBe("/home/runner/.npm-global/bin/codex");
    expect(cfg.providers.antigravity.binary).toBe("/home/runner/.local/bin/agy");
    expect(cfg.providers.antigravity.image.collect).toEqual(["/usr/local/bin/capitoline-collect-image"]);
    // Access is filled in §9 of the runbook; both empty is the disabled pair.
    expect(cfg.server.access).toEqual({ team_domain: "", audience: "" });
    // The replaced list is the repository's plus the host's token file, and it
    // must still be a complete command line: nothing is appended for it.
    const repo = loadConfig("config/capitoline.yaml").providers.claude.args;
    expect(cfg.providers.claude.args).toEqual([...repo, "--settings", "/home/runner/.claude/capitoline.json"]);
  });
});
