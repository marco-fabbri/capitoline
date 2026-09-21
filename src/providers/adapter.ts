import type { Effort, ModelKind, ProviderConfig } from "../config.js";
import { nearestEffort } from "../core/prompt.js";
import type { AdapterEvent, ErrorKind, ImageRequest, InternalRequest, ProviderEvent } from "../core/types.js";

export type { ModelKind };
export interface ModelSpec {
  name: string;
  provider: string;
  cliModel: string;
  effortSuffix: boolean;
  efforts?: Effort[];
  kind: ModelKind;
  /** Per-model timeout overriding the provider's timeout_s (image runs are long). */
  timeoutS?: number;
}
export interface Command { args: string[]; stdin: string }
export type ImageCommand = Command;

export interface Adapter {
  buildCommand(cfg: ProviderConfig, model: ModelSpec, req: InternalRequest): Command;
  /** May yield adapter-internal events (meta, tool); the provider consumes them. */
  parse(lines: AsyncIterable<string>): AsyncIterable<AdapterEvent>;
  /** Present only for adapters whose CLI can generate images. */
  buildImageCommand?(cfg: ProviderConfig, model: ModelSpec, req: ImageRequest): ImageCommand;
}

// The verdict of one probe. `scope` and `model` carry the same attribution the
// error events do: a refusal the CLI blamed on the model the probe happened to
// run says nothing about the provider, so Core pauses that model instead of
// marking the whole provider unhealthy.
export interface HealthStatus {
  ok: boolean; kind?: ErrorKind; detail?: string; checkedAt: number;
  scope?: "model";
  /** The model the probe ran; set on a failure, so a model-scoped one can be attributed. */
  model?: string;
}

export interface Provider {
  readonly id: string;
  readonly concurrencyLimit: number;
  /**
   * The single model health() probes, when the provider runs one. Core reads
   * it to skip a probe whose model is already paused: without it the gateway
   * spends a call at every startup and every hourly round to rediscover a
   * refusal it has written down.
   */
  readonly healthModel?: string;
  models(): ModelSpec[];
  execute(req: InternalRequest, model: ModelSpec, signal?: AbortSignal): AsyncIterable<ProviderEvent>;
  /** Present only for providers with an image-capable adapter; yields `image` then `done`, or `error`. */
  generateImage?(req: ImageRequest, model: ModelSpec, signal?: AbortSignal): AsyncIterable<ProviderEvent>;
  health(): Promise<HealthStatus>;
}

/**
 * The effort level a request runs at, and the value the CLI is given for it:
 * the level the caller asked for when the model offers it, the nearest one
 * otherwise, and null when the provider has no value to send at all.
 *
 * The candidates are the model's own `efforts` **intersected with the
 * provider's effort table**. The configuration already refuses a model
 * declaring an effort the table does not price, but the file the service reads
 * is the hand-edited copy on the host, and the intersection is what keeps a
 * mismatch that slips into it from dropping the effort altogether: before it,
 * a model offering low/high against a table holding only `low` resolved to
 * `high`, found no value for it and returned null, so the run took the CLI's
 * own default with nothing said anywhere. With the intersection it runs at
 * `low` — not the level asked for, but a declared one.
 *
 * `nearestEffort` breaks a tie towards the **higher** level: "medium" on a
 * model offering only low/high runs high. Decided in B2 (2026-09-21) and kept
 * rather than flipped. An effort the caller named is the quality they expect,
 * and nothing in the response could tell them the cheap level ran instead,
 * while the cost of the opposite mistake is latency and quota, which /health
 * reports and the budget windows already track. The only model the rule
 * touches today is `agy-gemini-pro` (`efforts: [low, high]`, no medium in the
 * CLI's ids), whose default requests on the deployed host all resolve to
 * `gemini-3.1-pro-high`: flipping the tie-break would silently downgrade every
 * one of them with no request having asked for it. A caller who wants the
 * cheap level asks for `low`, which is never approximated away.
 */
export function effortValue(cfg: ProviderConfig, model: ModelSpec, wanted: Effort | undefined): { effort: Effort; value: string } | null {
  const table = Object.keys(cfg.effort) as Effort[];
  if (table.length === 0) return null;
  const allowed = (model.efforts ?? table).filter((e) => Object.hasOwn(cfg.effort, e));
  if (allowed.length === 0) return null;
  const effort = nearestEffort(wanted ?? "medium", allowed);
  const value = cfg.effort[effort];
  if (value === undefined) return null;
  return { effort, value };
}

/**
 * The arguments that carry the effort to the CLI, all of them named by the
 * configuration: none when the provider declares no `effort_flag` (the effort
 * then travels inside the model id, or not at all), `<flag> <value>` normally,
 * and `<flag> <key>="<value>"` when `effort_key` is set, because the CLI takes
 * the effort as a configuration override rather than as a flag of its own.
 * The quoted form goes through JSON.stringify, as the system prompt does in
 * systemPromptArgs below: JSON string escapes are a subset of TOML's, so a
 * value holding a quote or a backslash still produces a valid override instead
 * of a run that fails on unparsable TOML. Values reach here from the configuration's effort
 * table, never from a request, which only picks the level.
 */
export function effortArgs(cfg: ProviderConfig, eff: { value: string } | null): string[] {
  if (!eff || !cfg.effort_flag) return [];
  return [cfg.effort_flag, cfg.effort_key === null ? eff.value : `${cfg.effort_key}=${JSON.stringify(eff.value)}`];
}

// What a TOML basic string cannot carry and JSON.stringify does not fix for
// us: a surrogate with no partner on the other side (in either direction),
// which stringify escapes verbatim as \uD800 — no Unicode scalar, so TOML
// rejects it — and U+007F (DEL), which stringify passes through raw although
// TOML forbids it exactly like the control characters below U+0020 that
// stringify does escape. Everything else a client can send is already safe.
const TOML_UNSAFE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\u007F/g;

/** A TOML basic string for `<prefix> key=<value>`, safe for any client text. */
function tomlString(s: string): string {
  return JSON.stringify(s.replace(TOML_UNSAFE, "\uFFFD"));
}

/**
 * The arguments that carry the system prompt to the CLI, both flags named by
 * the configuration: none when the provider declares no `system_prompt_flag`
 * — the caller then prepends the text to the prompt itself, which is the only
 * thing left to do with it — `<flag> <text>` when `system_prompt_flag_prefix`
 * is null, and `<prefix> <flag>="<text>"` when it is set, because the CLI
 * takes the system prompt as a configuration override rather than as a flag
 * of its own (Codex: `-c developer_instructions="..."`).
 *
 * Shared by every adapter on purpose, like effortArgs above. The key is
 * required in every provider block, so while only codex.ts read it a `-c` on
 * the `providers.claude` block of the host's file passed `check-config` and
 * changed nothing on the command line: the file said one thing and the process
 * did another, with the validation silent — the drift the key exists to stop,
 * turned around. One implementation reads it for all three.
 *
 * Only the override form goes through `tomlString`: JSON string escapes are a
 * subset of TOML basic-string escapes, with two exceptions a client can send
 * inside its system prompt (an unpaired surrogate and a raw DEL), either of
 * which would kill the whole run on an unparsable override instead of
 * answering. A bare flag carries the text as it is and no TOML parser ever
 * sees it.
 */
export function systemPromptArgs(cfg: ProviderConfig, system: string): string[] {
  if (!cfg.system_prompt_flag) return [];
  if (cfg.system_prompt_flag_prefix === null) return [cfg.system_prompt_flag, system];
  return [cfg.system_prompt_flag_prefix, `${cfg.system_prompt_flag}=${tomlString(system)}`];
}

export function modelSpecs(providerId: string, cfg: ProviderConfig): ModelSpec[] {
  return Object.entries(cfg.models).map(([name, m]) => ({
    name, provider: providerId, cliModel: m.cli_model, effortSuffix: m.effort_suffix, efforts: m.efforts, kind: m.kind, timeoutS: m.timeout_s,
  }));
}

export async function* jsonLines(lines: AsyncIterable<string>): AsyncIterable<Record<string, unknown>> {
  for await (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try { yield JSON.parse(t) as Record<string, unknown>; } catch { /* partial or non-JSON line: ignored */ }
  }
}
