import type { ProviderConfig } from "../config.js";
import { flatten, splitSystem } from "../core/prompt.js";
import type { InternalRequest, ProviderEvent } from "../core/types.js";
import { effortArgs, effortValue, jsonLines, systemPromptArgs, type Adapter, type Command, type ModelSpec } from "./adapter.js";
import { classifyError } from "./errors.js";

// What the CLI said, from an event whose `error` is an object with a message,
// a bare string (a 429 has been reported that way) or nothing at all. The
// string case used to fall through `(o.error ?? o).message`, which is
// undefined on a string: the message was lost and a rate limit was answered
// 502 as a crash instead of 429 with a pause.
function errorDetail(o: Record<string, unknown>): string {
  const err = o.error ?? o;
  // Same guard as the object branch below: an empty string is no more of a
  // message than a missing one, and it would reach the log and classifyError
  // as "".
  if (typeof err === "string") return err.length ? err : "codex error";
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && message.length ? message : "codex error";
}

export const codexAdapter: Adapter = {
  buildCommand(cfg: ProviderConfig, model: ModelSpec, req: InternalRequest): Command {
    const { system, rest } = splitSystem(req.messages);
    const args = [...cfg.args, ...cfg.args_extra, cfg.model_flag, model.cliModel];
    args.push(...effortArgs(cfg, effortValue(cfg, model, req.effort)));
    let prompt = flatten(rest);
    if (system) {
      // `-c developer_instructions="<text>"` today, both parts named by the
      // configuration. The TOML quoting of the client's own text lives in the
      // helper, next to the bare form the CLIs that take the system prompt as
      // a flag of their own use, so one implementation reads both keys.
      const sys = systemPromptArgs(cfg, system);
      if (sys.length) args.push(...sys);
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
