import type { ProviderConfig } from "../config.js";
import { flatten, splitSystem } from "../core/prompt.js";
import type { InternalRequest, ProviderEvent } from "../core/types.js";
import { effortValue, jsonLines, type Adapter, type Command, type ModelSpec } from "./adapter.js";
import { classifyError } from "./errors.js";

export const antigravityAdapter: Adapter = {
  buildCommand(cfg: ProviderConfig, model: ModelSpec, req: InternalRequest): Command {
    const { system, rest } = splitSystem(req.messages);
    let id = model.cliModel;
    const eff = effortValue(cfg, model, req.effort);
    if (model.effortSuffix && eff) id = `${id}-${eff.value}`;
    const args = [...cfg.args, "--model", id];
    let prompt = flatten(rest);
    if (system) prompt = `System instructions:\n${system}\n\n${prompt}`;
    const stdin = JSON.stringify({ event: "user", message: { role: "user", content: prompt } }) + "\n";
    return { args, stdin };
  },

  async *parse(lines): AsyncIterable<ProviderEvent> {
    for await (const o of jsonLines(lines)) {
      const event = o.event;
      if (event === "step_update") {
        const su = o.step_update as { step_type?: string; text_delta?: string } | undefined;
        if (su?.step_type === "agent_response" && typeof su.text_delta === "string" && su.text_delta.length) yield { type: "text", delta: su.text_delta };
      } else if (event === "result") {
        const r = (o.result ?? {}) as { status?: string; error?: string; usage?: Record<string, number> };
        if (r.status !== "SUCCESS") {
          const detail = String(r.error ?? r.status ?? "antigravity error");
          yield { type: "error", kind: classifyError(detail), detail };
          return;
        }
        yield { type: "done", usage: { input: r.usage?.input_tokens ?? 0, output: r.usage?.output_tokens ?? 0 } };
        return;
      }
    }
  },
};
