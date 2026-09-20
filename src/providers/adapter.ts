import type { Effort, ProviderConfig } from "../config.js";
import { nearestEffort } from "../core/prompt.js";
import type { ErrorKind, InternalRequest, ProviderEvent } from "../core/types.js";

export interface ModelSpec { name: string; provider: string; cliModel: string; effortSuffix: boolean; efforts?: Effort[] }
export interface Command { args: string[]; stdin: string }

export interface Adapter {
  buildCommand(cfg: ProviderConfig, model: ModelSpec, req: InternalRequest): Command;
  parse(lines: AsyncIterable<string>): AsyncIterable<ProviderEvent>;
}

export interface HealthStatus { ok: boolean; kind?: ErrorKind; detail?: string; checkedAt: number }

export interface Provider {
  readonly id: string;
  readonly concurrencyLimit: number;
  models(): ModelSpec[];
  execute(req: InternalRequest, model: ModelSpec, signal?: AbortSignal): AsyncIterable<ProviderEvent>;
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

export function modelSpecs(providerId: string, cfg: ProviderConfig): ModelSpec[] {
  return Object.entries(cfg.models).map(([name, m]) => ({
    name, provider: providerId, cliModel: m.cli_model, effortSuffix: m.effort_suffix, efforts: m.efforts,
  }));
}

export async function* jsonLines(lines: AsyncIterable<string>): AsyncIterable<Record<string, unknown>> {
  for await (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try { yield JSON.parse(t) as Record<string, unknown>; } catch { /* partial or non-JSON line: ignored */ }
  }
}
