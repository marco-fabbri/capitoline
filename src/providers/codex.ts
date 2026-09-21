import type { ProviderConfig } from "../config.js";
import { flatten, splitSystem } from "../core/prompt.js";
import type { InternalRequest, ProviderEvent } from "../core/types.js";
import { effortArgs, effortValue, jsonLines, type Adapter, type Command, type ModelSpec } from "./adapter.js";
import { classifyError } from "./errors.js";

export const codexAdapter: Adapter = {
  buildCommand(cfg: ProviderConfig, model: ModelSpec, req: InternalRequest): Command {
    const { system, rest } = splitSystem(req.messages);
    const args = [...cfg.args, cfg.model_flag, model.cliModel];
    args.push(...effortArgs(cfg, effortValue(cfg, model, req.effort)));
    let prompt = flatten(rest);
    if (system) {
      // JSON string escapes are a subset of TOML basic-string escapes, so
      // JSON.stringify yields a valid TOML value for `-c key=<value>`. The
      // "-c" here is the CLI's override flag for a key that the configuration
      // names (system_prompt_flag), not a model or effort flag.
      if (cfg.system_prompt_flag) args.push("-c", `${cfg.system_prompt_flag}=${JSON.stringify(system)}`);
      else prompt = `System instructions:\n${system}\n\n${prompt}`;
    }
    args.push("-");
    return { args, stdin: prompt };
  },

  async *parse(lines): AsyncIterable<ProviderEvent> {
    for await (const o of jsonLines(lines)) {
      const type = o.type;
      if (type === "item.completed") {
        const item = o.item as { type?: string; text?: string } | undefined;
        if (item?.type === "agent_message" && typeof item.text === "string") yield { type: "text", delta: item.text };
      } else if (type === "turn.completed") {
        const u = (o.usage ?? {}) as Record<string, number>;
        yield { type: "done", usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 } };
        return;
      } else if (type === "turn.failed" || type === "error") {
        const err = (o.error ?? o) as { message?: string };
        const detail = String(err.message ?? "codex error");
        yield { type: "error", kind: classifyError(detail), detail };
        return;
      }
    }
  },
};
