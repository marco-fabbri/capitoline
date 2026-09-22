import type { RequestHandler } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Core } from "../core/core.js";
import { CapitolineError, type Message, type ProviderEvent, type Usage } from "../core/types.js";
import type { Deliberation } from "../council/council.js";
import type { Logger } from "../log.js";
import { callerOf } from "../server/access.js";

export interface McpOptions {
  // How often generate_image reports progress while the CLI is working.
  // A generation takes 11-45 s and says nothing meanwhile; the notification
  // gives the client a sign of life, and a client that asks for it
  // (resetTimeoutOnProgress, off by default in the TypeScript SDK) also
  // extends its own tool timeout on it. Raising that timeout is the client's
  // job and the installation docs explain it (spec 6.2). Tests shorten it.
  progressIntervalMs?: number;
}

const PROGRESS_INTERVAL_MS = 5_000;
// How many text events a streaming answer takes before it says so again. It is
// a sign of life and not a measurement — and not a deadline extension either,
// except in a client that sets resetTimeoutOnProgress (spec §6.2) — so the
// exact figure matters less than sending it steadily.
const TEXT_PROGRESS_EVERY = 20;

// `caller` is who the Access identity behind this request names, null when
// nothing identified them: the server is built per request, so it is fixed for
// the life of the tools it registers.
function buildServer(core: Core, log: Logger, opts: McpOptions, caller: string | null): McpServer {
  const server = new McpServer({ name: "capitoline", version: "0.1.0" });
  // Clamped: a 0 from a caller would become a 1 ms timer, not "no progress".
  const progressIntervalMs = Math.max(1, opts.progressIntervalMs ?? PROGRESS_INTERVAL_MS);

  // A provider error event becomes the tool's error. For a rate limit the wait
  // comes from Core, which has just installed the pause (with its slack, and
  // possibly a longer pause still running): the CLI's raw figure would have the
  // client retry into a second 429. The model is passed too, because the pause
  // may have been installed on the model alone. Same rule as the HTTP layer.
  const providerError = (ev: Extract<ProviderEvent, { type: "error" }>, provider: string, model: string): CapitolineError => {
    // The detail is logged here and nowhere else: the CapitolineError below
    // carries the kind as its message, so by the time toolError sees it the
    // provider's own words are gone. Logging it is what gives an operator on
    // this path the same line the HTTP one writes — the CLI's stderr, the raw
    // 429 body — while the client keeps getting the kind alone (spec 8.3).
    // Tail-bounded like the HTTP layer: a crashed CLI can dump a lot.
    log.warn({ kind: ev.kind, model, detail: ev.detail.slice(-2000) }, "provider error");
    const retry = ev.kind === "rate_limited" ? core.pauseRemainingS(provider, model) ?? ev.retryAfterS : ev.retryAfterS;
    return new CapitolineError(ev.kind, ev.kind, retry);
  };
  // The tool error text carries the kind and the wait, never the provider's
  // detail: that is CLI stderr or a raw 429 body and stays in the log (spec
  // 8.3). Capitoline's own reason is always logged, so an operator reading
  // `generate_image failed` sees which rule rejected the call; it also goes
  // back to the client for the kinds the caller can fix by itself (a wrong
  // model name, the wrong endpoint), which are never provider text.
  const CALLER_FAULT = new Set(["bad_request", "unknown_model"]);
  const toolError = (e: unknown, tool: string, model: string | undefined) => {
    const kind = e instanceof CapitolineError ? e.kind : "internal_error";
    const reason = e instanceof CapitolineError && e.message !== e.kind ? e.message : undefined;
    log.warn({ kind, model, reason, err: e instanceof CapitolineError ? undefined : e }, `${tool} failed`);
    const retry = e instanceof CapitolineError && e.retryAfterS !== undefined ? ` (retry after ${e.retryAfterS}s)` : "";
    const detail = reason !== undefined && CALLER_FAULT.has(kind) ? `: ${reason}` : "";
    return { isError: true as const, content: [{ type: "text" as const, text: `Capitoline error: ${kind}${detail}${retry}` }] };
  };
  const providerOf = (model: string) => core.listModels().find((m) => m.name === model)?.provider ?? "unknown";

  // Unlike /v1/models this lists the unavailable models too, so it is the one
  // place a client can read the image quota of an exhausted provider: its
  // `resetAt` says when generating becomes possible again.
  server.registerTool("list_models", {
    description: "List the models Capitoline can route to right now, with kind (text, image or council), availability, budget state and, for image models, the quota of the current window (used, limit, resetAt).",
    inputSchema: {},
  }, async () => {
    const models = core.listModels().map((m) => ({ name: m.name, provider: m.provider, kind: m.kind, available: m.available, ...(m.reason ? { reason: m.reason } : {}), over_budget: m.overBudget, ...(m.quota ? { quota: m.quota } : {}) }));
    return { content: [{ type: "text", text: JSON.stringify(models) }] };
  });

  server.registerTool("ask_model", {
    description: "Ask one model a single question through its CLI. Use list_models for names. From Claude Code, prefer codex-* and agy-* models: asking claude-* spends the same subscription twice.",
    inputSchema: {
      model: z.string().describe("Model name from list_models"),
      prompt: z.string().min(1).describe("The question"),
      effort: z.enum(["low", "medium", "high"]).optional(),
      system: z.string().optional().describe("Optional system prompt"),
    },
    outputSchema: { model: z.string(), provider: z.string(), usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }) },
  }, async ({ model, prompt, effort, system }, extra) => {
    // A council is not one model and this tool cannot run one: a deliberation
    // is nine calls over several minutes, and the only progress this tool can
    // send counts the characters of the text it is receiving — nothing at all
    // while the first two stages run, which is the silence §12.6 exists to
    // avoid in Claude Code. It is refused here, before the calls are spent,
    // and the caller is sent to the tool that reports the stages.
    if (core.isVirtual(model)) return toolError(new CapitolineError("bad_request", `model "${model}" is a council: use ask_council`), "ask_model", model);
    const messages: Message[] = [];
    if (system) messages.push({ role: "system", text: system });
    messages.push({ role: "user", text: prompt });
    const token = extra._meta?.progressToken;
    let text = "";
    let usage: Usage | undefined;
    let n = 0;
    // Two counters on purpose. `n` counts text events and only decides when a
    // mark is due; the notification carries `sent`, which counts the
    // notifications themselves. The MCP spec requires every progress value to
    // be larger than the previous one, and the event count is not: a stream of
    // exactly 20, 40, 60... events sends its last mark and then the completion
    // with the same number. There is no total to report, so a plain sequence
    // is as much as this tool can honestly say.
    let sent = 0;
    const progress = (done: boolean) => token !== undefined && extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++sent, message: done ? "done" : `${text.length} chars` } });
    try {
      for await (const ev of core.execute({ model, messages, effort, stream: true }, { signal: extra.signal, source: "mcp", caller })) {
        if (ev.type === "text") { text += ev.delta; if (++n % TEXT_PROGRESS_EVERY === 0) await progress(false); }
        else if (ev.type === "done") usage = ev.usage;
        else if (ev.type === "error") throw providerError(ev, providerOf(model), model);
      }
      await progress(true);
      const structured = { model, provider: providerOf(model), usage: { prompt_tokens: usage?.input ?? 0, completion_tokens: usage?.output ?? 0 } };
      return { content: [{ type: "text", text }], structuredContent: structured };
    } catch (e) {
      return toolError(e, "ask_model", model);
    }
  });

  server.registerTool("ask_council", {
    description: "Put one question to a council: several models of different families answer it independently, rank each other's answers without knowing whose is whose, and a judge writes the final answer from the ranking. One deliberation is nine model calls over several minutes on three different subscriptions, so ask_model is the right tool for anything a single model can answer. Use list_models for council names (kind council); omit council for the first available one.",
    inputSchema: {
      question: z.string().min(1).describe("The question the council deliberates on"),
      council: z.string().min(1).optional().describe("Council name from list_models (kind council); default: the first available council"),
    },
    // The un-blinded record of a blind deliberation (§12.6), minus the
    // individual rankings: the aggregate is the panel's verdict, and every
    // member's reasons for every label would be four times the bulk of the
    // answers for a caller that already has the synthesis. `lost` stays,
    // because a dropped seat is declared and not hidden (§12.5), and
    // `deliberation_id` stays because it is what ties the nine usage rows of
    // this question together (§12.7).
    outputSchema: {
      council: z.string(),
      deliberation_id: z.string(),
      strategy_version: z.number(),
      members: z.array(z.object({ family: z.string(), model: z.string(), label: z.string(), answer: z.string(), fellBackFrom: z.array(z.string()).optional() })),
      lost: z.array(z.object({ family: z.string(), model: z.string().optional(), reason: z.string(), fellBackFrom: z.array(z.string()).optional() })),
      aggregate: z.array(z.object({ label: z.string(), averageRank: z.number(), votes: z.number() })),
      judge: z.object({ model: z.string(), blind: z.boolean() }),
      usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }),
      calls: z.number(),
    },
  }, async ({ question, council: requested }, extra) => {
    // Everything inside the try, listModels() included, for the reason
    // generate_image gives: an exception escaping the handler is turned by the
    // SDK into a tool error carrying the raw message, with no log line and no
    // spec 8.3 sanitising.
    let name: string | undefined;
    try {
      // One listing per call, and the same default rule as generate_image: the
      // first council a client would see as available, else the first declared
      // one, so a panel that cannot reach its quorum answers with its own
      // refusal — the count of seats it could fill — instead of "no council".
      const models = core.listModels();
      name = requested ?? (models.find((m) => m.kind === "council" && m.available) ?? models.find((m) => m.kind === "council"))?.name;
      if (!name) throw new CapitolineError("bad_request", "no council is configured: nothing to deliberate with");
      // The mirror of ask_model's refusal: one tool per kind of call, and each
      // names the other, so an agent that guessed wrong is one message away
      // from the right tool rather than from a 404. Split in two, because a
      // misspelled council and a real model are not the same mistake: a bare
      // "not a council: use ask_model" would send a typo to ask_model only to
      // be refused there as unknown_model, two round trips for one dropped
      // letter. Both kinds are in CALLER_FAULT, so the name reaches the caller.
      const known = models.find((m) => m.name === name);
      if (!known) throw new CapitolineError("unknown_model", `unknown model "${name}": use list_models`);
      if (known.kind !== "council") throw new CapitolineError("bad_request", `model "${name}" is not a council: use ask_model`);
      const token = extra._meta?.progressToken;
      // One sequence for every notification this call sends, for the reason
      // ask_model explains: the MCP spec requires each progress value to be
      // larger than the last, and the council's own counters restart at every
      // stage (`answers 2/2`, then `rankings 0/2`). The stage and its counters
      // travel in the message, where they say something a bare number cannot.
      let sent = 0;
      const progress = (message: string) => token !== undefined
        ? extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++sent, message } })
        : undefined;
      let text = "";
      let n = 0;
      let usage: Usage | undefined;
      let detail: Deliberation | undefined;
      // deliberate() and not execute(): the progress of the two silent stages
      // and the un-blinded account of what the panel did are the whole point of
      // §12.6, and the flattened form has nowhere to put either. It is also
      // where a council is refused — the empty question, a quorum that cannot
      // be filled — before a single member call is spent.
      for await (const ev of core.deliberate({ model: name, messages: [{ role: "user", text: question }], stream: true }, { signal: extra.signal, source: "mcp", caller })) {
        if (ev.type === "progress") await progress(`${ev.stage} ${ev.done}/${ev.total}`);
        // The synthesis is the one stage that streams, and it emits no stage
        // event while it is written: this mark is the only sign of life in
        // between (§12.6). It postpones no deadline by itself — a notification
        // restarts the tool timeout only in a client that sets
        // resetTimeoutOnProgress, off by default in the MCP TypeScript SDK
        // (spec §6.2). What carries a deliberation past ten minutes is the
        // raised MCP_TOOL_TIMEOUT of docs/deploy.md §10, and the progress is
        // what tells the agent, and the operator, that it is still working.
        else if (ev.type === "text") { text += ev.delta; if (++n % TEXT_PROGRESS_EVERY === 0) await progress(`writing, ${text.length} chars`); }
        else if (ev.type === "done") { usage = ev.usage; detail = ev.detail; }
        // The kind and the wait, never the council's own account of which seats
        // it lost: that names providers and carries their words (spec 8.3), and
        // the Council has already written it to the log with the seats. The
        // wait is the refused member's own, carried on the event —
        // pauseRemainingS cannot answer for a council, which has no provider of
        // its own and spread its calls over three.
        else throw new CapitolineError(ev.kind, ev.kind, ev.retryAfterS);
        // Throwing out of a for-await closes the generator, which is what stops
        // the stage the deliberation is in from running on to its timeout.
      }
      // A cancelled call ends the same way as a council that produced nothing:
      // no done event, no error event. It is not bad_output — Core has recorded
      // every call it made as aborted and the client is gone — so it must not
      // raise the warn line an operator uses to hunt a broken council.
      if (!detail) {
        if (extra.signal.aborted) return { isError: true as const, content: [{ type: "text" as const, text: "Capitoline error: cancelled" }] };
        throw new CapitolineError("bad_output", "the council finished without a result");
      }
      await progress("done");
      const structured = {
        council: name, deliberation_id: detail.deliberationId, strategy_version: detail.strategyVersion,
        members: detail.members, lost: detail.lost, aggregate: detail.aggregate, judge: detail.judge,
        usage: { prompt_tokens: usage?.input ?? 0, completion_tokens: usage?.output ?? 0 }, calls: detail.calls,
      };
      return { content: [{ type: "text", text }], structuredContent: structured };
    } catch (e) {
      return toolError(e, "ask_council", name);
    }
  });

  server.registerTool("generate_image", {
    description: "Generate one image from a prompt through an image model's CLI. The image comes back inline (JPEG or PNG) with its real dimensions; there is no size parameter. Use list_models for names (kind image); omit model for the first available image model.",
    inputSchema: {
      prompt: z.string().min(1).describe("What to draw"),
      model: z.string().min(1).optional().describe("Image model name from list_models; default: the first available image model"),
    },
    outputSchema: { model: z.string(), provider: z.string(), mime: z.string(), width: z.number(), height: z.number(), bytes: z.number() },
  }, async ({ prompt, model: requested }, extra) => {
    // Everything runs inside the try, listModels() included: it queries the
    // usage store per provider, and an exception escaping the handler would
    // be turned by the SDK into a tool error carrying the raw message (a
    // database path, say) with no log line and no spec 8.3 sanitising.
    let model: string | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      // One listing per call: the default and the owner come from the same
      // snapshot. Same rule as the HTTP route: the first image model a client
      // would see as available, else the first declared one so a paused
      // provider answers with its own 429 instead of "no image model".
      const models = core.listModels();
      model = requested ?? (models.find((m) => m.kind === "image" && m.available) ?? models.find((m) => m.kind === "image"))?.name;
      if (!model) throw new CapitolineError("bad_request", "no image model is configured: set \"model\" explicitly");
      // A council named here never comes from the default (it is not an image
      // model), so it is always the caller's own word. Core.lookup would refuse
      // it with "use the chat endpoint", which is HTTP advice and names nothing
      // an MCP client can call: refuse it here, pointing at the tool, exactly
      // as ask_model does.
      if (core.isVirtual(model)) throw new CapitolineError("bad_request", `model "${model}" is a council: use ask_council`);
      const provider = models.find((m) => m.name === model)?.provider ?? "unknown";
      const token = extra._meta?.progressToken;
      let ticks = 0;
      const startedAt = Date.now();
      // The CLI says nothing useful while it draws (11-45 s), so progress is a
      // heartbeat with the elapsed time, sent on a timer rather than per event.
      // No token, no timer: a client that did not ask gets no notification.
      if (token !== undefined) {
        const tick = () => extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++ticks, message: `generating, ${Math.round((Date.now() - startedAt) / 1000)}s` } })
          .catch((e: unknown) => log.debug({ err: e }, "progress notification failed"));
        timer = setInterval(() => { void tick(); }, progressIntervalMs);
      }
      let image: Extract<ProviderEvent, { type: "image" }> | undefined;
      for await (const ev of core.generateImage({ model, prompt }, { signal: extra.signal, source: "mcp", caller })) {
        if (ev.type === "image") image = ev;
        else if (ev.type === "error") throw providerError(ev, provider, model);
        // text events are the agent's prose ("saved as ./image.png" and the
        // like) and never reach the client: the answer is the image or an error.
      }
      // A cancelled call ends the same way as a broken provider (no image, no
      // error event), but it is not bad_output: Core records it as aborted and
      // the client is no longer listening, so it must not raise a warn line
      // with the kind an operator uses to hunt a broken collect helper. Same
      // check as the HTTP route.
      if (!image) {
        if (extra.signal.aborted) return { isError: true as const, content: [{ type: "text" as const, text: "Capitoline error: cancelled" }] };
        throw new CapitolineError("bad_output", "the provider finished without returning an image");
      }
      const structured = { model, provider, mime: image.mime, width: image.width, height: image.height, bytes: image.bytes.length };
      return { content: [{ type: "image", data: image.bytes.toString("base64"), mimeType: image.mime }], structuredContent: structured };
    } catch (e) {
      return toolError(e, "generate_image", model);
    } finally {
      if (timer) clearInterval(timer);
    }
  });

  return server;
}

export function createMcpHandler(core: Core, log: Logger, opts: McpOptions = {}): RequestHandler {
  return async (req, res) => {
    // The handler is mounted inside createApp, behind the Access middleware,
    // so the identity it left on the response is the caller of every tool call
    // this transport serves.
    const server = buildServer(core, log, opts, callerOf(res.locals.identity));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}
