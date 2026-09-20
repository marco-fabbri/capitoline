import type { RequestHandler } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Core } from "../core/core.js";
import { CapitolineError, type Message, type Usage } from "../core/types.js";
import type { Logger } from "../log.js";

function buildServer(core: Core, log: Logger): McpServer {
  const server = new McpServer({ name: "capitoline", version: "0.1.0" });

  server.registerTool("list_models", {
    description: "List the models Capitoline can route to right now, with availability and budget state.",
    inputSchema: {},
  }, async () => {
    const models = core.listModels().map((m) => ({ name: m.name, provider: m.provider, available: m.available, ...(m.reason ? { reason: m.reason } : {}), over_budget: m.overBudget }));
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
        else if (ev.type === "error") throw new CapitolineError(ev.kind, ev.kind);
      }
      await progress(true);
      const provider = core.listModels().find((m) => m.name === model)?.provider ?? "unknown";
      const structured = { model, provider, usage: { prompt_tokens: usage?.input ?? 0, completion_tokens: usage?.output ?? 0 } };
      return { content: [{ type: "text", text }], structuredContent: structured };
    } catch (e) {
      const kind = e instanceof CapitolineError ? e.kind : "internal_error";
      log.warn({ kind, model }, "ask_model failed");
      return { isError: true, content: [{ type: "text", text: `Capitoline error: ${kind}${e instanceof CapitolineError && e.retryAfterS ? ` (retry after ${e.retryAfterS}s)` : ""}` }] };
    }
  });

  return server;
}

export function createMcpHandler(core: Core, log: Logger): RequestHandler {
  return async (req, res) => {
    const server = buildServer(core, log);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}
