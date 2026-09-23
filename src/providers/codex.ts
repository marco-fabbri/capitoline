import type { ProviderConfig } from "../config.js";
import { flatten, splitSystem } from "../core/prompt.js";
import type { AdapterEvent, ImageRequest, InternalRequest } from "../core/types.js";
import { withPreamble, effortArgs, effortValue, jsonLines, systemPromptArgs, type Adapter, type Command, type ImageCommand, type ModelSpec } from "./adapter.js";
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

// The image run's whole prompt. Codex's built-in image generation runs on the
// ChatGPT subscription with no API key (docs/spike-2026-09.md, 2026-09-23), and
// like Antigravity's it is an agent calling a tool: the prompt names the one
// thing to do and forbids the rest. Same wording as Antigravity's IMAGE_PROMPT
// but for the tool's name, which is not Codex's.
export const CODEX_IMAGE_PROMPT = (prompt: string): string =>
  `Use the image generation tool exactly once to create this image: ${prompt}\n` +
  "Do not create, read, copy or modify any file, do not run commands, do not open a browser. When the tool has finished, reply only with the single word: done";

// The item types that are the model's own words or thinking. Every other item
// is a step the agent took — a command, a file change, an MCP tool call, a web
// search — and is reported as a tool step so the image path can refuse one it
// did not ask for. `error` is not a step either: Codex uses it for its own
// warnings, "ignoring 1 unrecognized configuration setting" among them, and
// treating that as a tool call would abort every image run a stale override
// produced a warning for.
const NOT_A_TOOL = new Set(["agent_message", "reasoning", "error"]);

export const codexAdapter: Adapter = {
  buildCommand(cfg: ProviderConfig, model: ModelSpec, req: InternalRequest): Command {
    const { system: sent, rest } = splitSystem(req.messages);
    const system = withPreamble(cfg, sent);
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

  // The image run. `image.args` come after the text-run lockdown, so the one
  // feature they switch back on — image generation — wins: Codex applies the
  // later of two overrides of one key, checked on the host by a run that
  // generated with exactly this order. The agent runs at the model's lowest
  // declared effort, since all it has to decide is to call one tool.
  buildImageCommand(cfg: ProviderConfig, model: ModelSpec, req: ImageRequest): ImageCommand {
    const args = [...cfg.args, ...cfg.args_extra, ...cfg.image.args, cfg.model_flag, model.cliModel];
    args.push(...effortArgs(cfg, effortValue(cfg, model, "low")));
    args.push("-");
    return { args, stdin: CODEX_IMAGE_PROMPT(req.prompt) };
  },

  async *parse(lines): AsyncIterable<AdapterEvent> {
    // Item ids already reported as a tool call. Codex may report a step only
    // once it has completed, so the call is tied to the first sighting of an
    // id rather than to item.started: every step reaches the image path's guard.
    const seen = new Set<string>();
    for await (const o of jsonLines(lines)) {
      const type = o.type;
      if (type === "thread.started") {
        // The directory a generated image lands in is named after this id
        // (~/.codex/generated_images/<thread_id>/): it is what the collect
        // helper is given. The provider checks its shape before using it.
        if (typeof o.thread_id === "string") yield { type: "meta", conversationId: o.thread_id };
        continue;
      }
      if (type === "item.started" || type === "item.completed") {
        const item = (o.item ?? {}) as { id?: unknown; type?: string; text?: string; tool?: unknown; status?: unknown };
        if (item.type !== undefined && !NOT_A_TOOL.has(item.type)) {
          const name = typeof item.tool === "string" && item.tool ? item.tool : item.type;
          const raw = JSON.stringify(item);
          const id = typeof item.id === "string" ? item.id : undefined;
          if (id === undefined || !seen.has(id)) yield { type: "tool", phase: "call", name, raw };
          if (id !== undefined) seen.add(id);
          if (type === "item.completed") yield { type: "tool", phase: item.status === "failed" || item.status === "error" ? "error" : "done", name, raw };
          continue;
        }
      }
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
