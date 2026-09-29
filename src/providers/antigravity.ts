import type { ProviderConfig } from "../config.js";
import { flatten, splitSystem } from "../core/prompt.js";
import type { AdapterEvent, ImageRequest, InternalRequest } from "../core/types.js";
import { withPreamble, cliId, effortArgs, effortValue, jsonLines, systemPromptArgs, type Adapter, type Command, type ImageCommand, type ListedModel, type ModelSpec } from "./adapter.js";
import { classifyError } from "./errors.js";

// The CLI is an agent: the prompt names the one tool it may use and forbids
// everything else. The provider still guards the tool calls it reports.
export const IMAGE_PROMPT = (prompt: string): string =>
  `Use the generate_image tool exactly once, with ImageName "image", to create this image: ${prompt}\n` +
  "Do not create, read, copy or modify any file, do not run commands, do not open a browser. When the tool has finished, reply only with the single word: done";

// An id as `agy models` prints it: lower case, digits, dots and dashes, the
// effort already inside it (`gemini-3.8-flash-high`).
const AGY_ID = /^[a-z0-9][a-z0-9.-]*$/;

/**
 * `agy models`: one model per line, `<id>\t<display name>`, on stdout; the
 * "Fetching available models..." banner goes to stderr. Every listed model is
 * one the CLI offers, and its level is part of its id, so nothing is hidden
 * and no efforts are carried.
 */
function listAntigravityModels(stdout: string): ListedModel[] {
  return stdout.split("\n").flatMap((line) => {
    const id = line.split("\t")[0]?.trim() ?? "";
    return line.includes("\t") && AGY_ID.test(id) ? [{ id }] : [];
  });
}

export const antigravityAdapter: Adapter = {
  listModels: listAntigravityModels,

  buildCommand(cfg: ProviderConfig, model: ModelSpec, req: InternalRequest): Command {
    const { system: sent, rest } = splitSystem(req.messages);
    const system = withPreamble(cfg, sent);
    const eff = effortValue(cfg, model, req.effort);
    // The id comes from the shared resolver, which is also what Core keys a
    // model pause by: the id refused and the id recorded cannot drift apart.
    const args = [...cfg.args, ...cfg.args_extra, cfg.model_flag, cliId(cfg, model, req.effort)];
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
    const args = [...cfg.args, ...cfg.args_extra, ...cfg.image.args, cfg.model_flag, model.cliModel];
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
    // Evidence for a fault not yet understood (docs/backlog.md, "Antigravity
    // text can arrive twice"): two answers in the measurements held a
    // truncated beginning followed by the whole text again. A text run of the
    // real captures has one response step; an image run has two, the first
    // empty. So text in more than one response step, or text arriving after a
    // step reported DONE, is logged with the run's shape — events, steps,
    // states and lengths, never the text — and nothing else changes.
    const shape: Record<string, unknown>[] = [];
    const textByStep = new Map<string, number>();
    const doneSteps = new Set<string>();
    let textAfterDone = false;
    for await (const o of jsonLines(lines)) {
      const event = o.event;
      if (event !== "step_update" && shape.length < SHAPE_CAP) shape.push({ event });
      if (event === "init") {
        const init = (o.init ?? {}) as { conversation_id?: unknown };
        const id = o.conversation_id ?? init.conversation_id;
        if (isConversationId(id) && !conversationId) { conversationId = id; yield { type: "meta", conversationId }; }
      } else if (event === "step_update") {
        const su = o.step_update as { step_type?: string; text_delta?: string; state?: string; step_index?: unknown; tool_name?: unknown; tool_info?: { name?: unknown } } | undefined;
        const deltaChars = typeof su?.text_delta === "string" ? su.text_delta.length : 0;
        if (shape.length < SHAPE_CAP) shape.push({ event, step_type: su?.step_type, step_index: su?.step_index, state: su?.state, deltaChars });
        if (su?.step_type === "agent_response") {
          const step = String(su.step_index ?? "?");
          // The DONE update carries the step's last delta itself, so text is
          // "after DONE" only when it comes in a later event.
          if (deltaChars > 0 && doneSteps.has(step)) textAfterDone = true;
          textByStep.set(step, (textByStep.get(step) ?? 0) + deltaChars);
          if (su.state === "DONE") doneSteps.add(step);
        }
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
        const texted = [...textByStep.values()].filter((n) => n > 0).length;
        if (texted > 1 || textAfterDone) {
          yield { type: "diagnostic", message: "antigravity response text came from more than one response step", data: { steps: Object.fromEntries(textByStep), textAfterDone, shape } };
        }
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

// How many events of a run's shape a diagnostic carries: enough for any answer
// seen so far, bounded for the one that streams without end.
const SHAPE_CAP = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isConversationId(v: unknown): v is string { return typeof v === "string" && UUID.test(v); }
