import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server/app.js";
import { createMcpHandler } from "../src/mcp/server.js";
import { Core } from "../src/core/core.js";
import { UsageStore } from "../src/usage/store.js";
import type { ProviderEvent } from "../src/core/types.js";
import type { CouncilEvent, Deliberation } from "../src/council/council.js";
import pino from "pino";
import { FakeProvider } from "./fake-provider.js";
import { createLogger } from "../src/log.js";
import type { RequestHandler } from "express";
import type { Identity } from "../src/server/access.js";
import request from "supertest";

// A JPEG header is enough for the fake: the tool never inspects the bytes.
const JPEG = Buffer.from("ffd8ffe000104a464946", "hex");
const IMG: ProviderEvent = { type: "image", mime: "image/jpeg", bytes: JPEG, width: 1376, height: 768 };

let server: Server, url: string, provider: FakeProvider, images: FakeProvider, core: Core, usage: UsageStore;
// What the MCP layer logged: a tool error is a warn line, and some of the
// rules under test are about which line an operator ends up reading.
let warnings: Record<string, unknown>[];

// Fresh providers, Core and app per test: a test that scripts a 429 leaves the
// provider paused for days inside Core, which no reassignment of the fake's
// script can undo, and the next generate_image test would silently get a 429.
beforeEach(async () => {
  provider = new FakeProvider("claude", ["claude-opus"], [{ type: "text", delta: "answer" }, { type: "done", usage: { input: 5, output: 1 } }]);
  images = new FakeProvider("antigravity", [{ name: "agy-image", kind: "image" }], []);
  images.imageScript = [{ type: "text", delta: "saved as ./image.png" }, IMG, { type: "done" }];
  usage = new UsageStore(":memory:");
  core = new Core([provider, images], usage, { maxWaitMs: 100, budgets: {}, log: createLogger("t") });
  warnings = [];
  const mcpLog = pino({ name: "t", level: "warn" }, { write: (line: string) => { warnings.push(JSON.parse(line) as Record<string, unknown>); } });
  // /mcp sits behind Access in production, so the handler sees an identity:
  // the service token Claude Code is configured with. This stub authenticates
  // every request — it is here for attribution, not for placement, which the
  // last test of this file and test/server.test.ts pin with a denying one.
  const identity: Identity = { sub: "", type: "service", name: "claude-code" };
  const access: RequestHandler = (_req, res, next) => { res.locals.identity = identity; next(); };
  const app = createApp(core, { log: createLogger("t"), access, mcp: createMcpHandler(core, mcpLog, { progressIntervalMs: 20 }) });
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
});
// closeAllConnections: a test that hangs up mid-call leaves a socket the
// server would otherwise wait on forever.
afterEach(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));

async function client() {
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(url)));
  return c;
}

type Block = { type: string; text?: string; data?: string; mimeType?: string };

describe("MCP", () => {
  it("lists the four tools", async () => {
    const c = await client();
    const tools = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["ask_council", "ask_model", "generate_image", "list_models"]);
    await c.close();
  });
  it("list_models returns the registry with each model's kind", async () => {
    const c = await client();
    const r = await c.callTool({ name: "list_models", arguments: {} });
    const text = (r.content as { type: string; text: string }[])[0].text;
    expect(JSON.parse(text)).toEqual([
      { name: "claude-opus", provider: "claude", kind: "text", available: true, over_budget: false },
      { name: "agy-image", provider: "antigravity", kind: "image", available: true, over_budget: false, quota: { used: 0, limit: null, windowStartedAt: null, resetAt: null } },
    ]);
    await c.close();
  });
  it("list_models still carries the quota, with its reset, once the image quota is exhausted", async () => {
    images.imageScript = [{ type: "error", kind: "rate_limited", detail: "429", retryAfterS: 442_209 }];
    const sent = Date.now();
    const c = await client();
    await c.callTool({ name: "generate_image", arguments: { prompt: "a lighthouse", model: "agy-image" } });
    const r = await c.callTool({ name: "list_models", arguments: {} });
    const models = JSON.parse((r.content as Block[])[0].text!) as { name: string; available: boolean; reason?: string; quota?: { resetAt: number | null } }[];
    const image = models.find((m) => m.name === "agy-image")!;
    // /v1/models drops an unavailable model, so this tool is where a client
    // reads when the exhausted quota frees up.
    expect(image).toMatchObject({ available: false, reason: "rate_limited" });
    expect(image.quota!.resetAt).toBeGreaterThanOrEqual(sent + 442_209 * 1000);
    await c.close();
  });
  it("ask_model returns the answer, usage and passes effort and system", async () => {
    const c = await client();
    const r = await c.callTool({ name: "ask_model", arguments: { model: "claude-opus", prompt: "q", effort: "low", system: "S" } });
    expect((r.content as { text: string }[])[0].text).toBe("answer");
    // The same answer on both sides: the text block for a client that reads
    // the content, `text` for one that reads the structured object (#1).
    expect(r.structuredContent).toEqual({ text: "answer", model: "claude-opus", provider: "claude", usage: { prompt_tokens: 5, completion_tokens: 1 } });
    expect(provider.calls.at(-1)!.messages).toEqual([{ role: "system", text: "S" }, { role: "user", text: "q" }]);
    expect(provider.calls.at(-1)!.effort).toBe("low");
    await c.close();
  });

  // #1: as soon as a tool declares an output schema the client reads
  // structuredContent and ignores the content blocks — which is what Claude
  // Code does, and why the answer never reached it while the server was
  // formally sending both. This test reads the structured object alone, the
  // way that client does, and never the text block.
  it("carries the answer in structuredContent, for a client that reads nothing else", async () => {
    const c = await client();
    // listTools first: the SDK client caches the output validator from it, so
    // a structured object that does not match the declared schema is caught
    // here instead of reaching a real client.
    await c.listTools();
    const r = await c.callTool({ name: "ask_model", arguments: { model: "claude-opus", prompt: "q" } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ text: "answer", model: "claude-opus", provider: "claude", usage: { prompt_tokens: 5, completion_tokens: 1 } });
    await c.close();
  });
  it("ask_model refuses an image model as a tool error", async () => {
    const c = await client();
    const r = await c.callTool({ name: "ask_model", arguments: { model: "agy-image", prompt: "q" } });
    expect(r.isError).toBe(true);
    // The reason, not only the kind: it is Capitoline's own text (spec 8.3
    // covers CLI output), and it is what lets the agent pick another model.
    expect((r.content as Block[])[0].text).toMatch(/bad_request.*generates images/);
    // execute() is the call the kind guard must stop: imageCalls could never
    // grow here, whether or not the guard exists.
    expect(images.calls).toHaveLength(0);
    await c.close();
  });

  it("ask_model refuses a council and sends the caller to the tool that reports the stages", async () => {
    // A deliberation is nine calls over several minutes, and the only progress
    // ask_model can send counts the characters of the text it is receiving:
    // nothing at all while the first two stages run, which is the silence
    // §12.6 exists to avoid in Claude Code. ask_council is where it belongs.
    let started = false;
    core.registerVirtual("capitoline", async function* () { started = true; yield { type: "text", delta: "the synthesis" }; });
    const c = await client();
    const r = await c.callTool({ name: "ask_model", arguments: { model: "capitoline", prompt: "q" } });
    expect(r.isError).toBe(true);
    expect((r.content as Block[])[0].text).toMatch(/bad_request.*council.*ask_council/);
    expect(started).toBe(false);
    await c.close();
  });

  it("list_models names the council's kind beside the other two", async () => {
    core.registerVirtual("capitoline", async function* () { yield { type: "text", delta: "the synthesis" }; });
    const c = await client();
    const listed = (await c.listTools()).tools.find((t) => t.name === "list_models")!;
    expect(listed.description).toMatch(/text, image or council/);
    const r = await c.callTool({ name: "list_models", arguments: {} });
    const models = JSON.parse((r.content as Block[])[0].text!) as { name: string; kind: string }[];
    expect(models.find((m) => m.name === "capitoline")!.kind).toBe("council");
    await c.close();
  });

  describe("ask_council", () => {
    // A deliberation the transport has nothing to do with: the MCP layer's job
    // is to render these events, and a real Council is exercised by
    // test/council.test.ts and end to end by test/e2e.test.ts. What is scripted
    // here is one of every event the council can emit, in the order §12.1 emits
    // them, plus the un-blinded record §12.6 puts in front of the client.
    const DETAIL: Deliberation = {
      deliberationId: "d-1",
      strategyVersion: 1,
      shape: "ranked",
      members: [
        { family: "anthropic", model: "claude-opus", label: "Response A", answer: "the first answer" },
        { family: "openai", model: "codex-gpt-5.5", label: "Response B", answer: "the second answer", fellBackFrom: ["codex-gpt-6-astra (rate_limited)"] },
      ],
      lost: [{ family: "google", model: "agy-gemini-pro", reason: "timeout" }],
      rankings: [{ by: "claude-opus", ranking: [{ label: "Response B", rank: 1, reason: "clearer" }, { label: "Response A", rank: 2, reason: "mine" }] }],
      aggregate: [{ label: "Response B", averageRank: 1, votes: 1 }, { label: "Response A", averageRank: 2, votes: 1 }],
      judge: { model: "claude-haiku", blind: true },
      calls: 5,
    };
    const RUN: CouncilEvent[] = [
      { type: "progress", stage: "answers", done: 0, total: 2 },
      { type: "progress", stage: "answers", done: 1, total: 2 },
      { type: "progress", stage: "answers", done: 2, total: 2 },
      { type: "progress", stage: "rankings", done: 0, total: 2 },
      { type: "progress", stage: "rankings", done: 2, total: 2 },
      { type: "progress", stage: "synthesis", done: 0, total: 1 },
      { type: "text", delta: "the " }, { type: "text", delta: "synthesis" },
      { type: "progress", stage: "synthesis", done: 1, total: 1 },
      { type: "done", usage: { input: 30, output: 12 }, detail: DETAIL },
    ];
    // What the council was asked and under whose identity: a member call is an
    // ordinary request, so the caller /v1/usage groups by has to survive the
    // tool call (see "records the caller of a tool call" above).
    let asked: { question: string; source: string; caller?: string | null }[];
    const register = (events: CouncilEvent[] = RUN, name = "capitoline") => {
      core.registerVirtual(name, async function* (question, ctx) {
        asked.push({ question, source: ctx.source, caller: ctx.caller });
        for (const ev of events) { await new Promise((r) => setTimeout(r, 1)); yield ev; }
      });
    };
    beforeEach(() => { asked = []; });

    it("is listed with a description that says what a deliberation costs", async () => {
      const c = await client();
      const tool = (await c.listTools()).tools.find((t) => t.name === "ask_council")!;
      expect(tool.description).toMatch(/council/i);
      // The agent decides between this tool and ask_model on the description
      // alone: nine calls over several minutes is the whole difference.
      expect(tool.description).toMatch(/nine/);
      expect(Object.keys(tool.inputSchema.properties!).sort()).toEqual(["council", "question"]);
      await c.close();
    });

    it("returns the synthesis as text and the deliberation as structured content", async () => {
      register();
      const c = await client();
      const r = await c.callTool({ name: "ask_council", arguments: { question: "why?" } });
      expect(r.isError).toBeFalsy();
      expect((r.content as Block[])[0].text).toBe("the synthesis");
      expect(r.structuredContent).toEqual({
        // The synthesis travels here as well as in the text block: the seats
        // were already in members[].answer, and a client that reads only the
        // structured object was getting every answer but the final one (#1).
        synthesis: "the synthesis",
        council: "capitoline",
        deliberation_id: "d-1",
        strategy_version: 1,
        // The shape travels where the individual rankings do not: an empty
        // aggregate is a fast council here and a panel whose votes all failed
        // there, and the caller reads only this field to tell them apart.
        shape: "ranked",
        members: DETAIL.members,
        // §12.5: a member that was dropped is declared, here as everywhere else.
        lost: DETAIL.lost,
        aggregate: DETAIL.aggregate,
        judge: { model: "claude-haiku", blind: true },
        usage: { prompt_tokens: 30, completion_tokens: 12 },
        calls: 5,
      });
      expect(asked).toEqual([{ question: "why?", source: "mcp", caller: "claude-code" }]);
      await c.close();
    });

    // #1: the schema already carried members[].answer, so the seats survived a
    // client that reads only structuredContent while the synthesis — the reason
    // the question was put to a council at all — did not. It travels as a field
    // of its own, read here without touching the content blocks.
    it("carries the synthesis in structuredContent, for a client that reads nothing else", async () => {
      register();
      const c = await client();
      await c.listTools();
      const r = await c.callTool({ name: "ask_council", arguments: { question: "why?" } });
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent).toMatchObject({ synthesis: "the synthesis", council: "capitoline", members: DETAIL.members });
      await c.close();
    });

    // The default is "the first available council", not "the first council":
    // a panel declared first that cannot fill its quorum must not swallow the
    // question, while a panel that is the only one left must still answer with
    // its own refusal (the test below) rather than with "no council".
    it("defaults to the first available council, not to the first declared one", async () => {
      core.registerVirtual("senate", async function* () { yield { type: "text", delta: "x" }; },
        () => ({ available: false, reason: "only 1 of 4 seats can be filled: the quorum is 2" }));
      register(RUN, "capitoline");
      const c = await client();
      const r = await c.callTool({ name: "ask_council", arguments: { question: "why?" } });
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent).toMatchObject({ council: "capitoline" });
      await c.close();
    });

    // A misspelled council is an unknown name, not a model: sending it to
    // ask_model would only earn it a second refusal there.
    it("answers a misspelled council name as an unknown model, with the name", async () => {
      register();
      const c = await client();
      const r = await c.callTool({ name: "ask_council", arguments: { question: "why?", council: "capitolin" } });
      expect(r.isError).toBe(true);
      const text = (r.content as Block[])[0].text!;
      expect(text).toMatch(/unknown_model.*capitolin/);
      expect(text).not.toMatch(/ask_model/);
      expect(asked).toHaveLength(0);
      await c.close();
    });

    // §12.5: with one surviving answer there is nothing to rank and no judge
    // is seated, so the gateway hands back that answer and says plainly that no
    // council took place. structuredContent drops `rankings`, so an MCP caller
    // reads that only in the empty aggregate and the empty judge model: the
    // text block alone is indistinguishable from a synthesis.
    it("carries the shape that says no council took place: no aggregate, no judge", async () => {
      const alone: Deliberation = { ...DETAIL, members: [DETAIL.members[0]], lost: [], rankings: [], aggregate: [], judge: { model: "", blind: true }, calls: 1 };
      register([
        { type: "progress", stage: "answers", done: 1, total: 1 },
        { type: "text", delta: "the first answer" },
        { type: "done", usage: { input: 3, output: 4 }, detail: alone },
      ]);
      const c = await client();
      const r = await c.callTool({ name: "ask_council", arguments: { question: "why?" } });
      expect(r.isError).toBeFalsy();
      expect((r.content as Block[])[0].text).toBe("the first answer");
      expect(r.structuredContent).toMatchObject({ members: [DETAIL.members[0]], aggregate: [], judge: { model: "", blind: true }, calls: 1 });
      await c.close();
    });

    it("refuses a real model, and says which tool takes one", async () => {
      const c = await client();
      const r = await c.callTool({ name: "ask_council", arguments: { question: "why?", council: "claude-opus" } });
      expect(r.isError).toBe(true);
      expect((r.content as Block[])[0].text).toMatch(/bad_request.*not a council.*ask_model/);
      expect(provider.calls).toHaveLength(0);
      await c.close();
    });

    it("reports nothing to deliberate with when no council is configured", async () => {
      const c = await client();
      const r = await c.callTool({ name: "ask_council", arguments: { question: "why?" } });
      expect(r.isError).toBe(true);
      expect((r.content as Block[])[0].text).toMatch(/bad_request.*no council/);
      await c.close();
    });

    // §12.6: the two silent stages are what the progress exists for — the only
    // thing the agent, and the operator watching it, can read while the panel
    // works. It extends no deadline by itself: a notification restarts the tool
    // timeout only in a client that sets resetTimeoutOnProgress, off by default
    // in the MCP TypeScript SDK (spec §6.2), so a multi-minute deliberation is
    // carried by the raised MCP_TOOL_TIMEOUT of docs/deploy.md §10.
    it("turns every stage event into a progress notification, with values that always increase", async () => {
      register();
      const c = await client();
      const seen: { progress: number; message?: string }[] = [];
      const r = await c.callTool({ name: "ask_council", arguments: { question: "why?" } }, undefined, { onprogress: (p) => { seen.push({ progress: p.progress, message: p.message }); } });
      expect(r.isError).toBeFalsy();
      // One per stage event, plus the completion. The stage counters restart at
      // every stage (answers 2/2 then rankings 0/2), so the notification value
      // cannot be one of them: it is a sequence of its own.
      expect(seen.map((p) => p.message)).toEqual([
        "answers 0/2", "answers 1/2", "answers 2/2",
        "rankings 0/2", "rankings 2/2",
        "synthesis 0/1", "synthesis 1/1", "done",
      ]);
      expect(seen.every((p, i) => i === 0 || p.progress > seen[i - 1].progress)).toBe(true);
      await c.close();
    });

    it("sends no progress notification when the client did not ask for one", async () => {
      register();
      const c = await client();
      const seen: unknown[] = [];
      c.fallbackNotificationHandler = async (n) => { seen.push(n); };
      const r = await c.callTool({ name: "ask_council", arguments: { question: "why?" } });
      expect(r.isError).toBeFalsy();
      expect(seen).toHaveLength(0);
      await c.close();
    });

    // A synthesis is the one stage that streams, and it can run for minutes
    // with no stage event of its own: the character count is the sign of life
    // in between, exactly as ask_model does it.
    it("marks the synthesis as it is written, so a long one is not silent", async () => {
      const long: CouncilEvent[] = [
        { type: "progress", stage: "synthesis", done: 0, total: 1 },
        ...Array.from({ length: 40 }, (): CouncilEvent => ({ type: "text", delta: "x" })),
        { type: "done", usage: { input: 1, output: 1 }, detail: DETAIL },
      ];
      register(long);
      const c = await client();
      const seen: { progress: number; message?: string }[] = [];
      await c.callTool({ name: "ask_council", arguments: { question: "why?" } }, undefined, { onprogress: (p) => { seen.push({ progress: p.progress, message: p.message }); } });
      expect(seen.map((p) => p.message)).toEqual(["synthesis 0/1", "writing, 20 chars", "writing, 40 chars", "done"]);
      expect(seen.every((p, i) => i === 0 || p.progress > seen[i - 1].progress)).toBe(true);
      await c.close();
    });

    // The kind and the wait, never the council's own account of which seats it
    // lost: that account names providers and carries their words (spec 8.3),
    // and the Council has already written it to the log with the seats.
    it("returns a failed council as a tool error carrying the kind alone", async () => {
      register([
        { type: "progress", stage: "answers", done: 0, total: 2 },
        { type: "error", kind: "rate_limited", detail: "no member answered: anthropic 429 upstream body", retryAfterS: 90 },
      ]);
      const c = await client();
      const r = await c.callTool({ name: "ask_council", arguments: { question: "why?" } });
      expect(r.isError).toBe(true);
      const text = (r.content as Block[])[0].text!;
      expect(text).toMatch(/rate_limited/);
      expect(Number(/retry after (\d+)s/.exec(text)![1])).toBe(90);
      expect(text).not.toContain("upstream body");
      expect(text).not.toContain("anthropic");
      await c.close();
    });

    // queue_full and model_unavailable are not provider errors: a council
    // refused by the gateway must reach the caller as itself, which is why the
    // event carries a FailureKind and the tool passes it through untouched.
    it("passes a gateway refusal through under its own kind", async () => {
      register([{ type: "error", kind: "queue_full", detail: "the provider queue did not open" }]);
      const c = await client();
      const r = await c.callTool({ name: "ask_council", arguments: { question: "why?" } });
      expect(r.isError).toBe(true);
      expect((r.content as Block[])[0].text).toMatch(/queue_full/);
      await c.close();
    });

    // The gate Core puts in front of a council (§12.5, spec 6.1): the quorum is
    // decided before the tool spends the one call it could still make.
    it("refuses a council whose quorum cannot be filled, before any call", async () => {
      let started = false;
      core.registerVirtual("capitoline", async function* () { started = true; yield { type: "text", delta: "x" }; },
        () => ({ available: false, reason: "only 1 of 4 seats can be filled: the quorum is 2" }));
      const c = await client();
      const r = await c.callTool({ name: "ask_council", arguments: { question: "why?" } });
      expect(r.isError).toBe(true);
      expect((r.content as Block[])[0].text).toMatch(/model_unavailable/);
      expect(started).toBe(false);
      await c.close();
    });

    it("refuses a question that is only whitespace", async () => {
      register();
      const c = await client();
      const r = await c.callTool({ name: "ask_council", arguments: { question: "   " } });
      expect(r.isError).toBe(true);
      expect((r.content as Block[])[0].text).toMatch(/bad_request/);
      expect(asked).toHaveLength(0);
      await c.close();
    });

    // A client that hangs up mid-deliberation is not a broken council: Core has
    // already recorded every call it made as aborted, and the operator must not
    // read a warn line hunting for a council that never finished.
    it("answers a cancelled call as cancelled, and logs nothing", async () => {
      // The fake stops the way Council.deliberate stops on an abort: no done
      // event, no error event. A fake that yielded `done` anyway would leave
      // the handler with a detail and never reach the guard under test, and
      // the test would keep passing with that guard deleted.
      core.registerVirtual("capitoline", async function* (_q, ctx) {
        yield { type: "progress", stage: "answers", done: 0, total: 2 };
        await new Promise((r) => setTimeout(r, 200));
        if (ctx.signal?.aborted) return;
        yield { type: "done", usage: { input: 1, output: 1 }, detail: DETAIL };
      });
      const c = await client();
      const call = c.callTool({ name: "ask_council", arguments: { question: "why?" } });
      setTimeout(() => { void c.close(); }, 50);
      await expect(call).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 300));
      expect(warnings).toHaveLength(0);
    });
  });

  // B5: the MCP spec requires the progress value of every notification to be
  // larger than the one before. Forty text events is the case that breaks the
  // event count: the last periodic mark lands on event 40 and the completion
  // notification follows it with the same number. Forty-five would pass
  // whatever the implementation does (20, 40, 45), which is why this script is
  // a multiple of the interval.
  it("sends ask_model progress values that always increase", async () => {
    provider.script = [
      ...Array.from({ length: 40 }, (): ProviderEvent => ({ type: "text", delta: "x" })),
      { type: "done", usage: { input: 5, output: 1 } },
    ];
    const c = await client();
    const seen: number[] = [];
    const r = await c.callTool({ name: "ask_model", arguments: { model: "claude-opus", prompt: "q" } }, undefined, { onprogress: (p) => { seen.push(p.progress); } });
    expect(r.isError).toBeFalsy();
    // Two periodic marks and the completion.
    expect(seen).toHaveLength(3);
    expect(seen.every((v, i) => i === 0 || v > seen[i - 1])).toBe(true);
    await c.close();
  });

  // B5: the HTTP layer logs the provider's detail on a "provider error" line
  // and sends the client the kind alone (spec 8.3). The MCP path was throwing
  // the kind twice and dropping the detail, so the one line an operator has to
  // diagnose a broken CLI existed only for HTTP callers.
  it("logs the provider detail on the MCP path and keeps it out of the tool error", async () => {
    const detail = "Traceback (most recent call last): /home/runner/.claude/secret";
    provider.script = [{ type: "error", kind: "cli_crashed", detail }];
    const c = await client();
    const r = await c.callTool({ name: "ask_model", arguments: { model: "claude-opus", prompt: "q" } });
    expect(r.isError).toBe(true);
    const text = (r.content as Block[])[0].text!;
    expect(text).toMatch(/cli_crashed/);
    expect(text).not.toContain("Traceback");
    expect(warnings.find((w) => w.msg === "provider error")).toMatchObject({ kind: "cli_crashed", model: "claude-opus", detail });
    await c.close();
  });

  describe("generate_image", () => {
    it("returns the image as an image block plus a text line describing it, without the agent's prose", async () => {
      const c = await client();
      const r = await c.callTool({ name: "generate_image", arguments: { prompt: "a lighthouse", model: "agy-image" } });
      expect(r.isError).toBeFalsy();
      const content = r.content as Block[];
      expect(content).toHaveLength(2);
      expect(content[0].type).toBe("image");
      expect(content[0].mimeType).toBe("image/jpeg");
      expect(Buffer.from(content[0].data!, "base64")).toEqual(JPEG);
      expect(JSON.stringify(r)).not.toContain("./image.png");
      // The description the output schema used to carry, unchanged, in the
      // one place an image can travel with it (#1).
      expect(JSON.parse(content[1].text!)).toEqual({ model: "agy-image", provider: "antigravity", mime: "image/jpeg", width: 1376, height: 768, bytes: JPEG.length });
      expect(images.imageCalls.at(-1)).toEqual({ model: "agy-image", prompt: "a lighthouse" });
      await c.close();
    });
    // #1: an image content block cannot live inside structuredContent, so this
    // is the one tool that gives its output schema up: with none declared the
    // client has no structured object to prefer and reads the content blocks,
    // the way it already reads list_models. What the structured object used to
    // say travels as a text block beside the image.
    it("declares no output schema, so the image survives in the content blocks", async () => {
      const c = await client();
      const tool = (await c.listTools()).tools.find((t) => t.name === "generate_image")!;
      expect(tool.outputSchema).toBeUndefined();
      const r = await c.callTool({ name: "generate_image", arguments: { prompt: "a lighthouse", model: "agy-image" } });
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent).toBeUndefined();
      const content = r.content as Block[];
      expect(content.map((b) => b.type)).toEqual(["image", "text"]);
      expect(Buffer.from(content[0].data!, "base64")).toEqual(JPEG);
      expect(JSON.parse(content[1].text!)).toEqual({ model: "agy-image", provider: "antigravity", mime: "image/jpeg", width: 1376, height: 768, bytes: JPEG.length });
      await c.close();
    });

    it("defaults to the first image model when model is omitted", async () => {
      const c = await client();
      const r = await c.callTool({ name: "generate_image", arguments: { prompt: "a lighthouse" } });
      expect(r.isError).toBeFalsy();
      // Which model the default landed on is read off the text block: this
      // tool has no structured object to read it from any more.
      expect(JSON.parse((r.content as Block[])[1].text!)).toMatchObject({ model: "agy-image", provider: "antigravity" });
      expect(images.imageCalls.at(-1)).toEqual({ model: "agy-image", prompt: "a lighthouse" });
      await c.close();
    });
    it("still defaults to a declared image model when no image model is available", async () => {
      images.imageScript = [{ type: "error", kind: "rate_limited", detail: "429", retryAfterS: 30 }];
      const c = await client();
      await c.callTool({ name: "generate_image", arguments: { prompt: "a lighthouse", model: "agy-image" } });
      // agy-image is now unavailable (its provider is paused). The default must
      // still land on it, so the caller gets that provider's own 429 rather
      // than "no image model is configured", which would be a wrong diagnosis.
      const r = await c.callTool({ name: "generate_image", arguments: { prompt: "a lighthouse" } });
      expect(r.isError).toBe(true);
      expect((r.content as Block[])[0].text).toMatch(/rate_limited/);
      expect(images.imageCalls).toHaveLength(1);
      await c.close();
    });
    it("refuses an empty prompt", async () => {
      const c = await client();
      const r = await c.callTool({ name: "generate_image", arguments: { prompt: "" } });
      expect(r.isError).toBe(true);
      expect(images.imageCalls).toHaveLength(0);
      await c.close();
    });
    it("refuses an empty model in the schema, not as a missing default", async () => {
      const c = await client();
      const r = await c.callTool({ name: "generate_image", arguments: { prompt: "a lighthouse", model: "" } });
      expect(r.isError).toBe(true);
      expect((r.content as Block[])[0].text).toMatch(/model/);
      expect((r.content as Block[])[0].text).not.toMatch(/no image model is configured/);
      expect(images.imageCalls).toHaveLength(0);
      await c.close();
    });
    it("refuses a text model as a tool error", async () => {
      const c = await client();
      // The distinctive reason, not just the kind: "provider cannot generate
      // images" is bad_request too and would hide a missing kind check.
      const r = await c.callTool({ name: "generate_image", arguments: { prompt: "a lighthouse", model: "claude-opus" } });
      expect(r.isError).toBe(true);
      expect((r.content as Block[])[0].text).toMatch(/bad_request.*is a text model/);
      await c.close();
    });
    it("refuses a council, and names the tool that runs one", async () => {
      // Core.lookup would answer "use the chat endpoint" here: HTTP advice that
      // names nothing an MCP client can call, and the wrong name now that
      // ask_council exists.
      core.registerVirtual("capitoline", async function* () { yield { type: "text", delta: "the synthesis" }; });
      const c = await client();
      const r = await c.callTool({ name: "generate_image", arguments: { prompt: "a lighthouse", model: "capitoline" } });
      expect(r.isError).toBe(true);
      expect((r.content as Block[])[0].text).toMatch(/bad_request.*council.*ask_council/);
      expect(images.imageCalls).toHaveLength(0);
      await c.close();
    });
    it("reports a provider that ends without an image as bad_output", async () => {
      images.imageScript = [{ type: "text", delta: "I could not draw that" }, { type: "done" }];
      const c = await client();
      const r = await c.callTool({ name: "generate_image", arguments: { prompt: "a lighthouse" } });
      expect(r.isError).toBe(true);
      expect((r.content as Block[])[0].text).toMatch(/bad_output/);
      await c.close();
    });
    it("answers a cancelled call as cancelled, not as a provider that returned no image", async () => {
      // A cancelled generation and a broken one look the same from the loop:
      // no image event, no error event. The script has no image at all, so a
      // handler that ignored the signal would log bad_output here.
      images.imageScript = [{ type: "text", delta: "drawing" }, { type: "done" }];
      images.delayMs = 100;
      const c = await client();
      // The client hangs up while the CLI is still drawing (Esc in Claude
      // Code): the transport closes and the SDK aborts the handler's signal.
      const call = c.callTool({ name: "generate_image", arguments: { prompt: "a lighthouse" } });
      setTimeout(() => { void c.close(); }, 50);
      await expect(call).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 250)); // let the handler finish
      expect(warnings).toHaveLength(0);
    });
    it("sends progress notifications while the generation runs, when the client asked for them", async () => {
      images.delayMs = 60;
      const c = await client();
      const seen: number[] = [];
      const r = await c.callTool({ name: "generate_image", arguments: { prompt: "a lighthouse" } }, undefined, { onprogress: (p) => { seen.push(p.progress); } });
      expect(r.isError).toBeFalsy();
      expect(seen.length).toBeGreaterThanOrEqual(2);
      expect(seen).toEqual([...seen].sort((a, b) => a - b));
      await c.close();
    });
    it("sends no progress notification when the client did not ask for one", async () => {
      images.delayMs = 60; // long enough for several ticks of the 20 ms timer
      const c = await client();
      const seen: unknown[] = [];
      c.fallbackNotificationHandler = async (n) => { seen.push(n); };
      const r = await c.callTool({ name: "generate_image", arguments: { prompt: "a lighthouse" } });
      expect(r.isError).toBeFalsy();
      expect(seen).toHaveLength(0);
      await c.close();
    });
    it("reports a rate limit as a tool error with the wait Core installed", async () => {
      images.imageScript = [{ type: "error", kind: "rate_limited", detail: "429 secret body", retryAfterS: 442_209 }];
      const c = await client();
      const r = await c.callTool({ name: "generate_image", arguments: { prompt: "a lighthouse" } });
      expect(r.isError).toBe(true);
      const text = (r.content as Block[])[0].text!;
      expect(text).toMatch(/rate_limited/);
      // The pause Core installed (the CLI's figure plus its minute of slack),
      // not the raw 442_209 the provider reported.
      expect(Number(/retry after (\d+)s/.exec(text)![1])).toBe(442_269);
      expect(text).not.toContain("secret body");
      await c.close();
    });
  });

  it("puts the model's own pause in the retry hint when the refusal named the model", async () => {
    // Same rule as the HTTP layer: the pause landed on the model alone, so
    // only core.pauseRemainingS(provider, model) sees it. Without the model
    // the hint would be the CLI's raw 10 s and the caller would retry into a
    // pause that still has a minute to run.
    provider.script = [{ type: "error", kind: "rate_limited", detail: "reached your claude-opus limit", scope: "model", retryAfterS: 10 }];
    const c = await client();
    const r = await c.callTool({ name: "ask_model", arguments: { model: "claude-opus", prompt: "q" } });
    expect(r.isError).toBe(true);
    const text = (r.content as Block[])[0].text!;
    expect(text).toMatch(/rate_limited/);
    expect(Number(/retry after (\d+)s/.exec(text)![1])).toBe(70);
    expect(core.pauseRemainingS("claude")).toBeUndefined();
    await c.close();
  });

  // B4: an MCP call is attributed like an HTTP one. The identity is the same
  // Access identity, which the handler reads off the response it was mounted on.
  it("records the caller of a tool call", async () => {
    const c = await client();
    await c.callTool({ name: "ask_model", arguments: { model: "claude-opus", prompt: "q" } });
    expect(usage.callers(60_000)).toEqual([{ caller: "claude-code", calls: 1, inputTokens: 5, outputTokens: 1 }]);
    await c.close();
  });

  it("reports provider errors as tool errors", async () => {
    provider.script = [{ type: "error", kind: "rate_limited", detail: "429" }];
    const c = await client();
    const r = await c.callTool({ name: "ask_model", arguments: { model: "claude-opus", prompt: "q" } });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0].text).toMatch(/rate_limited/);
    await c.close();
  });

  // Every other test in this file runs behind a stub that authenticates
  // unconditionally, so none of them would notice a refactor that mounted
  // /mcp ahead of the Access middleware. This one builds its own app with a
  // denying stub: the tool call never gets that far, a 401 does.
  it("is mounted behind the Access middleware, unlike /health", async () => {
    const deny: RequestHandler = (_req, res) => { res.status(401).json({ error: { code: "unauthorized" } }); };
    const app = createApp(core, { log: createLogger("t"), access: deny, mcp: createMcpHandler(core, createLogger("t")) });
    expect((await request(app).post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
    expect((await request(app).get("/health")).status).toBe(200);
  });

  // B5: POST is the only verb the stateless transport needs. A GET asking for
  // the standalone SSE stream is answered by the SDK with a stream that never
  // ends, so a stray one holds a socket open and hangs server.close() until
  // the shutdown grace kills it; the response timeout below is what a hanging
  // stream looks like from a client. 405 + Allow is what the MCP spec asks
  // for, and the SDK's own client reads it as "this server has no GET stream".
  it("answers 405 to GET and other non-POST verbs on /mcp", async () => {
    const ok: RequestHandler = (_req, res, next) => { res.locals.identity = { sub: "", type: "service", name: "claude-code" } satisfies Identity; next(); };
    const app = createApp(core, { log: createLogger("t"), access: ok, mcp: createMcpHandler(core, createLogger("t")) });
    const sse = await request(app).get("/mcp").set("Accept", "text/event-stream").timeout({ response: 2_000, deadline: 2_000 });
    expect(sse.status).toBe(405);
    expect(sse.headers.allow).toBe("POST");
    // The body stays a JSON-RPC error: the caller here is an MCP client, not
    // an OpenAI one, and it is the shape the SDK's own transport returns.
    expect(sse.body).toMatchObject({ jsonrpc: "2.0", error: { code: -32000 }, id: null });
    for (const verb of ["delete", "put"] as const) {
      const r = await request(app)[verb]("/mcp").timeout({ response: 2_000, deadline: 2_000 });
      expect(r.status, verb).toBe(405);
      expect(r.headers.allow, verb).toBe("POST");
    }
  });
});
