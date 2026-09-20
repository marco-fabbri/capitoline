import type { ProviderConfig } from "../config.js";
import { flatten, splitSystem } from "../core/prompt.js";
import type { InternalRequest, ProviderEvent, RateLimitWindow } from "../core/types.js";
import { effortValue, jsonLines, type Adapter, type Command, type ModelSpec } from "./adapter.js";
import { classifyError } from "./errors.js";

function window(w: unknown): RateLimitWindow | undefined {
  if (!w || typeof w !== "object") return undefined;
  const o = w as { utilization?: number; resetsAt?: number };
  if (typeof o.utilization !== "number" || typeof o.resetsAt !== "number") return undefined;
  return { utilization: o.utilization, resetsAt: o.resetsAt };
}

export const claudeAdapter: Adapter = {
  buildCommand(cfg: ProviderConfig, model: ModelSpec, req: InternalRequest): Command {
    const { system, rest } = splitSystem(req.messages);
    const args = [...cfg.args, "--model", model.cliModel];
    const eff = effortValue(cfg, model, req.effort);
    if (eff) args.push("--effort", eff.value);
    let prompt = flatten(rest);
    if (system) {
      if (cfg.system_prompt_flag) args.push(cfg.system_prompt_flag, system);
      else prompt = `System instructions:\n${system}\n\n${prompt}`;
    }
    return { args, stdin: prompt };
  },

  async *parse(lines): AsyncIterable<ProviderEvent> {
    let sawDelta = false;
    for await (const o of jsonLines(lines)) {
      const type = o.type;
      if (type === "stream_event") {
        const ev = o.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
          sawDelta = true;
          yield { type: "text", delta: ev.delta.text };
        }
      } else if (type === "assistant" && !sawDelta) {
        const msg = o.message as { content?: { type?: string; text?: string }[] } | undefined;
        for (const block of msg?.content ?? []) if (block.type === "text" && block.text) yield { type: "text", delta: block.text };
      } else if (type === "rate_limit_event") {
        const info = o.rate_limit_info as { unifiedWindows?: { five_hour?: unknown; seven_day?: unknown } } | undefined;
        yield { type: "rate_limit", fiveHour: window(info?.unifiedWindows?.five_hour), sevenDay: window(info?.unifiedWindows?.seven_day) };
      } else if (type === "result") {
        if (o.is_error) {
          const detail = String(o.result ?? o.subtype ?? "unknown error");
          yield { type: "error", kind: classifyError(detail), detail };
          return;
        }
        const u = (o.usage ?? {}) as Record<string, number>;
        const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        yield { type: "done", usage: { input, output: u.output_tokens ?? 0 } };
        return;
      }
    }
  },
};
