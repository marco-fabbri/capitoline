import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { CliProvider } from "../src/providers/cli-provider.js";
import { buildProviders } from "../src/providers/index.js";
import { claudeAdapter } from "../src/providers/claude.js";
import { jsonLines, type Adapter } from "../src/providers/adapter.js";
import { createRunner, type RunHandle, type Runner } from "../src/runner/runner.js";
import { createLogger } from "../src/log.js";
import { loadConfig } from "../src/config.js";
import type { InternalRequest, ProviderEvent } from "../src/core/types.js";

const FAKE = join(process.cwd(), "test/fake-cli/fake-cli.mjs");
const config = loadConfig("config/capitoline.yaml");
const base = config.providers.claude;
const runner = createRunner({ sandboxRoot: mkdtempSync(join(tmpdir(), "cp-")), user: null, killGraceMs: 200, log: createLogger("t") });

// Wraps the runner so a test can observe the underlying run's result.
function spyRunner(): Runner & { handles: RunHandle[] } {
  const handles: RunHandle[] = [];
  return { handles, async run(spec) { const h = await runner.run(spec); handles.push(h); return h; }, capture: (spec) => runner.capture(spec) };
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
  it("health() fails clearly on an unknown health_model", async () => {
    const h = await provider("replay", { health_model: "nope" }).health();
    expect(h).toMatchObject({ ok: false, kind: "bad_output", detail: expect.stringContaining("nope") });
  });
});

describe("buildProviders", () => {
  it("builds one provider per configured id with its concurrency", () => {
    const ps = buildProviders(config, runner, createLogger("t"));
    expect(ps.map((p) => [p.id, p.concurrencyLimit]).sort()).toEqual([["antigravity", 1], ["claude", 2], ["codex", 1]]);
  });
  it("throws on a provider id without an adapter", () => {
    expect(() => buildProviders({ ...config, providers: { unknown: base } }, runner, createLogger("t"))).toThrow(/no adapter/);
  });
  it("throws when a provider has image models but its adapter cannot generate images", () => {
    const codex = config.providers.codex;
    const withImage = {
      ...codex,
      models: { ...codex.models, "codex-image": { cli_model: "gpt-image", effort_suffix: false, kind: "image" as const } },
      image: { ...codex.image, collect: ["/usr/local/bin/capitoline-collect-image"] },
    };
    expect(() => buildProviders({ ...config, providers: { codex: withImage } }, runner, createLogger("t")))
      .toThrow(/provider "codex" has image models but its adapter cannot generate images/);
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
    expect(agy.models().find((m) => m.name === "agy-image")).toMatchObject({ kind: "image", timeoutS: 240 });
    expect(agy.models().find((m) => m.name === "agy-gemini-flash")).toMatchObject({ kind: "text", timeoutS: undefined });
  });
});
