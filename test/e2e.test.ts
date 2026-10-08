import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { start } from "../src/main.js";
import { loadConfig } from "../src/config.js";
import type { Deliberation } from "../src/council/council.js";
import { STRATEGY_VERSION, answerPrompt, rankingPrompt, synthesisPrompt } from "../src/council/prompts.js";
import { IMAGE_PROMPT } from "../src/providers/antigravity.js";

// Resolved from this module, not from process.cwd(): vitest runs from wherever
// it was invoked, and a path that misses would blow up at import time.
const SAMPLE = readFileSync(fileURLToPath(new URL("fixtures/images/sample.jpg", import.meta.url)));

let app: Awaited<ReturnType<typeof start>>;
// 30 s, not vitest's default 10 s hook timeout: this hook starts the whole
// gateway, sweeps the sandbox root and runs the first health check, which
// spawns three fake CLIs. Under load that can pass 10 s, and the failure would
// then read "hook timed out" with nothing saying which step was slow.
beforeAll(async () => { app = await start("test/e2e.config.yaml", { port: 0 }); }, 30_000);
afterAll(async () => { await app.close(); });

describe("end to end with fake CLIs", () => {
  it("lists the models of Codex and Antigravity by the CLIs' own commands after startup, and finds nothing to change", async () => {
    // The listing runs in the background after readiness (docs/deploy.md §7.2),
    // so it is waited for here rather than assumed.
    type Catalog = { checkedAt: number | null; ok: boolean | null; discovered: string[]; retired: string[]; healthModel: string | null } | null;
    const catalogs = async () => new Map(((await (await fetch(`http://127.0.0.1:${app.port}/health`)).json()) as { providers: { id: string; catalog: Catalog }[] }).providers.map((p) => [p.id, p.catalog]));
    let seen = await catalogs();
    for (let i = 0; i < 100 && (seen.get("codex")?.checkedAt == null || seen.get("antigravity")?.checkedAt == null); i++) {
      await new Promise((r) => setTimeout(r, 100));
      seen = await catalogs();
    }
    expect(seen.get("codex")).toMatchObject({ ok: true, discovered: [], retired: [], healthModel: "codex-gpt-6-luna" });
    expect(seen.get("antigravity")).toMatchObject({ ok: true, discovered: [], retired: [], healthModel: "antigravity-gemini-flash" });
    // Claude's names are aliases that follow the latest model: no catalog.
    expect(seen.get("claude")).toBeNull();
  });
  it("serves all configured models as available after the startup health check, the council among them", async () => {
    const r = await fetch(`http://127.0.0.1:${app.port}/v1/models`);
    const data = ((await r.json()) as { data: { id: string; owned_by: string; capitoline: { kind: string } }[] }).data;
    // The three councils are in the list because main.ts registered every
    // configured one as a virtual model and each one's seats can all be
    // filled: a client asks for any of them in `model` exactly as for the
    // real ones (design §12).
    // Read off the file rather than written out again: what this proves is
    // that the endpoint serves everything the configuration declares and
    // nothing else, and a list typed here would only pin the file's contents a
    // second time — which the CLI-list checks in test/config.test.ts already do
    // against what the three CLIs actually serve.
    const cfg = loadConfig("test/e2e.config.yaml");
    const declared = [...Object.values(cfg.providers).flatMap((p) => Object.keys(p.models)), ...Object.keys(cfg.council)].sort();
    expect(declared.length).toBeGreaterThan(20);
    expect(data.map((m) => m.id).sort()).toEqual(declared);
    // Owned by the gateway and of a kind of their own: they are served by no
    // provider, and their calls are accounted under the models that served
    // them (§12.7).
    for (const name of ["capitoline", "capitoline-fast"]) {
      expect(data.find((m) => m.id === name), name).toMatchObject({ owned_by: "capitoline", capitoline: { kind: "council" } });
    }
  });
  it.each([["claude-opus", "ok"], ["codex-gpt-6-luna", "OK"], ["antigravity-gemini-flash", "ok ok\n"]])("answers through %s", async (model, expected) => {
    const r = await fetch(`http://127.0.0.1:${app.port}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { choices: { message: { content: string } }[]; usage: { total_tokens: number } };
    expect(body.choices[0].message.content).toBe(expected);
    expect(body.usage.total_tokens).toBeGreaterThan(0);
  });
  it("streams through the fake claude", async () => {
    const r = await fetch(`http://127.0.0.1:${app.port}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    // The stream is parsed, not sniffed for its last line: an empty answer, a
    // wrong id per chunk or a missing usage block all ended with "data: [DONE]"
    // just the same, so the trailer alone asserted almost nothing.
    const frames = (await r.text()).split("\n\n").map((f) => f.trim()).filter((f) => f.length > 0);
    expect(frames.every((f) => f.startsWith("data: "))).toBe(true);
    const payloads = frames.map((f) => f.slice("data: ".length));
    expect(payloads.at(-1)).toBe("[DONE]");
    type Chunk = { id: string; object: string; model: string; choices: { delta: { role?: string; content?: string }; finish_reason: string | null }[]; usage?: Record<string, number> };
    const chunks = payloads.slice(0, -1).map((p) => JSON.parse(p) as Chunk);
    expect(chunks.length).toBeGreaterThanOrEqual(3);            // opener, at least one delta, terminator
    expect(chunks.every((c) => c.object === "chat.completion.chunk" && c.model === "claude-opus")).toBe(true);
    expect(new Set(chunks.map((c) => c.id)).size).toBe(1);      // one completion, one id
    // The opener carries the role and no content; only the last chunk finishes.
    expect(chunks[0].choices[0]).toEqual({ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null });
    expect(chunks.slice(0, -1).every((c) => c.choices[0].finish_reason === null)).toBe(true);
    // The recorded fixture's own answer, reassembled from the deltas.
    expect(chunks.slice(1, -1).map((c) => c.choices[0].delta.content).join("")).toBe("ok");
    const last = chunks.at(-1)!;
    expect(last.choices[0]).toEqual({ index: 0, delta: {}, finish_reason: "stop" });
    // Usage rides on the terminating chunk and nowhere else, with the cache
    // tokens of the fixture counted as input (2 + 518 + 2113).
    expect(last.usage).toEqual({ prompt_tokens: 2633, completion_tokens: 4, total_tokens: 2637 });
    expect(chunks.slice(0, -1).every((c) => c.usage === undefined)).toBe(true);
  });
  it("reports the kind of every model, image included", async () => {
    const r = await fetch(`http://127.0.0.1:${app.port}/v1/models`);
    const data = ((await r.json()) as { data: { id: string; capitoline: { kind: string; quota?: { used: number; limit: number | null } } }[] }).data;
    const kinds = Object.fromEntries(data.map((m) => [m.id, m.capitoline.kind]));
    // The configured quota travelled from the YAML through main.ts into Core:
    // a wrong provider key there would leave this null with every unit test
    // still green.
    expect(data.find((m) => m.id === "antigravity-image")!.capitoline.quota).toEqual({ used: 0, limit: 12, window_started_at: null });
    expect(kinds["antigravity-image"]).toBe("image");
    expect(kinds["antigravity-gemini-3.7-flash"]).toBe("text");
    expect(kinds["antigravity-gemini-3.6-flash"]).toBe("text");
    expect(kinds["antigravity-gemini-flash"]).toBe("text");
  });
});

// The fake CLI answers one binary for both kinds of run, as the real `agy` does:
// what it replays is decided by the prompt it is handed on stdin. Without this
// the image route would be exercised against the chat recording, which carries
// no tool step at all.
describe("the fake antigravity CLI picks its recording from the prompt", () => {
  const AGY = fileURLToPath(new URL("fake-cli/fake-agy.sh", import.meta.url));
  const userEvent = (content: string) => JSON.stringify({ event: "user", message: { role: "user", content } }) + "\n";
  const run = (stdin: string) => spawnSync(AGY, ["--output-format", "stream-json"], { input: stdin, encoding: "utf8" });

  it("replays the recorded image run when the prompt is the image prompt", () => {
    // The production prompt itself, so that rewording it breaks this test
    // instead of silently sending the image route back to the chat recording.
    const r = run(userEvent(IMAGE_PROMPT("a lighthouse")));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`"step_type":"subagent"`);
    expect(r.stdout).toContain(`"type_name":"image-generator"`);
    expect(r.stdout).toContain("e0405ad8-9fe1-45e8-9eea-b05629b4c775");
  });
  it("replays the chat stream for an ordinary prompt", () => {
    const r = run(userEvent("hi"));
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(`"step_type":"tool"`);
    expect(r.stdout).toContain("fdc15146-e14d-4592-a062-8bebca386077");
  });
});

describe("image generation end to end", () => {
  // The fake collect helper hands back the sample JPEG only for the conversation
  // id of the recorded image run: if the fake CLI ever replayed the chat stream
  // instead, these tests fail rather than being handed an image out of nowhere.
  beforeAll(() => { process.env.FAKE_COLLECT = "image-run"; });
  afterAll(() => { delete process.env.FAKE_COLLECT; });

  const post = (body: unknown, path = "/v1/images/generations") =>
    fetch(`http://127.0.0.1:${app.port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const SAMPLE_CODEX = readFileSync(fileURLToPath(new URL("./fixtures/images/sample-codex.png", import.meta.url)));

  it("generates an image with the default image model, which is Codex's, and returns it inline", async () => {
    // The default is the first image model a client would see available, and
    // Codex's comes before Antigravity's since 2026-09-23. On purpose: it runs
    // on the larger ChatGPT allowance, and Antigravity's 58 a week stay for the
    // callers that name that model, as app-one does.
    const r = await post({ prompt: "a lighthouse on a cliff at dawn, watercolour" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { data: { b64_json: string }[]; capitoline: Record<string, unknown> };
    const bytes = Buffer.from(body.data[0].b64_json, "base64");
    // 89 50 4E 47: the PNG the collect helper handed over for the recorded thread.
    expect(bytes.subarray(0, 4).toString("hex")).toBe("89504e47");
    expect(bytes.equals(SAMPLE_CODEX)).toBe(true);
    // Exact, not partial: no provider detail (stderr, thread id, host paths)
    // may leak into the response, here or in the body's top level.
    expect(body.capitoline).toEqual({
      provider: "codex", model: "codex-image", mime: "image/png", width: 512, height: 512, bytes: SAMPLE_CODEX.length, ignored: [],
    });
    expect(Object.keys(body).sort()).toEqual(["capitoline", "created", "data"]);
  });
  it("generates an image with Antigravity's model when a client names it", async () => {
    const r = await post({ model: "antigravity-image", prompt: "a lighthouse on a cliff at dawn, watercolour" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { data: { b64_json: string }[]; capitoline: Record<string, unknown> };
    const bytes = Buffer.from(body.data[0].b64_json, "base64");
    // FF D8: the JPEG the collect helper handed over for the recorded conversation.
    expect(bytes.subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(bytes.equals(SAMPLE)).toBe(true);
    expect(body.capitoline).toEqual({
      provider: "antigravity", model: "antigravity-image", mime: "image/jpeg", width: 1376, height: 768, bytes: SAMPLE.length, ignored: [],
    });
  });
  it("ignores size and says so in the header", async () => {
    const r = await post({ prompt: "a lighthouse", size: "1024x1024" });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-capitoline-ignored")).toBe("size");
  });
  it("refuses an image request against a text model", async () => {
    const r = await post({ model: "antigravity-gemini-flash", prompt: "a lighthouse" });
    expect(r.status).toBe(400);
    // The message pins the refusal to the kind check in core, not to some other
    // bad_request (a zod rejection carries the same code).
    expect((await r.json()) as { error: { code: string; message: string } })
      .toMatchObject({ error: { code: "bad_request", message: expect.stringContaining("use the chat endpoint") } });
  });
  it("refuses a chat request against the image model", async () => {
    const r = await post({ model: "antigravity-image", messages: [{ role: "user", content: "hi" }] }, "/v1/chat/completions");
    expect(r.status).toBe(400);
    expect((await r.json()) as { error: { code: string; message: string } })
      .toMatchObject({ error: { code: "bad_request", message: expect.stringContaining("use the images endpoint") } });
  });
});

// --- The council, end to end over the fake CLIs ---------------------------
//
// Everything above this line answers with one model. This is the whole of
// design §12 through the front door: one question in `model: capitoline`,
// nine calls over three fake subscriptions, and an ordinary OpenAI completion
// back. Nothing here knows the council exists — it is the same endpoint, the
// same runner and the same usage table as `claude-opus` above, which is the
// constraint the plan puts above the others: a member's call is a request
// like any other.
const COUNCIL_QUESTION = "Should a seat retry after a refusal?";
// The judge's recording (test/fixtures/claude/council-synthesis.jsonl). It is
// not "ok": the synthesis must be distinguishable from the members' answers,
// or a body that returned one member's text would pass.
const COUNCIL_SYNTHESIS = "Heard, weighed, and answered.";
// What each fake subscription answers a *plain* prompt — the same text the
// tests above read back from a direct request to the same models. That the
// members' answers are these is the assertion that matters: stage 1 went down
// the ordinary path, not one the council built for itself.
const ANSWERS = { claude: "ok", codex: "OK", agy: "ok ok\n" };

describe("a council end to end", () => {
  // Every call of the deliberation is a row, under the real model that served
  // it (§12.7). /v1/usage sums them per caller over 24 h and skips the health
  // probes, so the count before and after is what the question cost — with
  // nobody identified here, one bucket, `caller: null`.
  const rows = async (): Promise<number> => {
    const r = await fetch(`http://127.0.0.1:${app.port}/v1/usage`);
    const { callers } = (await r.json()) as { callers: { calls: number }[] };
    return callers.reduce((n, c) => n + c.calls, 0);
  };

  // 30 s: nine CLI spawns, each in its own sandbox directory, on a machine
  // that is also running the rest of the suite.
  it("seats four families, ranks blind, synthesizes, and writes nine usage rows", async () => {
    const before = await rows();
    const r = await fetch(`http://127.0.0.1:${app.port}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "capitoline", messages: [{ role: "user", content: COUNCIL_QUESTION }] }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      model: string; choices: { message: { content: string } }[]; usage: { total_tokens: number };
      capitoline: { provider: string; council: Deliberation };
    };
    // The synthesis is the message content, and the model is the council: a
    // client that ignores the `capitoline` field cannot tell this from any
    // other completion (§12.6).
    expect(body.model).toBe("capitoline");
    expect(body.choices[0].message.content).toBe(COUNCIL_SYNTHESIS);
    expect(body.capitoline.provider).toBe("capitoline");
    expect(body.usage.total_tokens).toBeGreaterThan(0);

    const d = body.capitoline.council;
    // Four seats, four families, four different subscriptions — and each one
    // answering exactly what it answers a direct request.
    expect(d.members.map((m) => [m.family, m.model, m.answer])).toEqual([
      ["anthropic", "claude-fable", ANSWERS.claude],
      ["openai", "codex-gpt-6-astra", ANSWERS.codex],
      ["google", "antigravity-gemini-pro", ANSWERS.agy],
      ["open-weights", "antigravity-gpt-oss", ANSWERS.agy],
    ]);
    expect(d.members.every((m) => m.fellBackFrom === undefined)).toBe(true);
    expect(d.lost).toEqual([]);
    expect(d.members.map((m) => m.label).sort()).toEqual(["Response A", "Response B", "Response C", "Response D"]);
    // Every member ranked, and every ranking parsed: the four fake panels
    // answer stage 2 in JSON, so a reply the parser refused would show up
    // here as a missing vote rather than as an error nobody sees.
    expect(d.rankings.map((x) => x.by).sort()).toEqual(["antigravity-gemini-pro", "antigravity-gpt-oss", "claude-fable", "codex-gpt-6-astra"]);
    // The aggregate of those four recorded ballots, best first. Exact, and it
    // can be: the recordings are fixed and the averages follow from them,
    // whichever seat each label fell to.
    expect(d.aggregate).toEqual([
      { label: "Response B", averageRank: 1.75, votes: 4 },
      { label: "Response A", averageRank: 2.25, votes: 4 },
      { label: "Response C", averageRank: 2.75, votes: 4 },
      { label: "Response D", averageRank: 3.25, votes: 4 },
    ]);
    // claude-fable took the Anthropic seat, so the head of the judge's chain,
    // claude-opus, sits in no seat and judges from outside (§12.3).
    expect(d.judge).toEqual({ model: "claude-opus", blind: true });
    expect(d.strategyVersion).toBe(STRATEGY_VERSION);
    expect(d.calls).toBe(9);
    expect(d.deliberationId).toEqual(expect.any(String));
    // Nine calls, nine rows: the accounting of §12.7 is the usage table's,
    // not a number the council reports about itself.
    expect((await rows()) - before).toBe(9);
  }, 30_000);

  // The same four seats through the same door, with `ranking: false` in the
  // configuration: the half-price shape is only worth shipping if the saving
  // is real on the usage table, which is what this asserts and what no unit
  // test can (plan 2026-09-22-council-variants, task 2). The fake CLIs need no
  // new fixture: they pick the judge's recording by "You are writing the final
  // answer", a phrase the fast synthesis prompt keeps.
  it("skips the ranking stage for capitoline-fast and writes five usage rows", async () => {
    const before = await rows();
    const r = await fetch(`http://127.0.0.1:${app.port}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "capitoline-fast", messages: [{ role: "user", content: COUNCIL_QUESTION }] }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      model: string; choices: { message: { content: string } }[];
      capitoline: { provider: string; council: Deliberation };
    };
    expect(body.model).toBe("capitoline-fast");
    expect(body.choices[0].message.content).toBe(COUNCIL_SYNTHESIS);

    const d = body.capitoline.council;
    expect(d.shape).toBe("fast");
    // The same four subscriptions answering as they answer a direct request,
    // labelled and judged blind — everything the reference panel does except
    // stage 2.
    expect(d.members.map((m) => [m.family, m.model, m.answer])).toEqual([
      ["anthropic", "claude-fable", ANSWERS.claude],
      ["openai", "codex-gpt-6-astra", ANSWERS.codex],
      ["google", "antigravity-gemini-pro", ANSWERS.agy],
      ["open-weights", "antigravity-gpt-oss", ANSWERS.agy],
    ]);
    expect(d.lost).toEqual([]);
    expect(d.members.map((m) => m.label).sort()).toEqual(["Response A", "Response B", "Response C", "Response D"]);
    expect(d.judge).toEqual({ model: "claude-opus", blind: true });
    // Nobody ranked and nothing was aggregated: not a vote that failed to
    // parse — a ranked panel would still report its four labels with
    // `votes: 0` — but a stage that never ran.
    expect(d.rankings).toEqual([]);
    expect(d.aggregate).toEqual([]);
    expect(d.calls).toBe(5);
    // Five spawns, five rows: the price the shape exists for, read off the
    // usage table and not off the deliberation's own count.
    expect((await rows()) - before).toBe(5);
  }, 30_000);

  // The same five rows from the reference panel asked at `reasoning_effort:
  // low`: the request chose the shape (design §12.9), the response says so,
  // and the field is not among the ignored ones.
  it("runs capitoline as the five-call shape when asked at reasoning_effort low", async () => {
    const before = await rows();
    const r = await fetch(`http://127.0.0.1:${app.port}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "capitoline", reasoning_effort: "low", messages: [{ role: "user", content: COUNCIL_QUESTION }] }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-capitoline-ignored")).toBeNull();
    const body = (await r.json()) as { choices: { message: { content: string } }[]; capitoline: { ignored: string[]; council: Deliberation } };
    expect(body.choices[0].message.content).toBe(COUNCIL_SYNTHESIS);
    expect(body.capitoline.ignored).toEqual([]);
    expect(body.capitoline.council).toMatchObject({ shape: "fast", calls: 5, rankings: [], aggregate: [] });
    expect((await rows()) - before).toBe(5);
  }, 30_000);
});


// The measurement script, against this gateway and the fake CLIs: it is what
// every measurement's evidence comes through, and since 2026-09-27 it streams
// and assembles the answer itself (a 524 from the tunnel's edge cost nine
// calls when it did not), so the assembly is checked against the shape a
// non-streaming answer has. `jq` and `curl` are what the script needs, as
// scripts/smoke.sh does; a machine without them skips this and says so.
describe("scripts/measure-council.sh", () => {
  const have = (bin: string) => spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0;
  it.skipIf(!have("jq") || !have("curl"))("streams a council, keeps the raw stream and assembles the completion", async () => {
    mkdirSync("tmp/e2e-measure", { recursive: true });
    const questions = "tmp/e2e-measure/questions.json";
    writeFileSync(questions, JSON.stringify({ questions: [{ id: "q1", question: COUNCIL_QUESTION }] }));
    const out = "tmp/e2e-measure/results";
    rmSync(out, { recursive: true, force: true });
    // Not spawnSync: the gateway under test runs in this very process, and a
    // synchronous wait would hold the event loop while curl waits for it — a
    // deadlock that ends only at curl's own 1200 s limit.
    const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn("bash", ["scripts/measure-council.sh", `http://127.0.0.1:${app.port}`, questions, out, "capitoline-fast"], { env: { ...process.env, CF_ACCESS_CLIENT_ID: "", CF_ACCESS_CLIENT_SECRET: "" } });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^capitoline-fast  q1  \d+s  calls=5  tokens=\d+  judge=/m);
    const raw = readFileSync(`${out}/capitoline-fast__q1.sse`, "utf8");
    expect(raw.trimEnd().endsWith("data: [DONE]")).toBe(true);
    const body = JSON.parse(readFileSync(`${out}/capitoline-fast__q1.json`, "utf8")) as { object: string; model: string; choices: { message: { content: string }; finish_reason: string }[]; usage: { total_tokens: number }; capitoline: { council: Deliberation } };
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("capitoline-fast");
    expect(body.choices[0].message.content).toBe(COUNCIL_SYNTHESIS);
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage.total_tokens).toBeGreaterThan(0);
    expect(body.capitoline.council).toMatchObject({ shape: "fast", calls: 5 });
    expect(readFileSync(`${out}/run.log`, "utf8")).toMatch(/calls=5/);
  }, 30_000);
});

// No ladder ships: a host adds one to its overlay for as long as a
// measurement runs (docs/measure-a-model.md). This starts a second gateway
// with the guide's own Gemini example as its overlay — the example as
// written, with only the per-stage deadline shortened as every e2e council's
// is — so the recipe the guide hands out is the one proven to deliberate.
describe("a ladder from docs/measure-a-model.md, end to end", () => {
  let ladderApp: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    const guide = readFileSync("docs/measure-a-model.md", "utf8");
    const gemini = /```yaml\n(council:\n  capitoline-gemini:[\s\S]*?)```/.exec(guide);
    expect(gemini, "the guide no longer carries the Gemini ladder").not.toBeNull();
    mkdirSync("tmp", { recursive: true });
    const overlay = "tmp/e2e-ladder-overlay.yaml";
    writeFileSync(overlay, gemini![1].replace(/stage_timeout_s: \d+/, "stage_timeout_s: 20"));
    ladderApp = await start("test/e2e.config.yaml", { port: 0, overlayPath: overlay });
  }, 30_000);
  afterAll(async () => { await ladderApp.close(); });
  const rows = async (): Promise<number> => {
    const r = await fetch(`http://127.0.0.1:${ladderApp.port}/v1/usage`);
    const { callers } = (await r.json()) as { callers: { calls: number }[] };
    return callers.reduce((n, c) => n + c.calls, 0);
  };

  // Three rungs of one lineage on one Antigravity subscription, all starting
  // in the same instant, twice. It is configuration only, so nothing here
  // tests an engine path the panels do not — except the one runtime risk a
  // ladder carries, which no unit test can reach: three `agy` processes at
  // once against the provider's concurrency. A slot short and a rung would
  // wait out server.queue.max_wait_s and be declared lost to queue_full in
  // stage 1, or drop its ballot in stage 2, which is what `lost` and the
  // three rankings below assert. The fake CLIs need no new
  // flag: fake-agy.sh picks its recording from the prompt, never from the
  // model id, so the three rungs replay the same chat and ranking fixtures the
  // panel's Antigravity seats do.
  it("deliberates capitoline-gemini over three rungs of one subscription and writes seven usage rows", async () => {
    const before = await rows();
    const r = await fetch(`http://127.0.0.1:${ladderApp.port}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "capitoline-gemini", messages: [{ role: "user", content: COUNCIL_QUESTION }] }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      model: string; choices: { message: { content: string } }[];
      capitoline: { provider: string; council: Deliberation };
    };
    expect(body.model).toBe("capitoline-gemini");
    expect(body.choices[0].message.content).toBe(COUNCIL_SYNTHESIS);

    const d = body.capitoline.council;
    // The reference panel's shape with a different roster: the blind ranking
    // is the measurement itself here, so `ranking` stays on and the shape is
    // "ranked", not "fast".
    expect(d.shape).toBe("ranked");
    // One seat per rung, the family naming the rung and the model carrying its
    // reasoning level in its own id. All three answer what the same
    // subscription answers a direct request, since only the id differs.
    expect(d.members.map((m) => [m.family, m.model, m.answer])).toEqual([
      ["pro-high", "antigravity-gemini-pro-high", ANSWERS.agy],
      ["flash-high", "antigravity-gemini-flash-high", ANSWERS.agy],
      ["flash-low", "antigravity-gemini-flash-low", ANSWERS.agy],
    ]);
    // No chain on any rung, so a rung that failed could only be lost, never
    // replaced — and with min_members 3 a single loss would have ended the
    // deliberation before the judge. An empty `lost` is therefore also the
    // assertion that the third slot exists.
    expect(d.members.every((m) => m.fellBackFrom === undefined)).toBe(true);
    expect(d.lost).toEqual([]);
    expect(d.members.map((m) => m.label).sort()).toEqual(["Response A", "Response B", "Response C"]);
    // Three ballots cast and three parsed: stage 2 ran three `agy` processes
    // in parallel as stage 1 did, and a rung that had waited out the queue
    // would be missing from this list.
    expect(d.rankings.map((x) => x.by).sort()).toEqual(["antigravity-gemini-flash-high", "antigravity-gemini-flash-low", "antigravity-gemini-pro-high"]);
    expect(d.aggregate).toEqual([
      { label: "Response B", averageRank: 1, votes: 3 },
      { label: "Response A", averageRank: 2, votes: 3 },
      { label: "Response C", averageRank: 3, votes: 3 },
    ]);
    // The head of the judge's chain, seated because no rung can take it: the
    // ladder does not synthesize its own measurement.
    // The ladder opens its judge chain on OpenAI, never on Gemini it is measuring
    expect(d.judge).toEqual({ model: "codex-gpt-6-astra", blind: true });
    // Seven calls: three answers, three rankings, one synthesis — the panel's
    // nine less the seat it does not have, read off the usage table.
    expect(d.calls).toBe(7);
    expect((await rows()) - before).toBe(7);
  }, 30_000);
});

// The three fakes replay one recording per stage, chosen from the prompt they
// are handed — the same trick as the image run above, for the same reason:
// one binary serves all three stages and only the text tells them apart. The
// prompts here are the production ones, so rewording `src/council/prompts.ts`
// breaks this instead of quietly sending stage 2 back to the chat recording,
// where every ranking would fail to parse and the deliberation would degrade
// to "nobody ranked" with nothing in the response saying so.
describe("the fake CLIs pick their council recording from the prompt", () => {
  const SHOWN = [{ label: "Response A", text: "a" }, { label: "Response B", text: "b" }, { label: "Response C", text: "c" }, { label: "Response D", text: "d" }];
  const RANKING = rankingPrompt(COUNCIL_QUESTION, SHOWN, "Response A");
  const SYNTHESIS = synthesisPrompt(COUNCIL_QUESTION, SHOWN, [], true);
  const ANSWER = answerPrompt(COUNCIL_QUESTION);
  const AGY = fileURLToPath(new URL("fake-cli/fake-agy.sh", import.meta.url));
  const CLAUDE = fileURLToPath(new URL("fake-cli/fake-claude.sh", import.meta.url));
  const CODEX = fileURLToPath(new URL("fake-cli/fake-codex.sh", import.meta.url));
  // Each CLI is handed the prompt the way its own adapter sends it: bare on
  // stdin for claude and codex, wrapped in a user event for agy.
  const run = (bin: string, prompt: string) =>
    spawnSync(bin, [], { input: bin === AGY ? JSON.stringify({ event: "user", message: { role: "user", content: prompt } }) + "\n" : prompt, encoding: "utf8" });

  it.each([["claude", CLAUDE], ["codex", CODEX], ["agy", AGY]])("replays a ranking for the ranking prompt through %s", (_name, bin) => {
    const r = run(bin, RANKING);
    expect(r.status).toBe(0);
    // A ranking covering the four labels it was shown, which is what
    // parseRanking demands of a reply it accepts.
    for (const label of ["Response A", "Response B", "Response C", "Response D"]) expect(r.stdout).toContain(label);
    expect(r.stdout).toContain("rank");
  });
  it("replays the synthesis for the judge's prompt through claude, the only family seated as judge", () => {
    const r = run(CLAUDE, SYNTHESIS);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(COUNCIL_SYNTHESIS);
  });
  it.each([["claude", CLAUDE, ANSWERS.claude], ["codex", CODEX, ANSWERS.codex], ["agy", AGY, ANSWERS.agy.trim()]])(
    "replays the ordinary chat recording for a stage 1 answer through %s", (_name, bin, expected) => {
      const r = run(bin, ANSWER);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(expected);
      expect(r.stdout).not.toContain("Response A");
    });
});
