import type { ProviderConfig } from "../config.js";
import { flatten, splitSystem } from "../core/prompt.js";
import type { AdapterEvent, ImageRequest, InternalRequest } from "../core/types.js";
import { effortValue, jsonLines, type Adapter, type Command, type ImageCommand, type ModelSpec } from "./adapter.js";
import { classifyError } from "./errors.js";

// The CLI is an agent: the prompt names the one tool it may use and forbids
// everything else. The provider still guards the tool calls it reports.
export const IMAGE_PROMPT = (prompt: string): string =>
  `Use the generate_image tool exactly once, with ImageName "image", to create this image: ${prompt}\n` +
  "Do not create, read, copy or modify any file, do not run commands, do not open a browser. When the tool has finished, reply only with the single word: done";

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

  buildImageCommand(cfg: ProviderConfig, model: ModelSpec, req: ImageRequest): ImageCommand {
    const args = [...cfg.args, ...cfg.image.args, "--model", model.cliModel];
    const stdin = JSON.stringify({ event: "user", message: { role: "user", content: IMAGE_PROMPT(req.prompt) } }) + "\n";
    return { args, stdin };
  },

  async *parse(lines): AsyncIterable<AdapterEvent> {
    // The conversation id names the CLI-side directory the image is collected
    // from. It is announced by `init`; the `result` repeats it, which covers a
    // stream whose init line was missed. Yielded once.
    let conversationId: string | undefined;
    for await (const o of jsonLines(lines)) {
      const event = o.event;
      if (event === "init") {
        const init = (o.init ?? {}) as { conversation_id?: unknown };
        const id = o.conversation_id ?? init.conversation_id;
        if (typeof id === "string" && id && !conversationId) { conversationId = id; yield { type: "meta", conversationId }; }
      } else if (event === "step_update") {
        const su = o.step_update as { step_type?: string; text_delta?: string; state?: string; tool_name?: string } | undefined;
        if (su?.step_type === "agent_response" && typeof su.text_delta === "string" && su.text_delta.length) yield { type: "text", delta: su.text_delta };
        else if (su?.step_type === "tool") {
          // A tool step is reported ACTIVE, then DONE or ERROR. The tool's
          // result text is not in the stream; on ERROR the step carries
          // tool_info.error (the 429 body lives there), so raw is the whole step.
          const phase = su.state === "DONE" ? "done" : su.state === "ERROR" ? "error" : "call";
          yield { type: "tool", phase, name: String(su.tool_name ?? ""), raw: JSON.stringify(su) };
        }
      } else if (event === "result") {
        const r = (o.result ?? {}) as { status?: string; error?: string; usage?: Record<string, number>; conversation_id?: unknown };
        if (typeof r.conversation_id === "string" && r.conversation_id && !conversationId) { conversationId = r.conversation_id; yield { type: "meta", conversationId }; }
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
