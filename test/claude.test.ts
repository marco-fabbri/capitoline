import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { claudeAdapter } from "../src/providers/claude.js";
import { loadConfig } from "../src/config.js";
import { modelSpecs } from "../src/providers/adapter.js";
import { classifyError } from "../src/providers/errors.js";
import type { AdapterEvent } from "../src/core/types.js";

const cfg = loadConfig("config/capitoline.yaml").providers.claude;
const models = modelSpecs("claude", cfg);
const opus = models.find((m) => m.name === "claude-opus")!;

async function* linesOf(path: string) { for (const l of readFileSync(path, "utf8").split("\n")) yield l; }
async function events(path: string) { const out: AdapterEvent[] = []; for await (const e of claudeAdapter.parse(linesOf(path))) out.push(e); return out; }

describe("claude adapter", () => {
  it("builds the command with model, effort and system prompt, prompt on stdin", () => {
    const c = claudeAdapter.buildCommand(cfg, opus, {
      model: "claude-opus", stream: true, effort: "high",
      messages: [{ role: "system", text: "Be terse." }, { role: "user", text: "hi" }],
    });
    expect(c.args.slice(0, cfg.args.length)).toEqual(cfg.args);
    expect(c.args).toContain("--model"); expect(c.args[c.args.indexOf("--model") + 1]).toBe("opus");
    expect(c.args[c.args.indexOf("--effort") + 1]).toBe("high");
    expect(c.args[c.args.indexOf("--system-prompt") + 1]).toBe("Be terse.");
    expect(c.stdin).toBe("hi");
  });
  it("defaults effort to medium and omits the system flag when absent", () => {
    const c = claudeAdapter.buildCommand(cfg, opus, { model: "claude-opus", stream: false, messages: [{ role: "user", text: "hi" }] });
    expect(c.args[c.args.indexOf("--effort") + 1]).toBe("medium");
    expect(c.args).not.toContain("--system-prompt");
  });
  it("takes the model and effort flag names from the configuration", () => {
    // The repository config declares the flags this CLI uses today, so a
    // renamed flag is a configuration change and never a code change.
    expect([cfg.model_flag, cfg.effort_flag, cfg.effort_key]).toEqual(["--model", "--effort", null]);
    const renamed = { ...cfg, model_flag: "--model-id", effort_flag: "--reasoning", effort_key: null };
    const c = claudeAdapter.buildCommand(renamed, opus, { model: "claude-opus", stream: false, effort: "high", messages: [{ role: "user", text: "hi" }] });
    expect(c.args.slice(cfg.args.length)).toEqual(["--model-id", "opus", "--reasoning", "high"]);
    expect(c.args).not.toContain("--model");
    expect(c.args).not.toContain("--effort");
  });
  it("passes the effort as a key=value argument when the provider declares an effort key", () => {
    const keyed = { ...cfg, effort_flag: "-c", effort_key: "reasoning.effort" };
    const c = claudeAdapter.buildCommand(keyed, opus, { model: "claude-opus", stream: false, effort: "low", messages: [{ role: "user", text: "hi" }] });
    expect(c.args.slice(cfg.args.length)).toEqual(["--model", "opus", "-c", 'reasoning.effort="low"']);
  });
  it("omits the effort argument when the provider declares no effort flag", () => {
    const noEffort = { ...cfg, effort_flag: null };
    const c = claudeAdapter.buildCommand(noEffort, opus, { model: "claude-opus", stream: false, effort: "high", messages: [{ role: "user", text: "hi" }] });
    expect(c.args.slice(cfg.args.length)).toEqual(["--model", "opus"]);
  });
  it("appends what the host adds, after the repository's own command line", () => {
    // `args_extra` is how a host adds an argument without copying the
    // repository's list into its overlay to append to it: a list replaces and
    // is never appended to, so the copy drifted at every pull.
    const withExtra = { ...cfg, args_extra: ["--settings", "/home/runner/.claude/capitoline.json"] };
    const c = claudeAdapter.buildCommand(withExtra, opus, { model: "claude-opus", stream: false, messages: [{ role: "user", text: "hi" }] });
    expect(c.args.slice(0, cfg.args.length)).toEqual(cfg.args);
    expect(c.args.slice(cfg.args.length, cfg.args.length + 2)).toEqual(["--settings", "/home/runner/.claude/capitoline.json"]);
    // And the model still follows, so the extra arguments never displace it.
    expect(c.args.slice(cfg.args.length + 2, cfg.args.length + 4)).toEqual(["--model", "opus"]);
  });
  it("parses partial stream output into text deltas, rate limits and done with usage", async () => {
    const ev = await events("test/fixtures/claude/stream-json-partial.jsonl");
    expect(ev.filter((e) => e.type === "text").map((e) => (e as any).delta).join("")).toBe("ok ok");
    const rl = ev.find((e) => e.type === "rate_limit") as any;
    expect(rl.fiveHour.utilization).toBeCloseTo(0.05);
    expect(rl.sevenDay.resetsAt).toBe(1790362800);
    const done = ev.at(-1) as any;
    expect(done.type).toBe("done");
    expect(done.usage).toEqual({ input: 2 + 2947 + 3046, output: 6 });
    // The dated id of what actually answered, which `--model opus` never says.
    // Read from message_start and not from the result object's modelUsage,
    // although both carry it: modelUsage is `{}` in every error capture, while
    // message_start arrives before anything can go wrong. Confirmed against a
    // real run on the host, 2026-09-23.
    expect(done.cliModelId).toBe("claude-sonnet-5");
  });
  it("leaves the model id unset when the stream carried no message_start", async () => {
    // "Nothing said" is a real state and null is its name. The locked capture
    // is a real one and has no message_start in it.
    const ev = await events("test/fixtures/claude/stream-json-locked.jsonl");
    expect((ev.at(-1) as any).cliModelId).toBeUndefined();
  });
  it("uses the assistant message when no deltas were streamed", async () => {
    const ev = await events("test/fixtures/claude/stream-json-locked.jsonl");
    expect(ev.filter((e) => e.type === "text").map((e) => (e as any).delta).join("")).toBe("ok");
    expect(ev.at(-1)!.type).toBe("done");
  });
  it("maps an error result to a typed error", async () => {
    async function* l() { yield JSON.stringify({ type: "result", is_error: true, subtype: "error_during_execution", result: "Login expired · Please run /login" }); }
    const out: AdapterEvent[] = []; for await (const e of claudeAdapter.parse(l())) out.push(e);
    expect(out).toEqual([{ type: "error", kind: "auth_expired", detail: "Login expired · Please run /login" }]);
  });
  it("classifies a model-limit refusal from api_error_status and marks it model-scoped", async () => {
    // Real capture, host, 2026-09-21: the Fable model exhausted while the same
    // subscription still answered on the others. The sentence matches neither
    // the auth nor the rate pattern, so the prose alone says cli_crashed (502).
    const raw = JSON.parse(readFileSync("test/fixtures/claude/rate-limited-model.json", "utf8")) as Record<string, unknown>;
    expect(raw.subtype).toBe("success");          // never a success signal: is_error decides
    expect(classifyError(String(raw.result))).toBe("cli_crashed");
    const ev = await events("test/fixtures/claude/rate-limited-model.json");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: "error", kind: "rate_limited", scope: "model" });
    expect((ev[0] as any).detail).toContain("You've reached your Fable limit");
  });
  it("classifies the real expired-credential capture as auth_expired, provider-wide", async () => {
    const ev = await events("test/fixtures/claude/auth-expired.json");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: "error", kind: "auth_expired" });
    expect(ev[0]).not.toHaveProperty("scope");    // an invalid credential is the subscription's, not the model's
  });
  it("prefers the status over the prose, and falls back to the prose without one", async () => {
    const one = async (o: Record<string, unknown>) => {
      const src = (async function* () { yield JSON.stringify({ type: "result", is_error: true, subtype: "success", ...o }); })();
      const out: AdapterEvent[] = []; for await (const e of claudeAdapter.parse(src)) out.push(e); return out[0] as any;
    };
    expect(await one({ api_error_status: 429, result: "Login expired · Please run /login" })).toMatchObject({ kind: "rate_limited" });
    expect(await one({ api_error_status: 403, result: "quota exceeded" })).toMatchObject({ kind: "auth_expired" });
    expect(await one({ api_error_status: 503, result: "upstream is busy" })).toMatchObject({ kind: "cli_crashed" });
    // A status the map says nothing about, and no status at all: the prose decides.
    expect(await one({ api_error_status: 400, result: "429 Too Many Requests" })).toMatchObject({ kind: "rate_limited" });
    expect(await one({ result: "429 Too Many Requests" })).toMatchObject({ kind: "rate_limited" });
    // A provider-wide 429 keeps the provider-wide pause: no model attribution.
    expect(await one({ api_error_status: 429, result: "Claude usage limit reached. Your limit will reset at 3pm." })).not.toHaveProperty("scope");
    // The same template carrying the plan's own limit: the advice to change
    // model is there too, and taking it as model-scoped would leave every
    // other model of an exhausted subscription starting a run of its own.
    expect(await one({ api_error_status: 429, result: "You've reached your usage limit. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue." })).not.toHaveProperty("scope");
    // No `result` at all: the detail is the terminal reason, never `subtype`,
    // which stays "success" on a failure and would read "provider error …
    // detail: success" in the log.
    expect(await one({ api_error_status: 500, terminal_reason: "api_error" })).toMatchObject({ kind: "cli_crashed", detail: "api_error" });
  });
  it("emits no rate_limit event when neither window can be parsed", async () => {
    const collect = async (info: unknown) => {
      const src = (async function* () { yield JSON.stringify({ type: "rate_limit_event", rate_limit_info: info }); })();
      const out: AdapterEvent[] = []; for await (const e of claudeAdapter.parse(src)) out.push(e); return out;
    };
    // Both unparseable: emitting would hand Core an event with no window in it.
    expect(await collect({ unifiedWindows: { five_hour: null, seven_day: "soon" } })).toEqual([]);
    expect(await collect(undefined)).toEqual([]);
    // One of the two parses: still reported, with the other left undefined.
    expect(await collect({ unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 7 }, seven_day: {} } }))
      .toEqual([{ type: "rate_limit", fiveHour: { utilization: 0.5, resetsAt: 7 }, sevenDay: undefined }]);
  });
  it("prefixes the prompt on stdin when the provider declares no system prompt flag", () => {
    // buildCommand's else branch: the Antigravity adapter renders its system
    // prompt exactly this way, and for this CLI it is what a
    // `system_prompt_flag: null` in the host's hand-edited file would do.
    // Nothing exercised it, so the prompt could have been dropped instead.
    const noFlag = { ...cfg, system_prompt_flag: null };
    const c = claudeAdapter.buildCommand(noFlag, opus, {
      model: "claude-opus", stream: false,
      messages: [{ role: "system", text: "Be terse." }, { role: "user", text: "hi" }],
    });
    expect(c.args).not.toContain("--system-prompt");
    expect(c.args).not.toContain("Be terse.");       // nowhere on the command line
    expect(c.stdin).toBe("System instructions:\nBe terse.\n\nhi");
  });
  it("reads the system prompt prefix from the configuration instead of ignoring it", () => {
    // Today's value is null, which is why the cases above see
    // `--system-prompt <text>`. The key is required in every provider block,
    // and while only codex.ts read it, a `system_prompt_flag_prefix: -c` on
    // the host's `providers.claude` block passed `npm run check-config` and
    // changed nothing at all: the file said the prompt travelled as an
    // override, the process still passed it bare, and the validation was
    // silent. Not a command line the Claude CLI accepts — the point is that a
    // key the file declares reaches the command line the adapter builds.
    expect(cfg.system_prompt_flag_prefix).toBeNull();
    const withPrefix = { ...cfg, system_prompt_flag_prefix: "-c" };
    const c = claudeAdapter.buildCommand(withPrefix, opus, {
      model: "claude-opus", stream: false,
      messages: [{ role: "system", text: "Be terse." }, { role: "user", text: "hi" }],
    });
    expect(c.args.slice(-2)).toEqual(["-c", '--system-prompt="Be terse."']);
    expect(c.args.indexOf("Be terse.")).toBe(-1);   // never as a bare argument
    expect(c.stdin).toBe("hi");
  });
  it("renders a multi-turn conversation with role markers, system prompt aside", () => {
    // Every other case here sends one user message, which takes flatten()'s
    // shortcut and never builds a marker. With a real conversation the markers
    // are the only thing telling the CLI who said what.
    const c = claudeAdapter.buildCommand(cfg, opus, {
      model: "claude-opus", stream: false,
      messages: [
        { role: "system", text: "Be terse." },
        { role: "user", text: "a" }, { role: "assistant", text: "b" }, { role: "user", text: "c" },
      ],
    });
    expect(c.stdin).toBe("User: a\n\nAssistant: b\n\nUser: c");
    expect(c.args[c.args.indexOf("--system-prompt") + 1]).toBe("Be terse.");
    expect(c.stdin).not.toContain("Be terse.");      // the system prompt travels by flag, once
  });
});
