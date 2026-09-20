import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import type { Core } from "../core/core.js";
import { CapitolineError, type Usage } from "../core/types.js";
import type { Logger } from "../log.js";
import { completionResponse, convertChatRequest, httpStatus, sseChunk } from "./openai.js";

// What the client is told for each provider error. CLI detail stays in the log.
const CLIENT_MESSAGE: Record<string, string> = {
  auth_expired: "provider authentication expired; the model is unavailable until it is renewed",
  rate_limited: "provider rate limit reached",
  timeout: "the model did not answer within the time limit",
  cli_crashed: "the provider process failed",
  bad_output: "the provider returned unreadable output",
};

function beginSse(res: Response) {
  res.status(200).setHeader("Content-Type", "text/event-stream").setHeader("Cache-Control", "no-cache");
  res.flushHeaders?.();
}

function sendError(res: Response, e: unknown, log: Logger) {
  const err = e instanceof CapitolineError ? e : new CapitolineError("bad_output", "internal error");
  if (!(e instanceof CapitolineError)) log.error({ err: e }, "unhandled error");
  const { status, retryAfterS } = httpStatus(err);
  if (retryAfterS) res.setHeader("Retry-After", String(retryAfterS));
  res.status(status).json({ error: { message: err.message, type: status >= 500 ? "server_error" : "invalid_request_error", code: err.kind } });
}

export function createApp(core: Core, opts: { access?: RequestHandler; log: Logger; mcp?: RequestHandler }): express.Express {
  const app = express();
  app.disable("x-powered-by");
  // Access runs first, app-wide, so an unauthenticated caller gets a 401 before
  // any body is buffered and any route added later is protected by default.
  // /health is the one deliberate exemption: it serves the local monitor on
  // 127.0.0.1 and never reaches the CLIs (spec 4).
  const access = opts.access;
  if (access) app.use((req, res, next) => (req.path === "/health" ? next() : access(req, res, next)));
  app.use(express.json({ limit: "20mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, providers: core.providerStates(), models: core.listModels() });
  });

  app.get("/v1/models", (_req, res) => {
    const data = core.listModels().filter((m) => m.available).map((m) => ({
      id: m.name, object: "model", created: 0, owned_by: m.provider, capitoline: { over_budget: m.overBudget },
    }));
    res.json({ object: "list", data });
  });

  app.post("/v1/chat/completions", async (req: Request, res: Response) => {
    let conv;
    try { conv = convertChatRequest(req.body); } catch (e) { return sendError(res, e, opts.log); }
    if (conv.ignored.length) res.setHeader("X-Capitoline-Ignored", conv.ignored.join(","));
    const ac = new AbortController();
    res.on("close", () => { if (!res.writableFinished) ac.abort(); });
    const provider = core.listModels().find((m) => m.name === conv.req.model)?.provider ?? "unknown";
    const id = `chatcmpl-${crypto.randomUUID()}`;
    let text = "";
    let usage: Usage | undefined;
    let started = false;
    try {
      for await (const ev of core.execute(conv.req, { signal: ac.signal, source: "http" })) {
        if (ev.type === "text") {
          if (conv.req.stream) {
            if (!started) { beginSse(res); res.write(sseChunk(conv.req.model, id, { role: "assistant", content: "" }, null)); started = true; }
            res.write(sseChunk(conv.req.model, id, { content: ev.delta }, null));
          } else text += ev.delta;
        } else if (ev.type === "done") usage = ev.usage;
        else if (ev.type === "error") { opts.log.warn({ kind: ev.kind, detail: ev.detail.slice(-2000) }, "provider error"); throw new CapitolineError(ev.kind, CLIENT_MESSAGE[ev.kind]); }
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
