import type { ProviderConfig } from "../config.js";
import { flatten, splitSystem } from "../core/prompt.js";
import type { AdapterEvent, ImageRequest, InternalRequest } from "../core/types.js";
import { effortArgs, effortValue, jsonLines, systemPromptArgs, type Adapter, type Command, type ImageCommand, type ModelSpec } from "./adapter.js";
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
    const args = [...cfg.args, cfg.model_flag, id];
    // One carrier for the effort, never two: a model with effort_suffix already
    // has the level inside its id, so a flag would declare the same value a
    // second time and is not added. For every other model the configuration's
    // effort_flag is honoured — none today, so this adds nothing, but a flag
    // written into the file later reaches those models without a code change.
    if (!model.effortSuffix) args.push(...effortArgs(cfg, eff));
    let prompt = flatten(rest);
    // The same shared helper the other two adapters use. This provider
    // declares neither key, so the system prompt is prepended to the prompt —
    // but a flag written into the file later reaches the CLI without a code
    // change, and a prefix set on this block can no longer pass check-config
    // and then be ignored here.
    if (system) {
      const sys = systemPromptArgs(cfg, system);
      if (sys.length) args.push(...sys);
      else prompt = `System instructions:\n${system}\n\n${prompt}`;
    }
    const stdin = JSON.stringify({ event: "user", message: { role: "user", content: prompt } }) + "\n";
    return { args, stdin };
  },

  buildImageCommand(cfg: ProviderConfig, model: ModelSpec, req: ImageRequest): ImageCommand {
    const args = [...cfg.args, ...cfg.image.args, cfg.model_flag, model.cliModel];
    const stdin = JSON.stringify({ event: "user", message: { role: "user", content: IMAGE_PROMPT(req.prompt) } }) + "\n";
    return { args, stdin };
  },

  async *parse(lines): AsyncIterable<AdapterEvent> {
    // The conversation id names the CLI-side directory the image is collected
    // from. It is announced by `init`; the `result` repeats it, which covers a
    // stream whose init line was missed. Yielded once, and only when it has
    // the UUID shape: the value comes from the CLI's stdout, which the user's
    // prompt steers, and it ends up as an argument of the collect command.
    let conversationId: string | undefined;
    // Tool steps already reported, by step_index. The CLI does not always emit
    // an ACTIVE update before the terminal one (the fixtures show steps that
    // appear once, already DONE), so "call" is tied to the first sighting of a
    // step, not to its state: every tool invocation reaches the guard.
    const seen = new Set<number>();
    for await (const o of jsonLines(lines)) {
      const event = o.event;
      if (event === "init") {
        const init = (o.init ?? {}) as { conversation_id?: unknown };
        const id = o.conversation_id ?? init.conversation_id;
        if (isConversationId(id) && !conversationId) { conversationId = id; yield { type: "meta", conversationId }; }
      } else if (event === "step_update") {
        const su = o.step_update as { step_type?: string; text_delta?: string; state?: string; step_index?: unknown; tool_name?: unknown; tool_info?: { name?: unknown } } | undefined;
        if (su?.step_type === "agent_response" && typeof su.text_delta === "string" && su.text_delta.length) yield { type: "text", delta: su.text_delta };
        else if (su?.step_type === "tool") {
          // The tool's result text is not in the stream; on ERROR the step
          // carries tool_info.error (the 429 body lives there), so raw is the
          // whole step. A step without an index cannot be correlated and is
          // reported as a new call every time (fail closed).
          const name = String(su.tool_name ?? su.tool_info?.name ?? "");
          const raw = JSON.stringify(su);
          const first = typeof su.step_index !== "number" || !seen.has(su.step_index);
          if (typeof su.step_index === "number") seen.add(su.step_index);
          const terminal = su.state === "DONE" ? "done" : su.state === "ERROR" ? "error" : undefined;
          // Every other state (ACTIVE, CANCELLED, absent) is a call, so an
          // unknown shape never bypasses the guard.
          if (first || !terminal) yield { type: "tool", phase: "call", name, raw };
          if (terminal) yield { type: "tool", phase: terminal, name, raw };
        }
      } else if (event === "result") {
        const r = (o.result ?? {}) as { status?: string; error?: string; usage?: Record<string, number>; conversation_id?: unknown };
        if (isConversationId(r.conversation_id) && !conversationId) { conversationId = r.conversation_id; yield { type: "meta", conversationId }; }
        if (r.status !== "SUCCESS") {
          const detail = String(r.error ?? r.status ?? "antigravity error");
          yield { type: "error", kind: classifyError(detail), detail };
          return;
        }
        // Both halves below are measured, each by its own fixture. The cached
        // reads: the run in test/fixtures/antigravity/usage-reasoning.json
        // (gemini-3.1-pro-high, the same prompt twice so the second one reads
        // cache) shows the CLI's own total_tokens is input_tokens +
        // output_tokens exactly, so the second run's 8092 cache_read_tokens
        // sit outside that total — they are input this turn was billed for and
        // are added here, as claude.ts adds cache_read_input_tokens. The
        // thinking tokens: a one-word answer discriminates where arithmetic on
        // the total cannot, and the run in usage-reasoning-oneword.json
        // (answer `Paris`, output=203 thinking=202) puts them inside
        // output_tokens, so output_tokens alone counts them exactly once
        // (docs/spike-2026-09.md §10). codex.ts stays the known exception: it
        // adds neither cached_input_tokens nor reasoning_output_tokens,
        // because OpenAI already reports both inside the prompt and completion
        // counts. Each adapter is therefore right for its own CLI, and the
        // three providers' figures are not comparable with each other — said
        // where the numbers are read, docs/deploy.md §9.
        const u = r.usage ?? {};
        yield { type: "done", usage: { input: (u.input_tokens ?? 0) + (u.cache_read_tokens ?? 0), output: u.output_tokens ?? 0 } };
        return;
      }
    }
  },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isConversationId(v: unknown): v is string { return typeof v === "string" && UUID.test(v); }
