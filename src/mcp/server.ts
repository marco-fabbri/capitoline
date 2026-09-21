import type { RequestHandler } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Core } from "../core/core.js";
import { CapitolineError, type Message, type ProviderEvent, type Usage } from "../core/types.js";
import type { Logger } from "../log.js";

export interface McpOptions {
  // How often generate_image reports progress while the CLI is working.
  // A generation takes 11-45 s and says nothing meanwhile; the notification
  // keeps the client's tool timeout from firing. Tests shorten it.
  progressIntervalMs?: number;
}

const PROGRESS_INTERVAL_MS = 5_000;

function buildServer(core: Core, log: Logger, opts: McpOptions): McpServer {
  const server = new McpServer({ name: "capitoline", version: "0.1.0" });
  const progressIntervalMs = opts.progressIntervalMs ?? PROGRESS_INTERVAL_MS;

  // A provider error event becomes the tool's error. For a rate limit the wait
  // comes from Core, which has just installed the pause for that provider (with
  // its slack, and possibly a longer pause still running): the CLI's raw figure
  // would have the client retry into a second 429. Same rule as the HTTP layer.
  const providerError = (ev: Extract<ProviderEvent, { type: "error" }>, provider: string): CapitolineError => {
    const retry = ev.kind === "rate_limited" ? core.pauseRemainingS(provider) ?? ev.retryAfterS : ev.retryAfterS;
    return new CapitolineError(ev.kind, ev.kind, retry);
  };
  // The tool error text carries the kind and the wait, never the detail: the
  // detail is CLI stderr or a raw 429 body, which stays in the log (spec 8.3).
  const toolError = (e: unknown, tool: string, model: string | undefined) => {
    const kind = e instanceof CapitolineError ? e.kind : "internal_error";
    log.warn({ kind, model, err: e instanceof CapitolineError ? undefined : e }, `${tool} failed`);
    const retry = e instanceof CapitolineError && e.retryAfterS !== undefined ? ` (retry after ${e.retryAfterS}s)` : "";
    return { isError: true as const, content: [{ type: "text" as const, text: `Capitoline error: ${kind}${retry}` }] };
  };
  const providerOf = (model: string) => core.listModels().find((m) => m.name === model)?.provider ?? "unknown";

  server.registerTool("list_models", {
    description: "List the models Capitoline can route to right now, with kind (text or image), availability and budget state.",
    inputSchema: {},
  }, async () => {
    const models = core.listModels().map((m) => ({ name: m.name, provider: m.provider, kind: m.kind, available: m.available, ...(m.reason ? { reason: m.reason } : {}), over_budget: m.overBudget }));
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
    const messages: Message[] = [];
    if (system) messages.push({ role: "system", text: system });
    messages.push({ role: "user", text: prompt });
    const token = extra._meta?.progressToken;
    let text = "";
    let usage: Usage | undefined;
    let n = 0;
    const progress = (done: boolean) => token !== undefined && extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: n, message: done ? "done" : `${text.length} chars` } });
    try {
      for await (const ev of core.execute({ model, messages, effort, stream: true }, { signal: extra.signal, source: "mcp" })) {
        if (ev.type === "text") { text += ev.delta; if (++n % 20 === 0) await progress(false); }
        else if (ev.type === "done") usage = ev.usage;
        else if (ev.type === "error") throw providerError(ev, providerOf(model));
      }
      await progress(true);
      const structured = { model, provider: providerOf(model), usage: { prompt_tokens: usage?.input ?? 0, completion_tokens: usage?.output ?? 0 } };
      return { content: [{ type: "text", text }], structuredContent: structured };
    } catch (e) {
      return toolError(e, "ask_model", model);
    }
  });

  server.registerTool("generate_image", {
    description: "Generate one image from a prompt through an image model's CLI. The image comes back inline (JPEG or PNG) with its real dimensions; there is no size parameter. Use list_models for names (kind image); omit model for the first available image model.",
    inputSchema: {
      prompt: z.string().min(1).describe("What to draw"),
      model: z.string().optional().describe("Image model name from list_models; default: the first available image model"),
    },
    outputSchema: { model: z.string(), provider: z.string(), mime: z.string(), width: z.number(), height: z.number(), bytes: z.number() },
  }, async ({ prompt, model: requested }, extra) => {
    // One listing per call: the default and the owner come from the same
    // snapshot. Same rule as the HTTP route: the first image model a client
    // would see as available, else the first declared one so a paused
    // provider answers with its own 429 instead of "no image model".
    const models = core.listModels();
    const model = requested ?? (models.find((m) => m.kind === "image" && m.available) ?? models.find((m) => m.kind === "image"))?.name;
    const provider = model ? models.find((m) => m.name === model)?.provider ?? "unknown" : "unknown";
    const token = extra._meta?.progressToken;
    let ticks = 0;
    const startedAt = Date.now();
    // The CLI says nothing useful while it draws (11-45 s), so progress is a
    // heartbeat with the elapsed time, sent on a timer rather than per event.
    const tick = () => extra.sendNotification({ method: "notifications/progress", params: { progressToken: token!, progress: ++ticks, message: `generating, ${Math.round((Date.now() - startedAt) / 1000)}s` } })
      .catch((e: unknown) => log.debug({ err: e }, "progress notification failed"));
    const timer = token !== undefined ? setInterval(() => { void tick(); }, progressIntervalMs) : undefined;
    try {
      if (!model) throw new CapitolineError("bad_request", "no image model is configured: set \"model\" explicitly");
      let image: Extract<ProviderEvent, { type: "image" }> | undefined;
      for await (const ev of core.generateImage({ model, prompt }, { signal: extra.signal, source: "mcp" })) {
        if (ev.type === "image") image = ev;
        else if (ev.type === "error") throw providerError(ev, provider);
        // text events are the agent's prose ("saved as ./image.png" and the
        // like) and never reach the client: the answer is the image or an error.
      }
      if (!image) throw new CapitolineError("bad_output", "the provider finished without returning an image");
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
    const server = buildServer(core, log, opts);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}
