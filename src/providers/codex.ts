import type { ProviderConfig } from "../config.js";
import { flatten, splitSystem } from "../core/prompt.js";
import type { InternalRequest, ProviderEvent } from "../core/types.js";
import { effortArgs, effortValue, jsonLines, type Adapter, type Command, type ModelSpec } from "./adapter.js";
import { classifyError } from "./errors.js";

// A surrogate with no partner on the other side, in either direction.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** A TOML basic string for `-c key=<value>`, safe for any client text. */
function tomlString(s: string): string {
  return JSON.stringify(s.replace(LONE_SURROGATE, "�"));
}

// What the CLI said, from an event whose `error` is an object with a message,
// a bare string (a 429 has been reported that way) or nothing at all. The
// string case used to fall through `(o.error ?? o).message`, which is
// undefined on a string: the message was lost and a rate limit was answered
// 502 as a crash instead of 429 with a pause.
function errorDetail(o: Record<string, unknown>): string {
  const err = o.error ?? o;
  if (typeof err === "string") return err;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && message.length ? message : "codex error";
}

export const codexAdapter: Adapter = {
  buildCommand(cfg: ProviderConfig, model: ModelSpec, req: InternalRequest): Command {
    const { system, rest } = splitSystem(req.messages);
    const args = [...cfg.args, cfg.model_flag, model.cliModel];
    args.push(...effortArgs(cfg, effortValue(cfg, model, req.effort)));
    let prompt = flatten(rest);
    if (system) {
      // JSON string escapes are a subset of TOML basic-string escapes, with
      // one exception: an unpaired surrogate, which JSON.stringify emits as
      // \uD800 (well-formed stringify, ES2019) and which TOML rejects, since
      // it is no Unicode scalar. A client can send one — the system prompt is
      // its text — and the whole run would then die on an unparsable override
      // instead of answering, so each unpaired half is replaced first. The
      // "-c" here is the CLI's override flag for a key that the configuration
      // names (system_prompt_flag), not a model or effort flag.
      if (cfg.system_prompt_flag) args.push("-c", `${cfg.system_prompt_flag}=${tomlString(system)}`);
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
        const detail = errorDetail(o);
        yield { type: "error", kind: classifyError(detail), detail };
        return;
      }
    }
  },
};
