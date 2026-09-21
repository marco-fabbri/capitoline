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

export interface HealthStatus { ok: boolean; kind?: ErrorKind; detail?: string; checkedAt: number }

export interface Provider {
  readonly id: string;
  readonly concurrencyLimit: number;
  models(): ModelSpec[];
  execute(req: InternalRequest, model: ModelSpec, signal?: AbortSignal): AsyncIterable<ProviderEvent>;
  /** Present only for providers with an image-capable adapter; yields `image` then `done`, or `error`. */
  generateImage?(req: ImageRequest, model: ModelSpec, signal?: AbortSignal): AsyncIterable<ProviderEvent>;
  health(): Promise<HealthStatus>;
}

export function effortValue(cfg: ProviderConfig, model: ModelSpec, wanted: Effort | undefined): { effort: Effort; value: string } | null {
  const table = Object.keys(cfg.effort) as Effort[];
  if (table.length === 0) return null;
  const allowed = model.efforts ?? table;
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
 */
export function effortArgs(cfg: ProviderConfig, eff: { value: string } | null): string[] {
  if (!eff || !cfg.effort_flag) return [];
  return [cfg.effort_flag, cfg.effort_key === null ? eff.value : `${cfg.effort_key}="${eff.value}"`];
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
