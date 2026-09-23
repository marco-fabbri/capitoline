import type { ProviderConfig } from "../config.js";
import { flatten, splitSystem } from "../core/prompt.js";
import type { ErrorKind, InternalRequest, ProviderEvent, RateLimitWindow } from "../core/types.js";
import { withPreamble, effortArgs, effortValue, jsonLines, systemPromptArgs, type Adapter, type Command, type ModelSpec } from "./adapter.js";
import { classifyError, isModelScoped } from "./errors.js";

// The HTTP status the CLI puts in the result when the API refused the call.
// It is the only reliable signal: the prose next to it is a product message
// that changes with the plan and the model, and the real Fable refusal
// (2026-09-21) matched none of the patterns in errors.ts, so it was classified
// cli_crashed and answered 502 while the right answer was 429 plus a pause.
// undefined for a status the map says nothing about (a 400, a bad request
// built by this gateway): the prose then decides, as it did before.
function fromStatus(status: unknown): ErrorKind | undefined {
  if (typeof status !== "number") return undefined;
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth_expired";
  if (status >= 500 && status < 600) return "cli_crashed";
  return undefined;
}

function window(w: unknown): RateLimitWindow | undefined {
  if (!w || typeof w !== "object") return undefined;
  const o = w as { utilization?: number; resetsAt?: number };
  if (typeof o.utilization !== "number" || typeof o.resetsAt !== "number") return undefined;
  return { utilization: o.utilization, resetsAt: o.resetsAt };
}

export const claudeAdapter: Adapter = {
  buildCommand(cfg: ProviderConfig, model: ModelSpec, req: InternalRequest): Command {
    const { system: sent, rest } = splitSystem(req.messages);
    const system = withPreamble(cfg, sent);
    const args = [...cfg.args, ...cfg.args_extra, cfg.model_flag, model.cliModel];
    args.push(...effortArgs(cfg, effortValue(cfg, model, req.effort)));
    let prompt = flatten(rest);
    if (system) {
      // Both keys through the shared helper: `--system-prompt <text>` today,
      // because this provider declares no prefix, and the override form the
      // day the file declares one. Reading only the flag here made the prefix
      // a key the file could set and the process ignore.
      const sys = systemPromptArgs(cfg, system);
      if (sys.length) args.push(...sys);
      else prompt = `System instructions:\n${system}\n\n${prompt}`;
    }
    return { args, stdin: prompt };
  },

  async *parse(lines): AsyncIterable<ProviderEvent> {
    let sawDelta = false;
    // The dated id of the model that answered, which `--model opus` does not
    // say and the alias hides: `opus` meant Opus 5 on 2026-09-22 and Opus 5.5
    // on the 23rd, with no configuration changed and nothing in any record
    // saying which one a measurement was taken against.
    //
    // Read from `message_start` rather than from the `result` object's
    // `modelUsage` keys, although both carry it: `modelUsage` is `{}` in every
    // error capture, while `message_start` arrives before anything can go
    // wrong, so the id is known even for a run that then fails.
    let cliModelId: string | undefined;
    for await (const o of jsonLines(lines)) {
      const type = o.type;
      if (type === "stream_event") {
        const ev = o.event as { type?: string; message?: unknown; delta?: { type?: string; text?: string } } | undefined;
        if (ev?.type === "message_start") {
          const model = (ev.message as { model?: unknown } | undefined)?.model;
          if (typeof model === "string" && model.length) cliModelId = model;
        }
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
          sawDelta = true;
          yield { type: "text", delta: ev.delta.text };
        }
      } else if (type === "assistant" && !sawDelta) {
        const msg = o.message as { content?: { type?: string; text?: string }[] } | undefined;
        for (const block of msg?.content ?? []) if (block.type === "text" && block.text) yield { type: "text", delta: block.text };
      } else if (type === "rate_limit_event") {
        const info = o.rate_limit_info as { unifiedWindows?: { five_hour?: unknown; seven_day?: unknown } } | undefined;
        const fiveHour = window(info?.unifiedWindows?.five_hour);
        const sevenDay = window(info?.unifiedWindows?.seven_day);
        // An event carrying neither window says nothing: Core would store no
        // window from it, and emitting it only gives the gateway a chance to
        // act on an empty report.
        if (fiveHour || sevenDay) yield { type: "rate_limit", fiveHour, sevenDay };
      } else if (type === "result") {
        // `subtype` stays "success" on a refusal (both real captures): only
        // `is_error` says whether the run failed.
        if (o.is_error) {
          // Not `subtype`: it stays "success" on a failure (line above), so it
          // is known to say nothing. `terminal_reason` is what the real
          // capture carries alongside the prose ("api_error").
          const detail = String(o.result ?? o.terminal_reason ?? "unknown error");
          const kind = fromStatus(o.api_error_status) ?? classifyError(detail);
          // A per-model limit is not a provider-wide one: the subscription
          // kept answering on the other models while Fable was refused.
          const scoped = kind === "rate_limited" && isModelScoped(detail);
          yield { type: "error", kind, detail, ...(scoped ? { scope: "model" as const } : {}) };
          return;
        }
        const u = (o.usage ?? {}) as Record<string, number>;
        const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        yield { type: "done", usage: { input, output: u.output_tokens ?? 0 }, ...(cliModelId !== undefined ? { cliModelId } : {}) };
        return;
      }
    }
  },
};
