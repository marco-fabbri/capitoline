import type { Logger } from "../log.js";
import type { HealthStatus, ModelSpec, Provider } from "../providers/adapter.js";
import type { UsageStore } from "../usage/store.js";
import { Semaphore } from "./semaphore.js";
import { CapitolineError, type ErrorKind, type InternalRequest, type ProviderEvent } from "./types.js";

export interface ModelInfo { name: string; provider: string; available: boolean; reason?: string; overBudget: boolean }
export interface ProviderState {
  id: string; health: HealthStatus | null; pausedUntil: number | null; strikes: number; overBudget: boolean;
  windows: ReturnType<UsageStore["windows"]>; active: number; waiting: number;
}
export interface CoreOptions { maxWaitMs: number; budgets: Record<string, { window5h: number; window7d: number }>; log: Logger; now?: () => number }

const H5 = 5 * 3600_000, D7 = 7 * 24 * 3600_000;

interface State { provider: Provider; sem: Semaphore; health: HealthStatus | null; pausedUntil: number | null; strikes: number; windowOverBudget: boolean }

export class Core {
  private readonly states = new Map<string, State>();
  private readonly modelIndex = new Map<string, { provider: Provider; model: ModelSpec }>();
  private readonly now: () => number;

  constructor(providers: Provider[], private readonly usage: UsageStore, private readonly opts: CoreOptions) {
    this.now = opts.now ?? Date.now;
    for (const p of providers) {
      this.states.set(p.id, { provider: p, sem: new Semaphore(p.concurrencyLimit), health: null, pausedUntil: null, strikes: 0, windowOverBudget: false });
      for (const m of p.models()) this.modelIndex.set(m.name, { provider: p, model: m });
    }
  }

  private unavailableReason(s: State): string | undefined {
    if (s.health && !s.health.ok) return s.health.kind ?? "unhealthy";
    if (s.pausedUntil !== null && s.pausedUntil > this.now()) return "rate_limited";
    return undefined;
  }

  private overBudget(id: string, s: State): boolean {
    if (s.windowOverBudget) return true;
    const b = this.opts.budgets[id];
    if (!b) return false;
    const now = this.now();
    const t5 = this.usage.totals(id, H5, now), t7 = this.usage.totals(id, D7, now);
    return (b.window5h > 0 && t5.inputTokens + t5.outputTokens >= b.window5h) || (b.window7d > 0 && t7.inputTokens + t7.outputTokens >= b.window7d);
  }

  listModels(): ModelInfo[] {
    const out: ModelInfo[] = [];
    for (const [id, s] of this.states) {
      const reason = this.unavailableReason(s);
      const overBudget = this.overBudget(id, s);
      for (const m of s.provider.models()) out.push({ name: m.name, provider: id, available: reason === undefined, reason, overBudget });
    }
    return out;
  }

  providerStates(): ProviderState[] {
    return [...this.states].map(([id, s]) => ({
      id, health: s.health, pausedUntil: s.pausedUntil, strikes: s.strikes, overBudget: this.overBudget(id, s),
      windows: this.usage.windows(id), active: s.sem.active, waiting: s.sem.waiting,
    }));
  }

  async *execute(req: InternalRequest, ctx: { signal?: AbortSignal; source: "http" | "mcp" }): AsyncIterable<ProviderEvent> {
    const entry = this.modelIndex.get(req.model);
    if (!entry) throw new CapitolineError("unknown_model", `unknown model "${req.model}"`);
    const s = this.states.get(entry.provider.id)!;
    if (s.pausedUntil !== null && s.pausedUntil > this.now()) {
      const retry = Math.ceil((s.pausedUntil - this.now()) / 1000);
      throw new CapitolineError("rate_limited", `provider ${entry.provider.id} is paused after a rate limit`, retry);
    }
    const reason = this.unavailableReason(s);
    if (reason) throw new CapitolineError("model_unavailable", `model "${req.model}" unavailable: ${reason}`);

    const release = await s.sem.acquire(this.opts.maxWaitMs);
    const started = this.now();
    let outcome: "ok" | ErrorKind = "bad_output";
    let usage = { input: 0, output: 0 };
    try {
      for await (const ev of entry.provider.execute(req, entry.model, ctx.signal)) {
        if (ev.type === "done") { outcome = "ok"; usage = ev.usage ?? usage; s.strikes = 0; s.pausedUntil = null; }
        else if (ev.type === "error") { outcome = ev.kind; this.onError(entry.provider.id, s, ev.kind); }
        else if (ev.type === "rate_limit") this.onRateLimit(entry.provider.id, s, ev);
        yield ev;
      }
    } finally {
      release();
      this.usage.record({ provider: entry.provider.id, model: req.model, inputTokens: usage.input, outputTokens: usage.output,
        durationMs: this.now() - started, outcome, source: ctx.source, ts: this.now() });
    }
  }

  private onError(id: string, s: State, kind: ErrorKind) {
    if (kind === "rate_limited") {
      const minutes = Math.min(30, 2 ** s.strikes);
      s.strikes++;
      s.pausedUntil = this.now() + minutes * 60_000;
      this.opts.log.warn({ provider: id, minutes, strikes: s.strikes }, "provider paused after rate limit");
    } else if (kind === "auth_expired") {
      s.health = { ok: false, kind, detail: "auth_expired reported by a request", checkedAt: this.now() };
      this.opts.log.error({ provider: id }, "provider authentication expired");
    }
  }

  private onRateLimit(id: string, s: State, ev: Extract<ProviderEvent, { type: "rate_limit" }>) {
    if (ev.fiveHour) this.usage.setWindow(id, "five_hour", ev.fiveHour, this.now());
    if (ev.sevenDay) this.usage.setWindow(id, "seven_day", ev.sevenDay, this.now());
    s.windowOverBudget = (ev.fiveHour?.utilization ?? 0) >= 1 || (ev.sevenDay?.utilization ?? 0) >= 1;
  }

  async checkHealth(providerId?: string): Promise<void> {
    const targets = providerId ? [this.states.get(providerId)!] : [...this.states.values()];
    await Promise.all(targets.map(async (s) => {
      try { s.health = await s.provider.health(); }
      catch (e) { s.health = { ok: false, kind: "cli_crashed", detail: String(e), checkedAt: this.now() }; }
      this.usage.record({ provider: s.provider.id, model: "health", inputTokens: 0, outputTokens: 0, durationMs: 0, outcome: s.health.ok ? "ok" : (s.health.kind ?? "cli_crashed"), source: "health", ts: this.now() });
      this.opts.log.info({ provider: s.provider.id, ok: s.health.ok, kind: s.health.kind }, "health check");
    }));
  }

  startHealthLoop(intervalMs: number): () => void {
    const timer = setInterval(() => { void this.checkHealth(); }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}
