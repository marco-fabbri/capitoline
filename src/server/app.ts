import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import type { Core } from "../core/core.js";
import { CapitolineError, type ProviderEvent, type Usage } from "../core/types.js";
import type { Logger } from "../log.js";
import { callerOf } from "./access.js";
import { convertImageRequest, imageResponse, type ImageEvent } from "./images.js";
import { CLIENT_MESSAGE, completionResponse, convertChatRequest, httpStatus, ignoredHeader, sseChunk, type Converted } from "./openai.js";
import type { Deliberation } from "../council/council.js";

function beginSse(res: Response) {
  res.status(200).setHeader("Content-Type", "text/event-stream").setHeader("Cache-Control", "no-cache");
  res.flushHeaders?.();
}

// A comment line: the SSE grammar says a frame whose field name is empty is
// ignored, so every conforming parser — the OpenAI SDKs included — drops it
// without seeing a chunk, and the protocol gains no field. What it does is put
// a byte on the wire. Opening the stream before stage 1 only moves the silence:
// between `answers 0/n` and `answers 1/n`, and above all between
// `synthesis 0/1` and the judge's first token, nothing is written for as long
// as a member takes (up to `stage_timeout_s`, 300 s as shipped), and the edge
// in front of the gateway gives up on an origin silent for 100 s
// (docs/deploy.md §9) — now with a 200 and half a stream already delivered,
// which is worse than the error it would have read before. Twenty seconds
// leaves four ticks inside that budget, so a missed one is not a lost client.
const KEEP_ALIVE = ": keep-alive\n\n";
const KEEP_ALIVE_MS = 20_000;

function sendError(res: Response, e: unknown, log: Logger) {
  const err = e instanceof CapitolineError ? e : new CapitolineError("bad_output", "internal error");
  if (!(e instanceof CapitolineError)) log.error({ err: e }, "unhandled error");
  const { status, retryAfterS } = httpStatus(err);
  // Zero is a value, not an absence: a reset instant already behind us reaches
  // here as 0 and the 429 must still carry Retry-After (spec 8.3), so the
  // header is emitted whenever a wait is known and never below one second.
  if (retryAfterS !== undefined) res.setHeader("Retry-After", String(Math.max(1, Math.ceil(retryAfterS))));
  res.status(status).json({ error: { message: err.message, type: status >= 500 ? "server_error" : "invalid_request_error", code: err.kind } });
}

export function createApp(core: Core, opts: { access?: RequestHandler; log: Logger; mcp?: RequestHandler; ready?: () => boolean;
  /** What to call each service token in /v1/usage, by its client id (server.access.callers). */
  callerNames?: Record<string, string> }): express.Express {
  const app = express();
  app.disable("x-powered-by");
  // Access runs first, app-wide, so an unauthenticated caller gets a 401 before
  // any body is buffered and any route added later is protected by default.
  // /health is the one deliberate exemption: it serves the local monitor on
  // 127.0.0.1 and never reaches the CLIs (spec 4).
  const access = opts.access;
  if (access) app.use((req, res, next) => (req.path === "/health" ? next() : access(req, res, next)));

  // Startup gate, after Access (authentication stays the first word on every
  // route) and before the body is parsed. Until the first health check lands
  // every provider still reports `health: null`, i.e. available, so a request
  // arriving in that window would be routed to a CLI nobody has verified and
  // come back 502. The port itself is bound immediately — a probe that spawns
  // a CLI must never keep the socket refusing connections — so the window is
  // closed here instead, with the 503 + Retry-After a client knows how to
  // retry. /health is exempt, so the local monitor can watch the startup.
  const ready = opts.ready;
  if (ready) app.use((req, res, next) => {
    if (ready() || req.path === "/health") return next();
    res.status(503).setHeader("Retry-After", "5");
    res.json({ error: { message: "starting: the first health check is still in flight", type: "server_error", code: "model_unavailable" } });
  });

  app.use(express.json({ limit: "20mb" }));

  // A provider error event becomes the client's error. For a rate limit the
  // wait comes from Core, which has just installed the pause (with its slack,
  // and possibly a longer pause still running): telling the client the CLI's
  // raw figure would have it retry into a second 429. The model is passed too,
  // because the pause may have been installed on the model alone.
  const providerError = (ev: Extract<ProviderEvent, { type: "error" }>, provider: string, model: string): CapitolineError => {
    opts.log.warn({ kind: ev.kind, model, detail: ev.detail.slice(-2000) }, "provider error");
    const retry = ev.kind === "rate_limited" ? core.pauseRemainingS(provider, model) ?? ev.retryAfterS : ev.retryAfterS;
    return new CapitolineError(ev.kind, CLIENT_MESSAGE[ev.kind], retry);
  };

  /**
   * A council on the chat endpoint, in both of its shapes.
   *
   * The deliberation is read through `Core.deliberate()` and not through
   * `Core.execute()`, which flattens it: the progress of the two silent stages
   * and the un-blinded account of what the panel did are the whole point of
   * §12.6, and `execute()` has nowhere to put either.
   *
   * The first event is pulled before a single byte is written. Everything a
   * council is refused for — an attachment, the empty question, a quorum that
   * cannot be filled — is raised there, and must still reach the client as a
   * 400 or a 404 and not as an error inside a 200 that has already started.
   * It costs nothing: that event is `answers 0/n`, emitted from the seating,
   * before the first member call.
   *
   * Then, for a streaming request, the headers and the opening role chunk go
   * out at once — not on the first token, as a single model's answer does.
   * Two stages produce no token at all, up to `stage_timeout_s` each, and
   * Cloudflare's edge answers the client 524 after 100 s of silence from the
   * origin while the nine calls carry on being spent for nobody
   * (docs/deploy.md §9). Opening early is half of it: a keep-alive comment
   * every `KEEP_ALIVE_MS` covers the silence *inside* a stage, which is where
   * a deliberation spends nearly all of its minutes.
   */
  const council = async (res: Response, conv: Converted, id: string, ac: AbortController, provider: string) => {
    const model = conv.req.model;
    const events = core.deliberate(conv.req, { signal: ac.signal, source: "http", caller: callerOf(res.locals.identity) })[Symbol.asyncIterator]();
    let step = await events.next();
    let text = "";
    let usage: Usage | undefined;
    let detail: Deliberation | undefined;
    // Cleared in the `finally` below, which every exit passes through: an
    // interval left behind would write into a finished response.
    let keepAlive: ReturnType<typeof setInterval> | undefined;
    try {
      if (conv.req.stream) {
        beginSse(res);
        res.write(sseChunk(model, id, { role: "assistant", content: "" }, null));
        keepAlive = setInterval(() => res.write(KEEP_ALIVE), KEEP_ALIVE_MS);
        keepAlive.unref?.();
      }
      for (; step.done !== true; step = await events.next()) {
        const ev = step.value;
        if (ev.type === "progress") {
          if (conv.req.stream) res.write(sseChunk(model, id, { content: "" }, null, undefined, { stage: ev.stage, done: ev.done, total: ev.total }));
        } else if (ev.type === "text") {
          if (conv.req.stream) res.write(sseChunk(model, id, { content: ev.delta }, null));
          else text += ev.delta;
        } else if (ev.type === "done") { usage = ev.usage; detail = ev.detail; }
        // The kind and the wait, never the council's own account of which
        // seats it lost: that is a log line (spec 8.3), and a deliberation
        // that did finish hands the client the whole of it in the
        // `capitoline` field instead.
        //
        // The wait is the refused member's own. `pauseRemainingS` cannot
        // answer for a council — it has no provider of its own, and its calls
        // were spread over three — so what travels on the event is the figure
        // that member was given: the remaining pause when Core refused the
        // call outright, the provider's raw retry-after when the call reached
        // the CLI and came back 429. The raw figure is the shorter of the two
        // (Core.onError adds a minute of slack when it installs the pause), so
        // a client that obeys it may come back once while the pause still
        // stands; that refusal costs no call and carries the full remainder.
        // Without it every council 429 would say 60 s, the fixed default of
        // `httpStatus`, whatever the subscription said.
        else throw new CapitolineError(ev.kind, CLIENT_MESSAGE[ev.kind], ev.retryAfterS);
      }
    } finally {
      if (keepAlive !== undefined) clearInterval(keepAlive);
      // A deliberation left mid-stage — an error event, a client that went
      // away — is a generator suspended at a yield, and the stage it is in
      // would run to its timeout for nobody.
      await events.return?.(undefined);
    }
    if (ac.signal.aborted) return; // client went away: nothing left to answer
    const extra = { provider, ignored: conv.ignored, ...(detail ? { council: detail } : {}) };
    if (conv.req.stream) {
      res.write(sseChunk(model, id, {}, "stop", usage, extra));
      res.write("data: [DONE]\n\n");
      res.end();
    } else res.json(completionResponse(model, text, usage, extra));
  };

  // The exempt route (spec 4) carries cached state only and names nobody:
  // "anyone who can open 127.0.0.1:8080" is not the owner alone on a host that
  // also runs the `runner` user, the account docs/deploy.md §11 keeps away
  // from the usage database on purpose. The per-caller breakdown is below,
  // behind Access.
  app.get("/health", (_req, res) => {
    res.json({ ok: true, providers: core.providerStates(), models: core.listModels() });
  });

  // The last 24 hours broken down by who asked: with more than one application
  // behind the same tunnel, it is the only way to see which one is spending
  // the window. It names callers — an email, a service token name — so it sits
  // under /v1, where the app-wide Access middleware protects it like every
  // other route. It carries no provider detail and no prompt, only what the
  // Access token already said about the caller.
  // `callers` is the last day, `models` the last week: the first answers "who
  // spent it", the second "what actually answered". They differ because the
  // second is read for a change — a gateway name whose model moved shows two
  // rows — and a day is too short to catch one.
  app.get("/v1/usage", (_req, res) => {
    // Named here and not when the row was written: a row stores the client id
    // Cloudflare sent, which is stable, and the name is presentation. So a
    // token mapped an hour late is readable all the way back, and renaming an
    // application renames its past with it. An id nobody named is reported as
    // itself, which is unreadable and still correct.
    const named = core.callers().map((c) => ({ ...c, caller: (c.caller !== null && opts.callerNames?.[c.caller]) || c.caller }));
    res.json({ callers: named, models: core.modelIdentities() });
  });

  // The quota block is only there for image models, and its keys follow this
  // endpoint's snake_case (over_budget) rather than the internal names; /health
  // serves the internal shape instead. It carries no reset instant on purpose:
  // a quota hit pauses the provider until that instant plus a minute of slack
  // (Core.onError), so while a reset stands the model is unavailable and this
  // list, which carries only available models (spec 6.4), has already dropped
  // it. The reset is read from /health or from the MCP list_models tool, which
  // both report unavailable models too.
  app.get("/v1/models", (_req, res) => {
    const data = core.listModels().filter((m) => m.available).map((m) => ({
      id: m.name, object: "model", created: 0, owned_by: m.provider,
      capitoline: {
        kind: m.kind, over_budget: m.overBudget,
        ...(m.quota ? { quota: { used: m.quota.used, limit: m.quota.limit, window_started_at: m.quota.windowStartedAt } } : {}),
      },
    }));
    res.json({ object: "list", data });
  });

  app.post("/v1/chat/completions", async (req: Request, res: Response) => {
    let conv;
    try { conv = convertChatRequest(req.body); } catch (e) { return sendError(res, e, opts.log); }
    // A council has no channel for reasoning_effort: its member calls are made
    // by the council itself, each with the effort its own model is configured
    // for, and its three prompts are the strategy rather than a request field
    // (§12.8). Spec 6.1 allows it to be ignored, never silently: it joins the
    // ignored list — the header and the `capitoline` block of the answer — the
    // same way `temperature` does for every other model.
    if (conv.req.effort !== undefined && core.isVirtual(conv.req.model)) {
      conv.ignored.push("reasoning_effort");
      conv.req.effort = undefined;
    }
    const ac = new AbortController();
    res.on("close", () => { if (!res.writableFinished) ac.abort(); });
    const provider = core.listModels().find((m) => m.name === conv.req.model)?.provider ?? "unknown";
    const id = `chatcmpl-${crypto.randomUUID()}`;
    let text = "";
    let usage: Usage | undefined;
    // The dated id of what actually answered, when the CLI reported one. Only
    // Claude does: its model names are aliases that move onto a new model
    // without a word, while a Codex slug and an Antigravity id are the model
    // itself. A caller that keeps a record of who wrote what — app-one
    // stores the model of every recipe — can then store the model and not
    // only the name it asked for (issue #2).
    let cliModelId: string | undefined;
    let started = false;
    try {
      const ignored = ignoredHeader(conv.ignored);
      if (ignored) res.setHeader("X-Capitoline-Ignored", ignored);
      if (core.isVirtual(conv.req.model)) return await council(res, conv, id, ac, provider);
      for await (const ev of core.execute(conv.req, { signal: ac.signal, source: "http", caller: callerOf(res.locals.identity) })) {
        if (ev.type === "text") {
          if (conv.req.stream) {
            if (!started) { beginSse(res); res.write(sseChunk(conv.req.model, id, { role: "assistant", content: "" }, null)); started = true; }
            res.write(sseChunk(conv.req.model, id, { content: ev.delta }, null));
          } else text += ev.delta;
        } else if (ev.type === "done") { usage = ev.usage; cliModelId = ev.cliModelId; }
        else if (ev.type === "error") throw providerError(ev, provider, conv.req.model);
      }
      if (ac.signal.aborted) return; // client went away: nothing left to answer
      if (conv.req.stream) {
        if (!started) { beginSse(res); res.write(sseChunk(conv.req.model, id, { role: "assistant", content: "" }, null)); }
        // `model` stays the alias the client asked for, as an OpenAI client
        // expects; the resolved id rides in the gateway's own field.
        res.write(sseChunk(conv.req.model, id, {}, "stop", usage, { provider, ...(cliModelId !== undefined ? { cliModelId } : {}), ignored: conv.ignored }));
        res.write("data: [DONE]\n\n");
        res.end();
      } else res.json(completionResponse(conv.req.model, text, usage, { provider, ...(cliModelId !== undefined ? { cliModelId } : {}), ignored: conv.ignored }));
    } catch (e) {
      if (res.headersSent) {
        const err = e instanceof CapitolineError ? e : new CapitolineError("bad_output", "internal error");
        opts.log.warn({ kind: err.kind }, "error after stream started");
        res.write(`data: ${JSON.stringify({ error: { message: err.message, type: "server_error", code: err.kind } })}\n\n`);
        res.end();
      } else sendError(res, e, opts.log);
    }
  });

  // One image per request, returned inline (b64_json): there is nothing to
  // stream, so the answer is either the whole document or a spec 8.3 error.
  app.post("/v1/images/generations", async (req: Request, res: Response) => {
    // One listing per request: each call recomputes the budget flags with
    // store queries per provider, and both the default and the owner come
    // from the same snapshot. The default is the first image model a client
    // would actually see in /v1/models (available), falling back to the first
    // declared one so a paused provider still answers with its own 404/429.
    const models = core.listModels();
    let conv;
    try {
      const defaultModel = (models.find((m) => m.kind === "image" && m.available) ?? models.find((m) => m.kind === "image"))?.name;
      conv = convertImageRequest(req.body, defaultModel);
    } catch (e) { return sendError(res, e, opts.log); }
    const ac = new AbortController();
    res.on("close", () => { if (!res.writableFinished) ac.abort(); });
    const provider = models.find((m) => m.name === conv.req.model)?.provider ?? "unknown";
    let image: ImageEvent | undefined;
    try {
      const ignored = ignoredHeader(conv.ignored);
      if (ignored) res.setHeader("X-Capitoline-Ignored", ignored);
      for await (const ev of core.generateImage(conv.req, { signal: ac.signal, source: "http", caller: callerOf(res.locals.identity) })) {
        if (ev.type === "image") image = ev;
        else if (ev.type === "error") throw providerError(ev, provider, conv.req.model);
        // text events are the agent's prose ("saved as ./image.png" and the
        // like) and never reach the client: the answer is the image or an error.
      }
      if (ac.signal.aborted) return; // client went away: nothing left to answer
      if (!image) throw new CapitolineError("bad_output", "the provider finished without returning an image");
      res.json(imageResponse(image, { provider, model: conv.req.model, ignored: conv.ignored }));
    } catch (e) {
      if (res.headersSent) {
        // res.json failed mid-way (socket gone under a multi-MB body): the
        // status is out already, so only the connection can be closed.
        opts.log.warn({ err: e }, "error after the image response started");
        res.end();
        return;
      }
      sendError(res, e, opts.log);
    }
  });

  // The MCP handler is mounted inside createApp so the Access middleware above
  // protects it like every other route. express.json() has already parsed the
  // body, which is why the handler passes req.body to the SDK transport.
  //
  // POST only. In stateless mode (no session id) the transport answers a GET
  // with the standalone SSE stream, which nothing ever ends: a stray GET — a
  // browser, a naive checker — would then hold a connection open and keep
  // server.close() waiting until the shutdown grace destroys the sockets. 405
  // with Allow is what the MCP spec prescribes for a verb the endpoint does
  // not serve, and the SDK's own client reads it as "no GET stream here" and
  // carries on. The body stays JSON-RPC rather than the spec 8.3 envelope of
  // the /v1 routes, because the caller of /mcp is an MCP client.
  if (opts.mcp) {
    app.post("/mcp", opts.mcp);
    app.all("/mcp", (_req, res) => {
      res.status(405).setHeader("Allow", "POST");
      res.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
    });
  }

  // Errors raised before a route runs (express.json on a malformed or oversized
  // body) would otherwise fall into Express's default handler, which answers in
  // HTML with a stack trace full of local paths. Keep the spec 8.3 error shape.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const e = err as { type?: string; status?: number } | undefined;
    if (e?.type === "entity.too.large" || e?.status === 413) {
      res.status(413).json({ error: { message: "request body too large", type: "invalid_request_error", code: "bad_request" } });
      return;
    }
    if (typeof e?.status === "number" && e.status >= 400 && e.status < 500) {
      sendError(res, new CapitolineError("bad_request", "invalid JSON body"), opts.log);
      return;
    }
    sendError(res, err, opts.log);
  });

  return app;
}
