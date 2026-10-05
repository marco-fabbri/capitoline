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

/**
 * One model as the CLI's own listing names it (the daily catalog,
 * docs/deploy.md §7.2). `efforts` is the levels it serves, translated into the
 * gateway's scale through the provider's effort table, when the listing says;
 * `hidden` is a model the CLI serves but does not offer, which discovery never
 * exposes on its own and never counts as retired while it is still listed.
 */
export interface ListedModel { id: string; efforts?: Effort[]; hidden?: boolean }

/** What a new listing changed: names now served that were not, and names no longer served. */
export interface CatalogChange { added: string[]; removed: string[] }
export type ImageCommand = Command;

export interface Adapter {
  buildCommand(cfg: ProviderConfig, model: ModelSpec, req: InternalRequest): Command;
  /** May yield adapter-internal events (meta, tool); the provider consumes them. */
  parse(lines: AsyncIterable<string>): AsyncIterable<AdapterEvent>;
  /** Present only for adapters whose CLI can generate images. */
  buildImageCommand?(cfg: ProviderConfig, model: ModelSpec, req: ImageRequest): ImageCommand;
  /**
   * Reads the output of the CLI's listing command (`discover.args`). Present
   * only for CLIs that have one. Throws when the output is not a listing:
   * a catalog must never be replaced by a misread one.
   */
  listModels?(stdout: string, cfg: ProviderConfig): ListedModel[];
  /**
   * Reads the output of the CLI's own quota report (`quota.args`). Present
   * only for CLIs that have one. Throws when the output is not a report.
   */
  readQuota?(stdout: string): QuotaBucket[];
}

/**
 * One bucket of a subscription's quota, as the CLI itself reports it: which
 * models share it (`group`), over what window, the share still unspent (0 to
 * 1) and when it refills. Not something the gateway counts: the provider's
 * own figure, read without a model call.
 */
export interface QuotaBucket { id: string; group: string; window: string; remaining: number; resetsAt: number | null }

// The verdict of one probe. `scope` and `model` carry the same attribution the
// error events do: a refusal the CLI blamed on the model the probe happened to
// run says nothing about the provider, so Core pauses that model instead of
// marking the whole provider unhealthy.
export interface HealthStatus {
  ok: boolean; kind?: ErrorKind; detail?: string; checkedAt: number;
  scope?: "model";
  /** The model the probe ran; set on a failure, so a model-scoped one can be attributed. */
  model?: string;
  /**
   * The id the probe actually sent to the CLI, which is what a pause is keyed
   * by. The probe picks its own effort, so this is not derivable from `model`
   * by a caller that does not know which one: the provider states it.
   */
  cliId?: string;
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
  /** The id `healthModel` resolves to at the effort the probe runs, so Core can key its pause the same way. */
  readonly healthCliId?: string;
  models(): ModelSpec[];
  /** Whether its CLI can be handed images (config `attachments`); Core refuses them otherwise. */
  readonly acceptsAttachments?: boolean;
  /**
   * The id this provider will send to its CLI for `model` at `effort`, which
   * is the thing a quota refusal is actually about. Two gateway names can
   * resolve to one id — `antigravity-gemini-pro` at the default effort is
   * `gemini-3.1-pro-high`, which `antigravity-gemini-pro-high` names outright — and
   * before this the pause was keyed by the name that made the call, so the
   * other alias spent a call rediscovering the same exhausted model.
   */
  cliId(model: ModelSpec, effort?: Effort): string;
  execute(req: InternalRequest, model: ModelSpec, signal?: AbortSignal): AsyncIterable<ProviderEvent>;
  /** Present only for providers with an image-capable adapter; yields `image` then `done`, or `error`. */
  generateImage?(req: ImageRequest, model: ModelSpec, signal?: AbortSignal): AsyncIterable<ProviderEvent>;
  health(): Promise<HealthStatus>;
  /** True for a provider whose configuration declares `discover` and whose adapter can read the listing. */
  readonly discovers?: boolean;
  /** Runs the CLI's listing command. Throws on any failure, including an empty listing. */
  listModels?(): Promise<ListedModel[]>;
  /** Replaces the catalog with a listing and says what that changed. `models()` reflects it at once. */
  applyListing?(listed: ListedModel[]): CatalogChange;
  /** A declared model none of whose CLI ids the current listing holds. */
  isRetired?(model: ModelSpec): boolean;
  /** The names discovery added, and the declared names it retired, as they stand. */
  catalogNames?(): { discovered: string[]; retired: string[] };
  /** True for a provider whose configuration declares `sweep`. */
  readonly sweeps?: boolean;
  /** Removes the conversations the CLI left that no run forgot. Never throws. */
  sweep?(): Promise<void>;
  /** True for a provider whose configuration declares `quota` and whose adapter can read the report. */
  readonly reportsQuota?: boolean;
  /** Runs the CLI's quota report. Throws on any failure, including a report with no bucket. */
  quota?(): Promise<QuotaBucket[]>;
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
 * touches today is `antigravity-gemini-pro` (`efforts: [low, high]`, no medium in the
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
 * The id the CLI is given for this model at this effort: the model's own
 * `cli_model`, with the effort's value appended when the provider carries the
 * level inside the id rather than in a flag (`effort_suffix`).
 *
 * The one place that rule lives. `antigravity.ts` builds its command line from
 * this and `Core` keys its model pauses by it, so the id a refusal is recorded
 * against is by construction the id that was sent — which it was not while
 * `Core` used the gateway name and the suffix was applied in the adapter.
 */
export function cliId(cfg: ProviderConfig, model: ModelSpec, wanted: Effort | undefined): string {
  if (!model.effortSuffix) return model.cliModel;
  const eff = effortValue(cfg, model, wanted);
  return eff ? `${model.cliModel}-${eff.value}` : model.cliModel;
}

/**
 * Every CLI id a model can resolve to: its `cli_model`, or, when the effort
 * completes the id, one id per level it offers. What the catalog compares a
 * listing against — a model is still served while any one of them is listed.
 */
export function reachableIds(cfg: ProviderConfig, model: ModelSpec): string[] {
  if (!model.effortSuffix) return [model.cliModel];
  const levels = (model.efforts ?? (Object.keys(cfg.effort) as Effort[])).filter((e) => Object.hasOwn(cfg.effort, e));
  return [...new Set(levels.map((e) => `${model.cliModel}-${cfg.effort[e]}`))];
}

/**
 * The gateway's levels whose value in the provider's effort table is one the
 * CLI says a model serves: the inverse of the table, for a listing that
 * reports levels (Codex). Undefined when the listing names none the table
 * prices, so the model is offered the table as it stands rather than nothing.
 */
export function effortsFromLevels(cfg: ProviderConfig, levels: string[]): Effort[] | undefined {
  const served = new Set(levels);
  const efforts = (Object.keys(cfg.effort) as Effort[]).filter((e) => served.has(cfg.effort[e]!));
  return efforts.length > 0 ? efforts : undefined;
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
/**
 * The system prompt a text run is given: the provider's standing preamble,
 * then whatever the client sent, in that order so the client can still narrow
 * what the preamble says. Null when there is neither. Shared by the three
 * adapters for the reason systemPromptArgs is: a key every provider block
 * carries must mean the same thing for all three, or the file says one thing
 * and the process does another.
 */
export function withPreamble(cfg: ProviderConfig, system: string | null): string | null {
  if (cfg.system_preamble === null) return system;
  return system === null ? cfg.system_preamble : `${cfg.system_preamble}\n\n${system}`;
}

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
