import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { loadConfig, loadConfigWithOverlay, mergeConfig, parseConfig, type Effort } from "../src/config.js";

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

// A council over the inline provider, built the same way. The provider gets
// three models, one per seat: the smallest panel the schema accepts is two
// seats, and no two seats may name the same model, so a three-seat council
// needs a third. It also gets three concurrency slots, because every seat of
// an inline council is served by that one provider and the schema demands a
// slot per seat (design §12.1); the test about that rule sets its own.
// `prov` varies the provider block for the few tests that are about what a
// seat names rather than about the council's own keys.
const MODELS = "{ a: {cli_model: a}, b: {cli_model: b}, c: {cli_model: c} }";
const COUNCIL: Fields = {
  seats: "[{family: f1, models: [a]}, {family: f2, models: [b]}]",
  judge: "{family: f1, models: [a]}",
};
const block = (over: Fields): string => {
  const fields = Object.entries({ ...COUNCIL, ...over }).filter(([, v]) => v !== null);
  return `{ ${fields.map(([k, v]) => `${k}: ${v}`).join(", ")} }`;
};
// Several councils over that same provider, which is what the concurrency rule
// is counted over: the slots belong to the subscription, not to one council.
const councils = (entries: Record<string, Fields>, prov: Fields = {}): string =>
  `council:\n${Object.entries(entries).map(([name, over]) => `  ${name}: ${block(over)}`).join("\n")}\n${config({ models: MODELS, concurrency: "3", ...prov })}`;
const council = (over: Fields = {}, name = "capitoline", prov: Fields = {}): string => councils({ [name]: over }, prov);

const BOTH_FILES = ["config/capitoline.yaml", "test/e2e.config.yaml"];

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

  it("rejects a provider id in the council's namespace", () => {
    // A virtual model is listed with `provider: "capitoline"`, so a provider
    // carrying that id would stand on /health beside model entries claiming
    // the same owner, its pause and its health indistinguishable from the
    // council's own — which has neither.
    expect(() => parseConfig(configOf({ capitoline: {} }))).toThrow(/reserved/);
    expect(() => parseConfig(configOf({ "capitoline-2": {} }))).toThrow(/reserved/);
    expect(() => parseConfig(configOf({ capitol: {} }))).not.toThrow();
  });

  it("loads the council of both configuration files", () => {
    for (const file of BOTH_FILES) {
      const cfg = loadConfig(file);
      expect(Object.keys(cfg.council), file).toEqual(["capitoline", "capitoline-fast", "capitoline-gemini"]);
      const c = cfg.council.capitoline;
      // One seat per family, and no family twice — a rule the schema enforces
      // ("rejects two seats of the same family"), because models of one
      // lineage share their blind spots and two seats of one family would be
      // one opinion voting twice (design §12.2).
      expect(c.seats.map((s) => s.family), file).toEqual(["anthropic", "openai", "google", "open-weights"]);
      expect(c.seats[0].models, file).toEqual(["claude-fable", "claude-opus", "claude-sonnet"]);
      expect(c.seats[3].models, file).toEqual(["agy-gpt-oss"]);
      // The chain is the top model of each family, in descending order: the
      // judge writes the answer the client reads, so it is the one seat where
      // economising is false economy — measured on 2026-09-22, when a cheap
      // judge merged three answers and shipped a claim none of them made.
      // When the chain empties the design already degrades honestly (§12.5,
      // the best-ranked answer returned unsynthesised), which is a better
      // floor than a weak synthesis, so no cheap model closes it.
      expect(c.judge, file).toEqual({ family: "best-available", models: ["claude-fable", "claude-opus", "codex-gpt-6-astra", "agy-gemini-pro", "codex-gpt-5.6-sol"] });
      // Every model of this chain is also a seat candidate somewhere, and that
      // is deliberate. seatJudge() filters the chain against the models the
      // members actually took, not against every candidate, and four seats can
      // take at most four of the five — so filtering alone always leaves one.
      // Filtering plus refusals can still empty it, and that is accepted: when
      // no judge can be seated the council returns the best-ranked answer
      // unsynthesised and says so (§12.5), which is a better floor than the
      // weak synthesis a cheap tail model would produce. Measured on
      // 2026-09-22: a cheap judge shipped a claim none of the members made.
      const seatedModels = new Set(c.seats.flatMap((s) => s.models));
      const takeable = c.seats.length;
      expect(c.judge.models.length, `${file}: the chain must outnumber the seats, or filtering alone could empty it`).toBeGreaterThan(takeable);
      expect(c.judge.models.every((m) => typeof m === "string" && m.length > 0), file).toBe(true);
      expect(seatedModels.size, file).toBeGreaterThan(0);
      // Every provider must offer a slot per seat it serves, or the second
      // member of that provider waits on the queue and loses its seat: the
      // default seats put google and open-weights on antigravity (design §12.1).
      expect(cfg.providers.antigravity.concurrency, file).toBeGreaterThanOrEqual(2);
      // The snake_case the operator writes, under the names the code uses.
      expect([c.judgeAllowMember, c.judgeBlind, c.minMembers], file).toEqual([false, true, 2]);
      // Minutes on the host, seconds in the end-to-end copy: from the moment
      // stage_timeout_s becomes a member's deadline, a test that never reaches
      // the process would otherwise hold the suite for five minutes.
      expect(c.stageTimeoutS, file).toBe(file === "config/capitoline.yaml" ? 300 : 20);
      // Every seated model is a model of some provider, and no seat is empty.
      const declared = Object.values(cfg.providers).flatMap((p) => Object.keys(p.models));
      for (const s of [...c.seats, c.judge]) {
        expect(s.models.length, `${file} ${s.family}`).toBeGreaterThan(0);
        for (const m of s.models) expect(declared, `${file} ${s.family}`).toContain(m);
      }
    }
  });

  it("ships capitoline-fast as the reference panel without its ranking stage", () => {
    for (const file of BOTH_FILES) {
      const cfg = loadConfig(file);
      const full = cfg.council.capitoline;
      const fast = cfg.council["capitoline-fast"];
      expect(full.ranking, file).toBe(true);
      expect(fast.ranking, file).toBe(false);
      // The same four families, the same chains and the same judge: the shape
      // word after `capitoline-` says how it deliberates, not who sits (the
      // naming rule of design §12.8). Five calls instead of nine is the whole
      // difference, so anything else diverging here is a drift between the
      // two, not a decision.
      expect(fast.seats, file).toEqual(full.seats);
      expect(fast.judge, file).toEqual(full.judge);
      expect([fast.judgeAllowMember, fast.judgeBlind, fast.minMembers], file).toEqual([false, true, 2]);
      expect(fast.stageTimeoutS, file).toBe(full.stageTimeoutS);
      // Two councils on one Antigravity subscription, each seating it twice:
      // the rule is per council, so the two slots the reference panel needs
      // are the two this one needs (task 1 of the variants plan).
      expect(cfg.providers.antigravity.concurrency, file).toBeGreaterThanOrEqual(2);
    }
  });

  it("ships capitoline-gemini as one capability ladder on Antigravity", () => {
    for (const file of BOTH_FILES) {
      const cfg = loadConfig(file);
      const ladder = cfg.council["capitoline-gemini"];
      // Three rungs of one lineage, best first: the big model, the small one
      // trying, the small one not trying. `-gemini` is a family name and not a
      // shape word (design §12.8), so the shape is the reference panel's —
      // here the blind ranking is the measurement itself, since what the
      // instrument asks is whether the cheap rung's answer is judged as good
      // as the expensive one's.
      expect(ladder.ranking, file).toBe(true);
      // One model per seat and no chain: a rung that steps down to another
      // model stops being the rung it was declared to measure.
      expect(ladder.seats.map((s) => s.models), file).toEqual([["agy-gemini-pro-high"], ["agy-gemini-flash-high"], ["agy-gemini-flash-low"]]);
      // The reasoning level is part of the model id and not a request-time
      // choice, which is what makes a seat a rung: effort_suffix is off, so
      // the id reaches the CLI exactly as written here.
      const agy = cfg.providers.antigravity;
      for (const [name, cli] of [["agy-gemini-pro-high", "gemini-3.1-pro-high"], ["agy-gemini-flash-high", "gemini-3.8-flash-high"], ["agy-gemini-flash-low", "gemini-3.8-flash-low"]]) {
        expect(agy.models[name], `${file} ${name}`).toMatchObject({ cli_model: cli, effort_suffix: false, kind: "text" });
      }
      // The judge is neither a rung nor Gemini at all: the ladder under test
      // must not synthesize its own measurement. claude-haiku is the cheapest
      // model of another family, and agy-claude-sonnet stands behind it for
      // the reason every chain exists — the refusal that is not in the state
      // yet. A rung already known paused is simply not seated and the
      // deliberation degrades honestly, but a first refusal at the judge with
      // an empty chain ends six spent calls in an error (design §12.2).
      // The chain opens on OpenAI and not on Anthropic, unlike the panels':
      // this ladder was put on Gemini to spare the Anthropic window, and a
      // Claude judge would spend it back on one call in seven. No Gemini
      // anywhere in the chain — the ladder must not synthesize its own
      // measurement.
      expect(ladder.judge, file).toEqual({ family: "best-available", models: ["codex-gpt-6-astra", "claude-fable", "claude-opus", "codex-gpt-5.6-sol"] });
      // Every rung or nothing: a ladder missing one has nothing to compare the
      // cheap rungs against, so the quorum is the whole panel and a lost rung
      // makes the instrument refuse instead of spending five uninterpretable
      // calls. The schema allows min_members == seats.length; only more is
      // rejected.
      expect([ladder.judgeAllowMember, ladder.judgeBlind, ladder.minMembers], file).toEqual([false, true, 3]);
      expect(ladder.minMembers, file).toBe(ladder.seats.length);
      // judge_allow_member is false, so no model of the judge's chain may be a
      // seat of THIS council — seatJudge() filters the chain against the models
      // of the deliberation it is seating (src/council/council.ts), and a chain
      // whose every entry is a rung would leave nothing to seat. Being a member
      // of another council is irrelevant: that is a different deliberation, and
      // claude-opus heads this chain while also sitting in the reference
      // panel's Anthropic seat.
      const seatedHere = new Set(ladder.seats.flatMap((s) => s.models));
      for (const m of ladder.judge.models) expect(seatedHere.has(m), `${file} ${m}`).toBe(false);
      expect(ladder.stageTimeoutS, file).toBe(cfg.council.capitoline.stageTimeoutS);
    }
  });

  it("gives every provider a slot for the largest council it is seated in", () => {
    for (const file of BOTH_FILES) {
      const cfg = loadConfig(file);
      // The rule of task 1, recomputed here over the shipped file: per
      // council, over the largest council each provider is seated in, and
      // deliberately not summed across them — the sum would ask one
      // Antigravity subscription for seven parallel `agy` processes and reject
      // this very configuration at startup, under Restart=always.
      const providerOf = new Map(Object.entries(cfg.providers).flatMap(([id, p]) => Object.keys(p.models).map((m) => [m, id] as const)));
      const largest = new Map<string, number>();
      for (const c of Object.values(cfg.council)) {
        const per = new Map<string, number>();
        for (const s of c.seats) {
          for (const pid of new Set(s.models.map((m) => providerOf.get(m)))) if (pid) per.set(pid, (per.get(pid) ?? 0) + 1);
        }
        for (const [pid, n] of per) largest.set(pid, Math.max(largest.get(pid) ?? 0, n));
      }
      // Three rungs on one subscription is the largest Antigravity seating of
      // the three councils — the reference panel and the fast one seat it
      // twice each — so `concurrency: 3` is the whole change the ladder costs
      // and no other provider moves.
      expect(largest.get("antigravity"), file).toBe(3);
      expect(cfg.providers.antigravity.concurrency, file).toBe(3);
      expect(cfg.providers.claude.concurrency, file).toBe(2);
      expect(cfg.providers.codex.concurrency, file).toBe(1);
      for (const [pid, seats] of largest) expect(cfg.providers[pid].concurrency, `${file} ${pid}`).toBeGreaterThanOrEqual(seats);
    }
  });

  // Every provider's committed list of what its CLI serves, and how to read the
  // ids out of it. Until now only Antigravity had one, so a typo in a Claude
  // alias or a Codex slug surfaced at the first call and nowhere earlier.
  const CLI_LISTS: Record<string, { file: string; ids: (text: string) => string[] }> = {
    // `agy models`, tab separated: id, display name.
    antigravity: { file: "test/fixtures/antigravity/models.txt", ids: (t) => t.split("\n").map((l) => l.split("\t")[0]).filter((x) => x && !x.startsWith("#")) },
    // The CLI's own model cache, dumped on the host: slug, display name, default level, levels.
    codex: { file: "test/fixtures/codex/models.txt", ids: (t) => t.split("\n").map((l) => l.split("\t")[0]).filter((x) => x && !x.startsWith("#")) },
    // A real `/model` capture: the aliases are the comma-separated tail of the
    // usage line, with `or a full model ID` dropped. The brackets of
    // `sonnet[1m]` are part of the alias.
    claude: {
      file: "test/fixtures/claude/slash-model.json",
      ids: (t) => {
        const result = (JSON.parse(t) as { result: string }).result;
        const tail = /Available: (.+?)(?:, or a full model ID)?\.?$/m.exec(result);
        expect(tail, "the /model capture no longer lists the aliases").not.toBeNull();
        return tail![1].split(",").map((x) => x.trim()).filter(Boolean);
      },
    },
  };

  it("exposes only model ids the CLIs actually serve, for every provider", () => {
    // A `cli_model` is the one value nothing else can check: the schema takes
    // any non-empty string, and a wrong one costs a real call to discover.
    for (const file of BOTH_FILES) {
      const cfg = loadConfig(file);
      for (const [pid, list] of Object.entries(CLI_LISTS)) {
        const p = cfg.providers[pid];
        expect(p, `${file} ${pid}`).toBeDefined();
        const listed = list.ids(readFileSync(list.file, "utf8"));
        expect(listed.length, list.file).toBeGreaterThan(0);
        for (const [name, m] of Object.entries(p.models)) {
          // The same two steps effortValue() takes (src/providers/adapter.ts):
          // an effort the provider's table does not define is dropped, and the
          // id carries the table's *value*, not the key.
          const efforts = m.effort_suffix ? (m.efforts ?? (Object.keys(p.effort) as Effort[])).filter((e) => Object.hasOwn(p.effort, e)) : [];
          if (efforts.length === 0) expect(listed, `${file} ${name}`).toContain(m.cli_model);
          for (const e of efforts) expect(listed, `${file} ${name} @ ${e}`).toContain(`${m.cli_model}-${p.effort[e]}`);
        }
      }
    }
  });

  it("declares, for every Codex model, only the reasoning levels its cache prices", () => {
    // The cache carries the levels per model — `gpt-5.5` stops at xhigh where
    // `gpt-6-astra` goes to ultra — and the provider's table prices the union.
    // A model left open to the whole table would be sent a level the CLI
    // refuses, which is the same failure the Antigravity suffix check catches
    // and arrives by a different road.
    const cache = new Map(readFileSync("test/fixtures/codex/models.txt", "utf8").split("\n")
      .filter((l) => l && !l.startsWith("#")).map((l) => { const c = l.split("\t"); return [c[0], new Set(c[3].split(","))]; }));
    for (const file of BOTH_FILES) {
      const p = loadConfig(file).providers.codex;
      const priced = Object.keys(p.effort) as Effort[];
      for (const [name, m] of Object.entries(p.models)) {
        const served = cache.get(m.cli_model);
        expect(served, `${file} ${name}: ${m.cli_model} is not in the cache`).toBeDefined();
        for (const e of m.efforts ?? priced) {
          expect([...served!], `${file} ${name} @ ${e}`).toContain(p.effort[e]);
        }
      }
    }
  });

  it("exposes only Antigravity model ids the CLI actually lists", () => {
    // `agy-gpt-oss` is the council's open-weights seat, and `agy models` lists
    // that family at one effort only (gpt-oss-120b-medium). With effort_suffix
    // the effort completes the model id, so every effort the model leaves open
    // must name an id the CLI knows — otherwise a request asking for `high`
    // builds `gpt-oss-120b-high` and the run dies on an unknown model.
    const listed = readFileSync("test/fixtures/antigravity/models.txt", "utf8")
      .split("\n").map((l) => l.split("\t")[0]).filter(Boolean);
    for (const file of BOTH_FILES) {
      const agy = loadConfig(file).providers.antigravity;
      expect(agy.models["agy-gpt-oss"].cli_model, file).toBe("gpt-oss-120b");
      expect(agy.models["agy-gpt-oss"].effort_suffix, file).toBe(true);
      for (const [name, m] of Object.entries(agy.models)) {
        // The same two steps effortValue() takes (src/providers/adapter.ts):
        // an effort the provider's table does not define is dropped, and the
        // id carries the table's *value*, not the key. They coincide only
        // while the table is the identity, and a host overlay may change it.
        const efforts = m.effort_suffix ? (m.efforts ?? (Object.keys(agy.effort) as Effort[])).filter((e) => Object.hasOwn(agy.effort, e)) : [];
        if (efforts.length === 0) expect(listed, `${file} ${name}`).toContain(m.cli_model);
        for (const e of efforts) expect(listed, `${file} ${name} @ ${e}`).toContain(`${m.cli_model}-${agy.effort[e]}`);
      }
    }
  });

  it("has no council at all unless one is configured", () => {
    expect(parseConfig(config()).council).toEqual({});
  });

  it("applies the council defaults and rejects an unknown key in the block", () => {
    const c = parseConfig(council()).council.capitoline;
    expect([c.judgeAllowMember, c.judgeBlind, c.minMembers, c.stageTimeoutS]).toEqual([false, true, 2, 300]);
    // The ranking stage is the default shape: a council that says nothing is
    // the panel of design §12.1, nine calls and all three stages.
    expect(c.ranking).toBe(true);
    expect(c.seats).toEqual([{ family: "f1", models: ["a"] }, { family: "f2", models: ["b"] }]);
    expect(() => parseConfig(council({ judge_blnd: "true" })))
      .toThrow(/council\.capitoline: Unrecognized key\(s\) in object: 'judge_blnd'/);
    expect(() => parseConfig(council({ seats: "[{family: f1, models: [a], judge: true}, {family: f2, models: [b]}]" })))
      .toThrow(/council\.capitoline\.seats\.0: Unrecognized key\(s\) in object: 'judge'/);
  });

  it("takes a council that declares the ranking stage off, and keeps the quorum meaning it had", () => {
    // The `-fast` shape is one flag, not another strategy: the seats, the
    // judge and the quorum are read exactly as for the full panel. Below
    // min_members there is still nothing to synthesize, so the floor of two
    // holds with the stage off.
    expect(parseConfig(council({ ranking: "false" })).council.capitoline.ranking).toBe(false);
    expect(() => parseConfig(council({ ranking: "false", min_members: "1" })))
      .toThrow(/council\.capitoline\.min_members/);
    expect(() => parseConfig(council({ ranking: "false", seats: "[{family: f1, models: [a]}]" })))
      .toThrow(/council\.capitoline\.seats: .*at least two seats/);
    // The members still answer in parallel, so the slots-per-seat rule of
    // §12.1 is untouched: the stage that goes is the second parallel one.
    expect(() => parseConfig(council({ ranking: "false" }, "capitoline", { concurrency: "1" })))
      .toThrow(/providers\.x\.concurrency/);
  });

  it("rejects a seat or a judge naming a model no provider declares", () => {
    // By name: a chain is written by hand and a typo in it would otherwise
    // only show up as a seat that can never be filled, at deliberation time.
    expect(() => parseConfig(council({ seats: "[{family: f1, models: [a, nope]}, {family: f2, models: [b]}]" })))
      .toThrow(/council\.capitoline\.seats\.0\.models: .*"nope".*no provider/);
    expect(() => parseConfig(council({ judge: "{family: f1, models: [nope]}" })))
      .toThrow(/council\.capitoline\.judge\.models: .*"nope".*no provider/);
    // Not an inherited key of Object.prototype either.
    expect(() => parseConfig(council({ judge: "{family: f1, models: [toString]}" })))
      .toThrow(/"toString".*no provider/);
  });

  it("rejects a seat or a judge naming a model that is not a text model", () => {
    // A deliberation is a chat request: an image model answers it with
    // bad_request, which no fallback retries, so the seat would be lost in the
    // middle of a deliberation. Same rule as health_model, for the same reason.
    const withImage: Fields = { models: "{ a: {cli_model: a}, img: {cli_model: i, kind: image} }", image: "{collect: [x]}" };
    expect(() => parseConfig(council({ seats: "[{family: f1, models: [a, img]}, {family: f2, models: [a]}]" }, "capitoline", withImage)))
      .toThrow(/council\.capitoline\.seats\.0\.models: .*"img".*not a text model/);
    expect(() => parseConfig(council({ judge: "{family: f1, models: [img]}" }, "capitoline", withImage)))
      .toThrow(/council\.capitoline\.judge\.models: .*"img".*not a text model/);
  });

  it("rejects two seats of the same family, and one model seated twice", () => {
    // Models of one lineage share their blind spots, so a family seated twice
    // is one opinion with two votes; the same model reached from two seats is
    // the same thing by another route (design §12.2).
    expect(() => parseConfig(council({ seats: "[{family: f1, models: [a]}, {family: f1, models: [b]}]" })))
      .toThrow(/council\.capitoline\.seats\.1\.family: .*family "f1" twice/);
    expect(() => parseConfig(council({ seats: "[{family: f1, models: [a, b]}, {family: f2, models: [b]}]" })))
      .toThrow(/council\.capitoline\.seats\.1\.models: .*"b" in two chains/);
    // The judge shares the first seat's chain in every default council, and
    // judge_allow_member is what governs that: the rule is about seats only.
    expect(() => parseConfig(council({ judge: "{family: f1, models: [a]}" }))).not.toThrow();
  });

  it("rejects a seat that names the same model twice", () => {
    // The second entry is unreachable — a model refused on the first pass is
    // refused on the second — and a seat stepping down mid-flight must not
    // land back on the model that has just refused it.
    expect(() => parseConfig(council({ seats: "[{family: f1, models: [a, a]}, {family: f2, models: [b]}]" })))
      .toThrow(/council\.capitoline\.seats\.0: .*must not repeat a model/);
  });

  it("rejects a panel its providers cannot answer in parallel", () => {
    // Two seats on one subscription with one slot: the second member waits on
    // the queue until max_wait_s and loses its seat in every parallel stage,
    // eight calls into the deliberation (design §12.1). One slot per seat it
    // serves, counted per provider and not per family.
    expect(() => parseConfig(council({}, "capitoline", { concurrency: "1" })))
      .toThrow(/providers\.x\.concurrency: provider x serves 2 seats of council "capitoline" with concurrency 1/);
    expect(() => parseConfig(council({ seats: "[{family: f1, models: [a]}, {family: f2, models: [b]}, {family: f3, models: [c]}]" }, "capitoline", { concurrency: "2" })))
      .toThrow(/providers\.x\.concurrency: .*serves 3 seats .*concurrency 2/);
    // The judge is not counted: it is seated alone, after the members are done.
    expect(() => parseConfig(council({ judge: "{family: f3, models: [c]}" }, "capitoline", { concurrency: "2" }))).not.toThrow();
  });

  it("counts the seats a provider serves one council at a time, and never summed over the councils", () => {
    // Two councils of two seats on one subscription, and two slots. The seats
    // of one council start in the same instant, so those are what the slots
    // must hold; two councils only contend while two deliberations overlap,
    // which is load and is what the queue and max_wait_s are for. Summed
    // instead, the slots would grow with every council name declared and the
    // shipped configuration — which is about to gain two more councils on the
    // same subscriptions — would stop validating at startup.
    const two = { capitoline: {}, "capitoline-fast": {} };
    expect(() => parseConfig(councils(two, { concurrency: "2" }))).not.toThrow();
    // The largest council is the one named and the one measured against: the
    // fix is to raise the slots to it or to move a seat out of it.
    const wide = { seats: "[{family: f1, models: [a]}, {family: f2, models: [b]}, {family: f3, models: [c]}]" };
    expect(() => parseConfig(councils({ capitoline: {}, "capitoline-wide": wide }, { concurrency: "2" })))
      .toThrow(/providers\.x\.concurrency: provider x serves 3 seats of council "capitoline-wide" with concurrency 2/);
  });

  it("rejects a council named after a provider model", () => {
    // The council is served by the same `model` field as every other model, so
    // a name held by both routes to one of them and never to the other.
    expect(() => parseConfig(council({}, "a"))).toThrow(/council\.a: .*"a".*provider x/);
  });

  it("rejects a council that could never rank anything", () => {
    // Below two answers there is nothing to rank, so a council configured for
    // one is not a council (design §12.5).
    expect(() => parseConfig(council({ min_members: "1" }))).toThrow(/council\.capitoline\.min_members/);
    expect(() => parseConfig(council({ min_members: "0" }))).toThrow(/council\.capitoline\.min_members/);
    // A quorum larger than the panel: reachable by no deliberation, so it is
    // rejected here rather than nine calls in, and accepted on three seats.
    expect(() => parseConfig(council({ min_members: "3" })))
      .toThrow(/council\.capitoline\.min_members: .*min_members 3 but declares only 2 seats/);
    const three = council({ min_members: "3", seats: "[{family: f1, models: [a]}, {family: f2, models: [b]}, {family: f3, models: [c]}]" });
    expect(parseConfig(three).council.capitoline.minMembers).toBe(3);
    expect(() => parseConfig(council({ seats: "[{family: f1, models: [a]}]" })))
      .toThrow(/council\.capitoline\.seats: .*at least two seats/);
    // A seat with an empty chain can never be filled.
    expect(() => parseConfig(council({ seats: "[{family: f1, models: []}, {family: f2, models: [b]}]" })))
      .toThrow(/council\.capitoline\.seats\.0\.models/);
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
    "council.capitoline-fast.stageTimeoutS",     // the same, for the fast shape
    "council.capitoline-gemini.stageTimeoutS",   //   and for the ladder
    "council.capitoline.stageTimeoutS",          // seconds, not minutes, so a suspended member fails fast
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
    for (const name of ["capitoline", "capitoline-fast", "capitoline-gemini"]) {
      expect(e2e.council[name].stageTimeoutS, name).toBeLessThanOrEqual(30);
      expect(repo.council[name].stageTimeoutS, name).toBeGreaterThanOrEqual(300);
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
