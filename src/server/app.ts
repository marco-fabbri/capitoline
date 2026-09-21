import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import type { Core } from "../core/core.js";
import { CapitolineError, type ProviderEvent, type Usage } from "../core/types.js";
import type { Logger } from "../log.js";
import { callerOf } from "./access.js";
import { convertImageRequest, imageResponse, type ImageEvent } from "./images.js";
import { CLIENT_MESSAGE, completionResponse, convertChatRequest, httpStatus, ignoredHeader, sseChunk } from "./openai.js";

function beginSse(res: Response) {
  res.status(200).setHeader("Content-Type", "text/event-stream").setHeader("Cache-Control", "no-cache");
  res.flushHeaders?.();
}

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

export function createApp(core: Core, opts: { access?: RequestHandler; log: Logger; mcp?: RequestHandler; ready?: () => boolean }): express.Express {
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

  // `callers` is the last 24 hours broken down by who asked: with more than
  // one application behind the same tunnel, it is the only way to see which
  // one is spending the window. It carries no provider detail and no prompt,
  // only what the Access token already said about the caller.
  app.get("/health", (_req, res) => {
    res.json({ ok: true, providers: core.providerStates(), models: core.listModels(), callers: core.callers() });
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
    const ac = new AbortController();
    res.on("close", () => { if (!res.writableFinished) ac.abort(); });
    const provider = core.listModels().find((m) => m.name === conv.req.model)?.provider ?? "unknown";
    const id = `chatcmpl-${crypto.randomUUID()}`;
    let text = "";
    let usage: Usage | undefined;
    let started = false;
    try {
      const ignored = ignoredHeader(conv.ignored);
      if (ignored) res.setHeader("X-Capitoline-Ignored", ignored);
      for await (const ev of core.execute(conv.req, { signal: ac.signal, source: "http", caller: callerOf(res.locals.identity) })) {
        if (ev.type === "text") {
          if (conv.req.stream) {
            if (!started) { beginSse(res); res.write(sseChunk(conv.req.model, id, { role: "assistant", content: "" }, null)); started = true; }
            res.write(sseChunk(conv.req.model, id, { content: ev.delta }, null));
          } else text += ev.delta;
        } else if (ev.type === "done") usage = ev.usage;
        else if (ev.type === "error") throw providerError(ev, provider, conv.req.model);
      }
      if (ac.signal.aborted) return; // client went away: nothing left to answer
      if (conv.req.stream) {
        if (!started) { beginSse(res); res.write(sseChunk(conv.req.model, id, { role: "assistant", content: "" }, null)); }
        res.write(sseChunk(conv.req.model, id, {}, "stop", usage));
        res.write("data: [DONE]\n\n");
        res.end();
      } else res.json(completionResponse(conv.req.model, text, usage, { provider, ignored: conv.ignored }));
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
  if (opts.mcp) app.all("/mcp", opts.mcp);

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
