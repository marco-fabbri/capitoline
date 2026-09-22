import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { start } from "../src/main.js";
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
  it("serves all configured models as available after the startup health check, the council among them", async () => {
    const r = await fetch(`http://127.0.0.1:${app.port}/v1/models`);
    const data = ((await r.json()) as { data: { id: string; owned_by: string; capitoline: { kind: string } }[] }).data;
    // The three councils are in the list because main.ts registered every
    // configured one as a virtual model and each one's seats can all be
    // filled: a client asks for any of them in `model` exactly as for the
    // real ones (design §12).
    expect(data.map((m) => m.id).sort()).toEqual(["agy-claude-opus", "agy-claude-sonnet", "agy-gemini-3.6-flash", "agy-gemini-3.7-flash", "agy-gemini-flash", "agy-gemini-flash-high", "agy-gemini-flash-low", "agy-gemini-pro", "agy-gemini-pro-high", "agy-gpt-oss", "agy-image", "capitoline", "capitoline-fast", "capitoline-gemini", "claude-fable", "claude-haiku", "claude-opus", "claude-sonnet", "codex-gpt-5.5", "codex-gpt-5.6-sol", "codex-gpt-6-astra"]);
    // Owned by the gateway and of a kind of their own: they are served by no
    // provider, and their calls are accounted under the models that served
    // them (§12.7).
    for (const name of ["capitoline", "capitoline-fast", "capitoline-gemini"]) {
      expect(data.find((m) => m.id === name), name).toMatchObject({ owned_by: "capitoline", capitoline: { kind: "council" } });
    }
  });
  it.each([["claude-opus", "ok"], ["codex-gpt-5.5", "OK"], ["agy-gemini-flash", "ok ok\n"]])("answers through %s", async (model, expected) => {
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
    expect(data.find((m) => m.id === "agy-image")!.capitoline.quota).toEqual({ used: 0, limit: 12, window_started_at: null });
    expect(kinds["agy-image"]).toBe("image");
    expect(kinds["agy-gemini-3.7-flash"]).toBe("text");
    expect(kinds["agy-gemini-3.6-flash"]).toBe("text");
    expect(kinds["agy-gemini-flash"]).toBe("text");
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

  it("replays the recorded image run when the prompt asks for the generate_image tool", () => {
    // The production prompt itself, so that rewording it breaks this test
    // instead of silently sending the image route back to the chat recording.
    const r = run(userEvent(IMAGE_PROMPT("a lighthouse")));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`"step_type":"tool"`);
    expect(r.stdout).toContain(`"tool_name":"generate_image"`);
    expect(r.stdout).toContain("40fc0b5c-042f-453a-9eaf-6162913de55e");
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

  it("generates an image with the default image model and returns it inline", async () => {
    const r = await post({ prompt: "a lighthouse on a cliff at dawn, watercolour" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { data: { b64_json: string }[]; capitoline: Record<string, unknown> };
    const bytes = Buffer.from(body.data[0].b64_json, "base64");
    // FF D8: the bytes really are the JPEG the collect helper handed over.
    expect(bytes.subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(bytes.equals(SAMPLE)).toBe(true);
    // Exact, not partial: no provider detail (stderr, conversation id, host
    // paths) may leak into the response, here or in the body's top level.
    expect(body.capitoline).toEqual({
      provider: "antigravity", model: "agy-image", mime: "image/jpeg", width: 1376, height: 768, bytes: SAMPLE.length, ignored: [],
    });
    expect(Object.keys(body).sort()).toEqual(["capitoline", "created", "data"]);
  });
  it("ignores size and says so in the header", async () => {
    const r = await post({ prompt: "a lighthouse", size: "1024x1024" });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-capitoline-ignored")).toBe("size");
  });
  it("refuses an image request against a text model", async () => {
    const r = await post({ model: "agy-gemini-flash", prompt: "a lighthouse" });
    expect(r.status).toBe(400);
    // The message pins the refusal to the kind check in core, not to some other
    // bad_request (a zod rejection carries the same code).
    expect((await r.json()) as { error: { code: string; message: string } })
      .toMatchObject({ error: { code: "bad_request", message: expect.stringContaining("use the chat endpoint") } });
  });
  it("refuses a chat request against the image model", async () => {
    const r = await post({ model: "agy-image", messages: [{ role: "user", content: "hi" }] }, "/v1/chat/completions");
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
      ["google", "agy-gemini-pro", ANSWERS.agy],
      ["open-weights", "agy-gpt-oss", ANSWERS.agy],
    ]);
    expect(d.members.every((m) => m.fellBackFrom === undefined)).toBe(true);
    expect(d.lost).toEqual([]);
    expect(d.members.map((m) => m.label).sort()).toEqual(["Response A", "Response B", "Response C", "Response D"]);
    // Every member ranked, and every ranking parsed: the four fake panels
    // answer stage 2 in JSON, so a reply the parser refused would show up
    // here as a missing vote rather than as an error nobody sees.
    expect(d.rankings.map((x) => x.by).sort()).toEqual(["agy-gemini-pro", "agy-gpt-oss", "claude-fable", "codex-gpt-6-astra"]);
    // The aggregate of those four recorded ballots, best first. Exact, and it
    // can be: the recordings are fixed and the averages follow from them,
    // whichever seat each label fell to.
    expect(d.aggregate).toEqual([
      { label: "Response B", averageRank: 1.75, votes: 4 },
      { label: "Response A", averageRank: 2.25, votes: 4 },
      { label: "Response C", averageRank: 2.75, votes: 4 },
      { label: "Response D", averageRank: 3.25, votes: 4 },
    ]);
    // The judge is seated apart from the panel: claude-fable took the
    // Anthropic seat, so the judge's chain steps to claude-opus (§12.3).
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
    // labelled and judged by a model seated apart from them — everything the
    // reference panel does except stage 2.
    expect(d.members.map((m) => [m.family, m.model, m.answer])).toEqual([
      ["anthropic", "claude-fable", ANSWERS.claude],
      ["openai", "codex-gpt-6-astra", ANSWERS.codex],
      ["google", "agy-gemini-pro", ANSWERS.agy],
      ["open-weights", "agy-gpt-oss", ANSWERS.agy],
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
