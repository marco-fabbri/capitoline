import type { ProviderConfig } from "../config.js";
import { flatten, splitSystem } from "../core/prompt.js";
import type { InternalRequest, ProviderEvent } from "../core/types.js";
import { effortArgs, effortValue, jsonLines, type Adapter, type Command, type ModelSpec } from "./adapter.js";
import { classifyError } from "./errors.js";

// What a TOML basic string cannot carry and JSON.stringify does not fix for
// us: a surrogate with no partner on the other side (in either direction),
// which stringify escapes verbatim as \uD800 — no Unicode scalar, so TOML
// rejects it — and U+007F (DEL), which stringify passes through raw although
// TOML forbids it exactly like the control characters below U+0020 that
// stringify does escape. Everything else a client can send is already safe.
const TOML_UNSAFE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\u007F/g;

/** A TOML basic string for `-c key=<value>`, safe for any client text. */
function tomlString(s: string): string {
  return JSON.stringify(s.replace(TOML_UNSAFE, "�"));
}

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
    const args = [...cfg.args, cfg.model_flag, model.cliModel];
    args.push(...effortArgs(cfg, effortValue(cfg, model, req.effort)));
    let prompt = flatten(rest);
    if (system) {
      // JSON string escapes are a subset of TOML basic-string escapes, with
      // two exceptions, both of which a client can send (the system prompt is
      // its text) and either of which would kill the whole run on an
      // unparsable override instead of answering: an unpaired surrogate and a
      // raw DEL. tomlString replaces both before quoting — but only for the
      // override form, since a bare flag carries the text as it is and no TOML
      // parser ever sees it.
      if (cfg.system_prompt_flag && cfg.system_prompt_flag_prefix) {
        args.push(cfg.system_prompt_flag_prefix, `${cfg.system_prompt_flag}=${tomlString(system)}`);
      } else if (cfg.system_prompt_flag) {
        args.push(cfg.system_prompt_flag, system);
      } else prompt = `System instructions:\n${system}\n\n${prompt}`;
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
