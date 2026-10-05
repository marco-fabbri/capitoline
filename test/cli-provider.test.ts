import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { CliProvider } from "../src/providers/cli-provider.js";
import { buildProviders } from "../src/providers/index.js";
import { claudeAdapter } from "../src/providers/claude.js";
import { antigravityAdapter } from "../src/providers/antigravity.js";
import { jsonLines, type Adapter } from "../src/providers/adapter.js";
import { createRunner, type CaptureSpec, type RunHandle, type Runner } from "../src/runner/runner.js";
import { createLogger } from "../src/log.js";
import { loadConfig } from "../src/config.js";
import type { ImageRequest, InternalRequest, ProviderEvent } from "../src/core/types.js";

const FAKE = join(process.cwd(), "test/fake-cli/fake-cli.mjs");
const config = loadConfig("config/capitoline.yaml");
const base = config.providers.claude;
const runner = createRunner({ sandboxRoot: mkdtempSync(join(tmpdir(), "cp-")), user: null, killGraceMs: 200, log: createLogger("t") });

// Wraps the runner so a test can observe the underlying run's result.
function spyRunner(): Runner & { handles: RunHandle[]; captures: CaptureSpec[] } {
  const handles: RunHandle[] = [];
  const captures: CaptureSpec[] = [];
  return {
    handles, captures,
    async run(spec) { const h = await runner.run(spec); handles.push(h); return h; },
    capture(spec) { captures.push(spec); return runner.capture(spec); },
    sweep(olderThanMs) { return runner.sweep(olderThanMs); },
  };
}

function provider(mode: string, extra: Partial<typeof base> = {}, r: Runner = runner, adapter: Adapter = claudeAdapter, opts = {}) {
  const fixture = join(process.cwd(), "test/fixtures/claude/stream-json-locked.jsonl"); // absolute: the CLI runs inside the sandbox dir
  const cfg = { ...base, binary: FAKE, args: ["--mode", mode, "--file", fixture], timeout_s: 1, ...extra };
  return new CliProvider("claude", cfg, adapter, r, createLogger("t"), opts);
}
const req = { model: "claude-haiku", stream: true, messages: [{ role: "user" as const, text: "hi" }] };
async function run(p: CliProvider, r: InternalRequest = req, signal?: AbortSignal) {
  const out: ProviderEvent[] = [];
  const m = p.models().find((x) => x.name === "claude-haiku")!;
  for await (const e of p.execute(r, m, signal)) out.push(e);
  return out;
}

describe("CliProvider", () => {
  it("reports bad_output, with what the run spent, when the model answers nothing", async () => {
    // A real capture (host, 2026-09-23): gemini-3.8-flash-high asked about
    // Linux keepalive defaults tried run_command with sysctl, the runner's
    // strict permission soft-denied it, and Antigravity ended the run with an
    // empty response after 608 output tokens. Before this a direct request
    // answered 200 with empty content.
    const agyCfg = config.providers.antigravity;
    const fixture = join(process.cwd(), "test/fixtures/antigravity/stream-json-tool-denied.jsonl");
    const p = new CliProvider("antigravity", { ...agyCfg, binary: FAKE, args: ["--mode", "replay", "--file", fixture], timeout_s: 5, forget: undefined }, antigravityAdapter, runner, createLogger("t"));
    const m = p.models().find((x) => x.name === "antigravity-gemini-flash-high")!;
    const out: ProviderEvent[] = [];
    for await (const e of p.execute({ model: m.name, stream: false, messages: [{ role: "user", text: "q" }] }, m)) out.push(e);
    // The failure, and the tokens the quota was charged for it.
    expect(out).toEqual([{ type: "error", kind: "bad_output", detail: "the model answered with nothing", usage: { input: 12659, output: 608, cachedInput: 0 } }]);
  });
  it("replays fixture output through the adapter", async () => {
    const ev = await run(provider("replay"));
    expect(ev.map((e) => e.type)).toEqual(["text", "rate_limit", "done"]);
  });
  it("yields timeout when the process is killed by the deadline", async () => {
    const ev = await run(provider("hang"));
    expect(ev.at(-1)).toMatchObject({ type: "error", kind: "timeout" });
  });
  it("yields a classified error with stderr detail on crash", async () => {
    const ev = await run(provider("crash"));
    expect(ev.at(-1)).toMatchObject({ type: "error", kind: "cli_crashed", detail: expect.stringContaining("boom") });
  });
  it("yields bad_output when the process exits cleanly without a result", async () => {
    const ev = await run(provider("stdin-len"));
    expect(ev.at(-1)).toMatchObject({ type: "error", kind: "bad_output" });
  });
  it("ends right after the terminal event and stops a CLI that lingers", async () => {
    const spy = spyRunner();
    const t0 = Date.now();
    const ev = await run(provider("replay-linger", { timeout_s: 5 }, spy, claudeAdapter, { exitGraceMs: 300 }));
    const iterated = Date.now() - t0;
    expect(ev.map((e) => e.type)).toEqual(["text", "rate_limit", "done"]);
    expect(iterated).toBeLessThan(2000); // not the 5 s timeout nor the fake's 10 s sleep
    const r = await spy.handles[0]!.result;
    expect(r).toMatchObject({ aborted: true, timedOut: false });
    expect(Date.now() - t0).toBeLessThan(3000); // killed after the grace, well before the timeout
  });
  it("stops the run without an error event when the caller aborts", async () => {
    const spy = spyRunner();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const ev = await run(provider("hang", { timeout_s: 5 }, spy), req, ac.signal);
    expect(ev.filter((e) => e.type === "error")).toEqual([]);
    expect(await spy.handles[0]!.result).toMatchObject({ aborted: true, timedOut: false });
  });
  it("kills the process when the consumer stops iterating early", async () => {
    // Fixture with only the assistant line: the fake prints one text event, then lingers.
    const partial = join(mkdtempSync(join(tmpdir(), "cp-fx-")), "partial.jsonl");
    writeFileSync(partial, readFileSync(join(process.cwd(), "test/fixtures/claude/stream-json-locked.jsonl"), "utf8").split("\n")[1] + "\n");
    const spy = spyRunner();
    const p = provider("replay-linger", { timeout_s: 5, args: ["--mode", "replay-linger", "--file", partial] }, spy);
    const m = p.models().find((x) => x.name === "claude-haiku")!;
    const t0 = Date.now();
    for await (const e of p.execute(req, m)) { expect(e.type).toBe("text"); break; }
    expect(await spy.handles[0]!.result).toMatchObject({ aborted: true, timedOut: false });
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it("drops adapter-internal meta and tool events from a text run", async () => {
    const chatty: Adapter = {
      buildCommand: (cfg) => ({ args: cfg.args, stdin: "" }),
      async *parse(lines) {
        for await (const _ of jsonLines(lines)) { /* drain */ }
        yield { type: "meta", conversationId: "c1" };
        yield { type: "tool", phase: "call", name: "generate_image", raw: "{}" };
        yield { type: "text", delta: "hi" };
        yield { type: "tool", phase: "done", name: "generate_image", raw: "{}" };
        yield { type: "done" };
      },
    };
    const ev = await run(provider("replay", {}, runner, chatty));
    expect(ev).toEqual([{ type: "text", delta: "hi" }, { type: "done" }]);
  });
  it("logs an adapter's diagnostic and never hands it to the consumer", async () => {
    const noting: Adapter = {
      buildCommand: (cfg) => ({ args: cfg.args, stdin: "" }),
      async *parse(lines) {
        for await (const _ of jsonLines(lines)) { /* drain */ }
        yield { type: "text", delta: "hi" };
        yield { type: "diagnostic", message: "something worth a line", data: { steps: { "1": 2, "2": 2 } } };
        yield { type: "done" };
      },
    };
    const logged: string[] = [];
    const fixture = join(process.cwd(), "test/fixtures/claude/stream-json-locked.jsonl");
    const p = new CliProvider("claude", { ...base, binary: FAKE, args: ["--mode", "replay", "--file", fixture], timeout_s: 1 }, noting, runner,
      createLogger("t", { write: (line: string) => { logged.push(line); } }));
    const ev = await run(p);
    expect(ev).toEqual([{ type: "text", delta: "hi" }, { type: "done" }]);
    const line = logged.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === "something worth a line");
    expect(line).toMatchObject({ level: 40, model: "claude-haiku", steps: { "1": 2, "2": 2 } });
  });
  it("writes attachments into the sandbox as attachment-<n>.<ext>", async () => {
    // Adapter that turns the fake CLI's "cwd" listing into a text event.
    const listing: Adapter = {
      buildCommand: (cfg) => ({ args: cfg.args, stdin: "" }),
      async *parse(lines) {
        for await (const o of jsonLines(lines)) if (Array.isArray(o.files)) yield { type: "text", delta: (o.files as string[]).sort().join(",") };
        yield { type: "done" };
      },
    };
    const attachments = [
      { mime: "image/png", bytes: Buffer.from("a") },
      { mime: "application/x-unknown", bytes: Buffer.from("b") },
      { mime: "image/jpeg; charset=utf-8", bytes: Buffer.from("c") },
      { mime: "__proto__", bytes: Buffer.from("d") },
    ];
    const ev = await run(provider("cwd", {}, runner, listing), { ...req, attachments });
    expect(ev[0]).toEqual({ type: "text", delta: "attachment-1.png,attachment-2.bin,attachment-3.jpg,attachment-4.bin" });
  });
  it("health() is ok on replay and not ok on crash", async () => {
    expect((await provider("replay").health()).ok).toBe(true);
    const h = await provider("crash").health();
    expect(h.ok).toBe(false); expect(h.kind).toBe("cli_crashed");
  });
  it("health() reports timeout when its deadline passes and stops the probe", async () => {
    const spy = spyRunner();
    const h = await provider("hang", { timeout_s: 5 }, spy, claudeAdapter, { healthDeadlineMs: 200 }).health();
    expect(h).toMatchObject({ ok: false, kind: "timeout" });
    expect(await spy.handles[0]!.result).toMatchObject({ aborted: true, timedOut: false });
  });
  it("health() attributes a model-scoped refusal to the model it probed", async () => {
    // The probe runs health_model, so the attribution the adapter read out of
    // the CLI must travel with the verdict: Core pauses that one model instead
    // of marking the provider, which would take every other model down with it.
    const fixture = join(process.cwd(), "test/fixtures/claude/rate-limited-model.json");
    const h = await provider("replay", { args: ["--mode", "replay", "--file", fixture] }).health();
    expect(h).toMatchObject({ ok: false, kind: "rate_limited", scope: "model", model: "claude-haiku" });
    expect(base.health_model).toBe("claude-haiku");
  });
  it("health() leaves the scope out of a refusal the CLI did not attribute", async () => {
    const h = await provider("crash").health();
    expect(h).not.toHaveProperty("scope");
    expect(h.model).toBe("claude-haiku");   // the probed model is reported either way
  });
  it("health() fails clearly on an unknown health_model", async () => {
    const h = await provider("replay", { health_model: "nope" }).health();
    expect(h).toMatchObject({ ok: false, kind: "bad_output", detail: expect.stringContaining("nope") });
  });
});

describe("CliProvider.generateImage", () => {
  const agy = config.providers.antigravity;
  const IMAGE_RUN = join(process.cwd(), "test/fixtures/antigravity/image-run.jsonl");
  const IMAGE_429 = join(process.cwd(), "test/fixtures/antigravity/image-429.jsonl");
  const COLLECT = join(process.cwd(), "test/fake-cli/fake-collect-image.sh");
  const SAMPLE = readFileSync(join(process.cwd(), "test/fixtures/images/sample.jpg"));
  // The 429 fixture was captured on 2026-09-21; with a fixed clock the wait is the
  // captured delay, not whatever is left until the reset at the time the test runs.
  const NOW = Date.parse("2026-09-21T12:00:00Z");
  const imageReq: ImageRequest = { model: "antigravity-image", prompt: "a lighthouse on a cliff at dawn, watercolour" };

  function imageProvider(fixture: string, extra: Partial<typeof agy> = {}, r: Runner = runner, opts = {}, mode = "replay", adapter: Adapter = antigravityAdapter) {
    // No forget unless a test asks for it: it runs after the process, at a
    // moment the tests counting the collect's captures cannot pin down.
    // The recordings of this block are from before 1.2.16, when the agent
    // called generate_image itself: they still exercise the guard, the quota
    // detection and the collect, with the tool they were recorded with. The
    // subagent hand-off of today's configuration has its own tests below.
    const cfg = { ...agy, binary: FAKE, args: ["--mode", mode, "--file", fixture], timeout_s: 1, image: { ...agy.image, allowed_tools: ["generate_image"], attempts: 1, collect: [COLLECT] }, forget: undefined, sweep: undefined, ...extra };
    return new CliProvider("antigravity", cfg, adapter, r, createLogger("t"), { now: () => NOW, ...opts });
  }
  async function generate(p: CliProvider, signal?: AbortSignal, timeoutS?: number) {
    const out: ProviderEvent[] = [];
    const m = { ...p.models().find((x) => x.name === "antigravity-image")!, timeoutS };
    for await (const e of p.generateImage!(imageReq, m, signal)) out.push(e);
    return out;
  }
  // FAKE_COLLECT reaches the fake helper through the runner's environment.
  async function withCollect<T>(outcome: string, fn: () => Promise<T>): Promise<T> {
    process.env.FAKE_COLLECT = outcome;
    try { return await fn(); } finally { delete process.env.FAKE_COLLECT; }
  }
  // A synthetic stream: init, the given tool step, then (optionally) a SUCCESS result.
  function synthetic(lines: Record<string, unknown>[]): string {
    const path = join(mkdtempSync(join(tmpdir(), "cp-img-")), "run.jsonl");
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return path;
  }
  const CID = "40fc0b5c-042f-453a-9eaf-6162913de55e";
  const init = { event: "init", conversation_id: CID, init: { model: "gemini-3.8-flash-low" } };
  const toolStep = (name: string, state: string, index = 2) => ({ event: "step_update", step_update: { conversation_id: CID, step_index: index, state, step_type: "tool", tool_name: name, tool_info: { name, parameters: {} } } });
  const result = { event: "result", result: { conversation_id: CID, status: "SUCCESS", response: "done\n", usage: { input_tokens: 10, output_tokens: 2 } } };

  it("yields the collected image (1376x768 JPEG) then done on a real run", async () => {
    const spy = spyRunner();
    const ev = await generate(imageProvider(IMAGE_RUN, {}, spy));
    expect(ev.map((e) => e.type)).toEqual(["image", "done"]);
    expect(ev[0]).toMatchObject({ type: "image", mime: "image/jpeg", width: 1376, height: 768 });
    expect((ev[0] as { bytes: Buffer }).bytes.equals(SAMPLE)).toBe(true);
    expect(ev[1]).toEqual({ type: "done", usage: { input: 26711, output: 60, cachedInput: 0 } });
    // The collect command gets the conversation id from the stream as its last argument.
    expect(spy.captures).toHaveLength(1);
    expect(spy.captures[0]).toMatchObject({ binary: COLLECT, args: [CID], timeoutMs: 30_000, maxBytes: 20 * 1024 * 1024 });
  });
  // Antigravity keeps every conversation in its home; the forget command
  // removes it after each run, in the background, once the process has ended.
  const FORGET_OK = ["/usr/bin/true", "forget"];
  it("forgets a text run's conversation once the run has ended", async () => {
    const spy = spyRunner();
    const fixture = join(process.cwd(), "test/fixtures/antigravity/stream-json.jsonl");
    const p = new CliProvider("antigravity", { ...agy, binary: FAKE, args: ["--mode", "replay", "--file", fixture], timeout_s: 5, forget: FORGET_OK }, antigravityAdapter, spy, createLogger("t"));
    const m = p.models().find((x) => x.name === "antigravity-gemini-flash")!;
    const out: ProviderEvent[] = [];
    for await (const e of p.execute({ model: m.name, stream: false, messages: [{ role: "user", text: "q" }] }, m)) out.push(e);
    expect(out.at(-1)?.type).toBe("done");
    await vi.waitFor(() => expect(spy.captures).toHaveLength(1));
    expect(spy.captures[0]).toMatchObject({ binary: "/usr/bin/true", args: ["forget", "fdc15146-e14d-4592-a062-8bebca386077"] });
  });
  describe("through the image-generator subagent (Antigravity 1.2.16)", () => {
    const SUBAGENT_RUN = join(process.cwd(), "test/fixtures/antigravity/image-subagent.jsonl");
    const PARENT = "e0405ad8-9fe1-45e8-9eea-b05629b4c775", CHILD = "d42fca3a-f043-4234-a505-30dd1099c02a";
    // The repository's own allow-list, not the block's: this is what is deployed.
    const today = { image: { ...agy.image, attempts: 1, collect: [COLLECT] } };
    const twice = { image: { ...agy.image, attempts: 2, collect: [COLLECT] } };

    it("admits the hand-off, collects the image from the run's conversation and forgets the subagent's too", async () => {
      const spy = spyRunner();
      const ev = await generate(imageProvider(SUBAGENT_RUN, { ...today, forget: FORGET_OK }, spy));
      expect(ev.map((e) => e.type)).toEqual(["image", "done"]);
      await vi.waitFor(() => expect(spy.captures).toHaveLength(3));
      expect(spy.captures.map((c) => c.args)).toEqual([[PARENT], ["forget", PARENT], ["forget", CHILD]]);
    });
    it("runs a request again, once, when the run made nothing, and never after a quota refusal", async () => {
      // Each attempt is its own CLI process: the spy counts them by their collect calls.
      const count = (spy: ReturnType<typeof spyRunner>) => spy.captures.filter((c) => c.args[0] !== "forget").length;
      const stopped = synthetic([init, toolStep("run_command", "ACTIVE"), result]);
      let spy = spyRunner();
      expect(await generate(imageProvider(stopped, twice, spy, {}, "replay-linger"), undefined, 5)).toEqual([{ type: "error", kind: "bad_output", detail: "unexpected tool call: run_command" }]);
      expect(count(spy)).toBe(0); // stopped before anything could be collected, both times

      // Ended with no image: collected twice, refused once.
      spy = spyRunner();
      const none = await withCollect("none", () => generate(imageProvider(join(process.cwd(), "test/fixtures/antigravity/image-tool-unavailable.jsonl"), twice, spy)));
      expect(none).toEqual([{ type: "error", kind: "bad_output", detail: "no image produced" }]);
      expect(count(spy)).toBe(2);
      spy = spyRunner();
      await withCollect("none", () => generate(imageProvider(join(process.cwd(), "test/fixtures/antigravity/image-tool-unavailable.jsonl"), today, spy)));
      expect(count(spy)).toBe(1);

      // A quota refusal is not run again: it would spend the same refusal.
      spy = spyRunner();
      const quota = await withCollect("none", () => generate(imageProvider(join(process.cwd(), "test/fixtures/antigravity/image-subagent-429.jsonl"), twice, spy)));
      expect(quota[0]).toMatchObject({ type: "error", kind: "rate_limited" });
      expect(count(spy)).toBe(2); // the run's own conversation and the subagent's, one attempt
    });
    it("looks for the image in the subagent's conversation when the run's own holds none", async () => {
      const spy = spyRunner();
      const ev = await withCollect("subagent", () => generate(imageProvider(SUBAGENT_RUN, today, spy)));
      expect(ev.map((e) => e.type)).toEqual(["image", "done"]);
      expect(spy.captures.map((c) => c.args)).toEqual([[PARENT], [CHILD]]);
    });
    it("no longer admits the tool the agent used to call itself, nor a second hand-off, nor another subagent", async () => {
      const sub = (type: string, state: string, index = 2) => ({ event: "step_update", step_update: { conversation_id: CID, step_index: index, state, step_type: "subagent", tool_name: "invoke_subagent", subagent_info: { subagents: [{ type_name: type }] } } });
      const run = async (lines: Record<string, unknown>[]) => generate(imageProvider(synthetic(lines), today, runner, {}, "replay-linger"), undefined, 5);
      expect(await run([init, toolStep("generate_image", "ACTIVE"), result])).toEqual([{ type: "error", kind: "bad_output", detail: "unexpected tool call: generate_image" }]);
      expect(await run([init, sub("browser", "ACTIVE"), result])).toEqual([{ type: "error", kind: "bad_output", detail: "unexpected tool call: subagent:browser" }]);
      expect(await run([init, sub("image-generator", "ACTIVE"), sub("image-generator", "DONE"), sub("image-generator", "ACTIVE", 4), result]))
        .toEqual([{ type: "error", kind: "bad_output", detail: "tool called more than once: subagent:image-generator" }]);
      // What the agent reached for under the old prompt, one request in two.
      for (const tool of ["schedule", "manage_task", "invoke_subagent"]) {
        expect(await run([init, toolStep(tool, "ACTIVE"), result]), tool).toEqual([{ type: "error", kind: "bad_output", detail: `unexpected tool call: ${tool}` }]);
      }
    });
    it("lets the agent wait for the subagent with a timer and a look at its list, and with nothing else", async () => {
      const spy = spyRunner();
      const ev = await generate(imageProvider(join(process.cwd(), "test/fixtures/antigravity/image-subagent-waiting.jsonl"), { ...today, forget: FORGET_OK }, spy));
      expect(ev.map((e) => e.type)).toEqual(["image", "done"]);
      const sub = { event: "step_update", step_update: { conversation_id: CID, step_index: 2, state: "DONE", step_type: "subagent", tool_name: "invoke_subagent", subagent_info: { subagents: [{ type_name: "image-generator" }] } } };
      const manage = (Action: string, index: number) => ({ event: "step_update", step_update: { conversation_id: CID, step_index: index, state: "ACTIVE", step_type: "tool", tool_name: "manage_subagents", tool_info: { name: "manage_subagents", parameters: { Action } } } });
      const run = async (lines: Record<string, unknown>[]) => generate(imageProvider(synthetic(lines), today, runner, {}, "replay-linger"), undefined, 5);
      // Acting on a subagent is not looking at it.
      expect(await withCollect("none", () => run([init, sub, manage("kill", 3), result]))).toEqual([{ type: "error", kind: "bad_output", detail: "unexpected tool call: manage_subagents:kill" }]);
      // A waiting step cannot open the run: there is nothing to wait for yet.
      expect(await run([init, toolStep("schedule", "ACTIVE"), result])).toEqual([{ type: "error", kind: "bad_output", detail: "unexpected tool call: schedule" }]);
      expect(await run([init, manage("list", 1), result])).toEqual([{ type: "error", kind: "bad_output", detail: "unexpected tool call: manage_subagents:list" }]);
    });
    // With the picture saved the agent went on to look at it (view_file). It is
    // stopped there as anywhere else; the picture it had already made is kept.
    it("stops the agent at a step it is not allowed after the hand-off, and keeps the image if one was made", async () => {
      const sub = { event: "step_update", step_update: { conversation_id: CID, step_index: 2, state: "DONE", step_type: "subagent", tool_name: "invoke_subagent", subagent_info: { subagents: [{ type_name: "image-generator" }] } } };
      const lines = synthetic([init, sub, toolStep("view_file", "ACTIVE", 4), result]);
      const made = await generate(imageProvider(lines, today, runner, {}, "replay-linger"), undefined, 5);
      expect(made.map((e) => e.type)).toEqual(["image", "done"]);
      const nothing = await withCollect("none", () => generate(imageProvider(lines, today, runner, {}, "replay-linger"), undefined, 5));
      expect(nothing).toEqual([{ type: "error", kind: "bad_output", detail: "unexpected tool call: view_file" }]);
      const cut = await withCollect("tiny", () => generate(imageProvider(lines, today, runner, {}, "replay-linger"), undefined, 5));
      expect(cut).toEqual([{ type: "error", kind: "bad_output", detail: "unexpected tool call: view_file" }]);
      // Before the hand-off has finished there is nothing to keep: refused at once.
      const early = { ...sub, step_update: { ...sub.step_update, state: "ACTIVE" } };
      expect(await generate(imageProvider(synthetic([init, early, toolStep("view_file", "ACTIVE", 4), result]), today, runner, {}, "replay-linger"), undefined, 5))
        .toEqual([{ type: "error", kind: "bad_output", detail: "unexpected tool call: view_file" }]);
    });
    it("reports the quota the subagent ran into, which reaches the run only as the agent's words", async () => {
      const ev = await withCollect("none", () => generate(imageProvider(join(process.cwd(), "test/fixtures/antigravity/image-subagent-429.jsonl"), today)));
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ type: "error", kind: "rate_limited" });
    });
    it("reports bad_output, not a picture, when the agent only says the tool is not available", async () => {
      const ev = await withCollect("none", () => generate(imageProvider(join(process.cwd(), "test/fixtures/antigravity/image-tool-unavailable.jsonl"), today)));
      expect(ev).toEqual([{ type: "error", kind: "bad_output", detail: "no image produced" }]);
    });
  });

  it("forgets an image run's conversation after collecting the image, never before", async () => {
    const spy = spyRunner();
    const ev = await generate(imageProvider(IMAGE_RUN, { forget: FORGET_OK }, spy));
    expect(ev.map((e) => e.type)).toEqual(["image", "done"]);
    await vi.waitFor(() => expect(spy.captures).toHaveLength(2));
    expect(spy.captures.map((c) => c.args)).toEqual([[CID], ["forget", CID]]);
  });
  it("answers all the same when forgetting fails", async () => {
    const spy = spyRunner();
    const ev = await generate(imageProvider(IMAGE_RUN, { forget: ["/usr/bin/false"] }, spy));
    expect(ev.map((e) => e.type)).toEqual(["image", "done"]);
    await vi.waitFor(() => expect(spy.captures).toHaveLength(2));
  });
  it("never forwards adapter-internal meta or tool events", async () => {
    const ev = await generate(imageProvider(IMAGE_RUN));
    expect(ev.some((e) => (e.type as string) === "meta" || (e.type as string) === "tool")).toBe(false);
  });
  it("reports rate_limited with the captured reset wait on the silent 429", async () => {
    // Nothing lands in the conversation on a 429 (FAKE_COLLECT=none mirrors that);
    // the CLI is stopped at once and its directory is still collected away.
    const spy = spyRunner();
    const ev = await withCollect("none", () => generate(imageProvider(IMAGE_429, {}, spy, {}, "replay-linger"), undefined, 5));
    expect(ev).toHaveLength(1);
    // scope "model": the image tool's quota is not the text models' quota, and a
    // provider-wide pause here would take every Antigravity text model down for
    // as long as the image window lasts.
    expect(ev[0]).toMatchObject({ type: "error", kind: "rate_limited", retryAfterS: 442209, scope: "model", detail: expect.stringContaining("gemini-3.1-flash-image") });
    // The model inside the image tool, as the backend names it. A successful
    // generation never names it — only the agent, gemini-3.8-flash-low — so
    // the refusal is the one moment it can be recorded.
    expect(ev[0]).toMatchObject({ cliModelId: "gemini-3.1-flash-image" });
    expect(await spy.handles[0]!.result).toMatchObject({ aborted: true, timedOut: false });
    expect(spy.captures).toHaveLength(1);
    expect(spy.captures[0]).toMatchObject({ args: ["b4f58dc5-779c-4b5e-85a3-2fbbce1c9a15"] });
  });
  it("logs but does not fail on a tool error that is not a quota hit", async () => {
    const failedStep = { event: "step_update", step_update: { conversation_id: CID, step_index: 2, state: "ERROR", step_type: "tool", tool_name: "generate_image", tool_info: { name: "generate_image", parameters: {}, error: { type: "TOOL_ERROR", message: "content policy violation" } } } };
    const policy = synthetic([init, toolStep("generate_image", "ACTIVE"), failedStep, result]);
    const ev = await withCollect("none", () => generate(imageProvider(policy)));
    expect(ev).toEqual([{ type: "error", kind: "bad_output", detail: "no image produced" }]);
  });
  it("reports rate_limited when only the agent's prose mentions the quota and no image comes out", async () => {
    const prose = synthetic([
      init,
      { event: "step_update", step_update: { conversation_id: CID, step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "I could not generate the image: quota exhausted, resets in 2h30m." } },
      result,
    ]);
    const spy = spyRunner();
    const ev = await withCollect("none", () => generate(imageProvider(prose, {}, spy)));
    expect(ev).toEqual([{ type: "error", kind: "rate_limited", detail: expect.stringContaining("quota"), retryAfterS: 9000, scope: "model" }]);
    expect(spy.captures).toHaveLength(1); // the conversation directory is still cleaned up
  });
  it("keeps a collected image even when the agent's prose mentions the quota", async () => {
    // The prose is prompt-driven text: an image that came out disproves a quota hit.
    const chatty = synthetic([
      init,
      toolStep("generate_image", "ACTIVE"), toolStep("generate_image", "DONE"),
      { event: "step_update", step_update: { conversation_id: CID, step_index: 3, state: "DONE", step_type: "agent_response", text_delta: "Here is your poster about rate limits: 429 TOO MANY REQUESTS, quota exhausted." } },
      result,
    ]);
    const ev = await generate(imageProvider(chatty));
    expect(ev.map((e) => e.type)).toEqual(["image", "done"]);
  });
  it("rejects a collected file that is too small as bad_output", async () => {
    const ev = await withCollect("tiny", () => generate(imageProvider(IMAGE_RUN)));
    expect(ev).toEqual([{ type: "error", kind: "bad_output", detail: expect.stringMatching(/too small/) }]);
  });
  it("reports bad_output when the run ends cleanly but no image was produced", async () => {
    const ev = await withCollect("none", () => generate(imageProvider(IMAGE_RUN)));
    expect(ev).toEqual([{ type: "error", kind: "bad_output", detail: "no image produced" }]);
  });
  it("aborts the CLI and reports bad_output on a tool call outside allowed_tools", async () => {
    const rogue = synthetic([init, toolStep("run_command", "ACTIVE")]);
    const spy = spyRunner();
    const t0 = Date.now();
    const ev = await generate(imageProvider(rogue, {}, spy, {}, "replay-linger"), undefined, 5);
    expect(ev).toEqual([{ type: "error", kind: "bad_output", detail: "unexpected tool call: run_command" }]);
    expect(await spy.handles[0]!.result).toMatchObject({ aborted: true, timedOut: false });
    expect(Date.now() - t0).toBeLessThan(3000); // killed, not left to the 5 s timeout
    expect(spy.captures).toHaveLength(0);
  });
  it("blocks a tool outside allowed_tools even when it first appears already finished", async () => {
    const rogue = synthetic([init, toolStep("run_command", "DONE"), result]);
    const spy = spyRunner();
    const ev = await generate(imageProvider(rogue, {}, spy));
    expect(ev).toEqual([{ type: "error", kind: "bad_output", detail: "unexpected tool call: run_command" }]);
    expect(spy.captures).toHaveLength(0);
  });
  it("aborts the CLI when an image tool is invoked a second time", async () => {
    const twice = synthetic([init, toolStep("generate_image", "ACTIVE"), toolStep("generate_image", "DONE"), toolStep("generate_image", "ACTIVE", 3)]);
    const spy = spyRunner();
    const t0 = Date.now();
    const ev = await generate(imageProvider(twice, {}, spy, {}, "replay-linger"), undefined, 5);
    expect(ev).toEqual([{ type: "error", kind: "bad_output", detail: "tool called more than once: generate_image" }]);
    expect(await spy.handles[0]!.result).toMatchObject({ aborted: true, timedOut: false });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(spy.captures).toHaveLength(0);
  });
  it("lets a tool listed in allowed_tools through", async () => {
    const other = synthetic([init, toolStep("read_url_content", "DONE"), result]);
    const allowed = { ...agy.image, collect: [COLLECT], allowed_tools: ["generate_image", "read_url_content"] };
    const ev = await generate(imageProvider(other, { image: allowed }));
    expect(ev.map((e) => e.type)).toEqual(["image", "done"]);
  });
  it("reports bad_output when the stream carries no conversation id", async () => {
    const anonymous = synthetic([{ event: "result", result: { status: "SUCCESS", response: "done\n" } }]);
    const spy = spyRunner();
    const ev = await generate(imageProvider(anonymous, {}, spy));
    expect(ev).toEqual([{ type: "error", kind: "bad_output", detail: expect.stringMatching(/conversation id/) }]);
    expect(spy.captures).toHaveLength(0);
  });
  it("never passes a conversation id that is not a UUID to the collect helper", async () => {
    // An adapter without the antigravity check: the id would become argv of a privileged command.
    const loose: Adapter = {
      buildCommand: (cfg) => ({ args: cfg.args, stdin: "" }),
      buildImageCommand: (cfg) => ({ args: cfg.args, stdin: "" }),
      async *parse(lines) {
        for await (const _ of jsonLines(lines)) { /* drain */ }
        yield { type: "meta", conversationId: "--delete-all" };
        yield { type: "done" };
      },
    };
    const spy = spyRunner();
    const ev = await generate(imageProvider(IMAGE_RUN, {}, spy, {}, "replay", loose));
    expect(ev).toEqual([{ type: "error", kind: "bad_output", detail: expect.stringMatching(/conversation id/) }]);
    expect(spy.captures).toHaveLength(0);
  });
  it("names the timeout when the collect helper does not finish in time", async () => {
    const slow = { ...agy.image, allowed_tools: ["generate_image"], collect: ["/bin/sh", "-c", "sleep 5"] };
    const t0 = Date.now();
    const ev = await generate(imageProvider(IMAGE_RUN, { image: slow }, runner, { collectTimeoutMs: 200 }));
    expect(ev).toEqual([{ type: "error", kind: "bad_output", detail: "image collection timed out after 0.2s" }]);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
  it("keeps the collect helper's stderr out of the error detail", async () => {
    const failing = { ...agy.image, allowed_tools: ["generate_image"], collect: ["/bin/sh", "-c", "echo /home/runner/secret >&2; exit 3"] };
    const ev = await generate(imageProvider(IMAGE_RUN, { image: failing }));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: "error", kind: "bad_output" });
    expect((ev[0] as { detail: string }).detail).not.toContain("secret");
  });
  it("forwards the adapter's error event when the CLI reports a failed result", async () => {
    const failed = synthetic([init, { event: "result", result: { conversation_id: CID, status: "ERROR", error: "boom" } }]);
    const spy = spyRunner();
    const ev = await generate(imageProvider(failed, {}, spy));
    expect(ev).toEqual([{ type: "error", kind: "cli_crashed", detail: "boom" }]);
    expect(spy.captures).toHaveLength(0);
  });
  it("uses the model's timeout and reports timeout when the CLI hangs", async () => {
    const t0 = Date.now();
    const ev = await generate(imageProvider(IMAGE_RUN, { timeout_s: 30 }, runner, {}, "hang"), undefined, 1);
    expect(ev).toEqual([{ type: "error", kind: "timeout", detail: "killed after 1s" }]);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  it("stops without an error event when the caller aborts", async () => {
    const spy = spyRunner();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const ev = await generate(imageProvider(IMAGE_RUN, {}, spy, {}, "hang"), ac.signal, 5);
    expect(ev).toEqual([]);
    expect(await spy.handles[0]!.result).toMatchObject({ aborted: true, timedOut: false });
  });
});

describe("buildProviders", () => {
  it("builds one provider per configured id with its concurrency", () => {
    const ps = buildProviders(config, runner, createLogger("t"));
    // Ten runs per CLI, sized from memory (design §4.1): the limit a provider
    // enforces is the configured one, whatever it is.
    expect(ps.map((p) => [p.id, p.concurrencyLimit]).sort()).toEqual([["antigravity", 10], ["claude", 10], ["codex", 10]]);
  });
  it("throws on a provider id without an adapter", () => {
    expect(() => buildProviders({ ...config, providers: { unknown: base } }, runner, createLogger("t"))).toThrow(/no adapter/);
  });
  it("throws when a provider has image models but its adapter cannot generate images", () => {
    // Claude's CLI has no image path. Codex was the example here until it
    // gained one (2026-09-23).
    const claude = config.providers.claude;
    const withImage = {
      ...claude,
      models: { ...claude.models, "claude-image": { cli_model: "opus", effort_suffix: false, kind: "image" as const } },
      image: { ...claude.image, collect: ["/usr/local/bin/capitoline-collect-image"] },
    };
    expect(() => buildProviders({ ...config, providers: { claude: withImage } }, runner, createLogger("t")))
      .toThrow(/provider "claude" has image models but its adapter cannot generate images/);
  });
  it("throws when a provider has image models but no image.collect command", () => {
    const agy = config.providers.antigravity;
    const noCollect = { ...agy, image: { ...agy.image, collect: undefined } };
    expect(() => buildProviders({ ...config, providers: { antigravity: noCollect } }, runner, createLogger("t")))
      .toThrow(/provider "antigravity" has image models but no image.collect command/);
  });
  it("copies kind and timeoutS into the model specs", () => {
    const ps = buildProviders(config, runner, createLogger("t"));
    const agy = ps.find((p) => p.id === "antigravity")!;
    expect(agy.models().find((m) => m.name === "antigravity-image")).toMatchObject({ kind: "image", timeoutS: 240 });
    expect(agy.models().find((m) => m.name === "antigravity-gemini-flash")).toMatchObject({ kind: "text", timeoutS: undefined });
  });
});
