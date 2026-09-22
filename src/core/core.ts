import type { Logger } from "../log.js";
import type { HealthStatus, ModelKind, ModelSpec, Provider } from "../providers/adapter.js";
import { H5, type CallerUsage, type UsageStore } from "../usage/store.js";
import { Semaphore } from "./semaphore.js";
import { CapitolineError, type ErrorKind, type ImageRequest, type InternalRequest, type ProviderEvent } from "./types.js";

// What is left of a provider's image quota. `limit` is the configured cap of
// the short window (null when none is configured); `resetAt` is when the
// provider said the exhausted quota frees up (null when it never said so, or
// when that instant has passed). The provider has two quotas, one of hours and
// one of days, and only the short one is countable here: the long one shows up
// solely as a `resetAt` far in the future (spike, 2026-09-21).
export interface ImageQuota { used: number; limit: number | null; windowStartedAt: number | null; resetAt: number | null }
export interface ModelInfo { name: string; provider: string; kind: ModelKind; available: boolean; reason?: string; overBudget: boolean; quota?: ImageQuota }
export interface ProviderState {
  id: string; health: HealthStatus | null; pausedUntil: number | null; strikes: number; overBudget: boolean;
  windows: ReturnType<UsageStore["windows"]>; active: number; waiting: number; imageQuota: ImageQuota | null;
}
export interface CoreOptions {
  maxWaitMs: number; budgets: Record<string, { window5h: number; window7d: number }>; log: Logger; now?: () => number;
  /** Per provider: how many images the short quota window allows (config image.quota_per_window). */
  imageQuotas?: Record<string, number>;
}

const D7 = 7 * 24 * 3600_000;
/** The window of the per-caller breakdown /health serves. */
const D1 = 24 * 3600_000;

interface State {
  provider: Provider; sem: Semaphore; health: HealthStatus | null; pausedUntil: number | null; strikes: number;
  /** Set only for a provider that has image models; null otherwise. */
  imageLimit: number | null;
  /** The instant the exhausted image quota frees up, as the provider reported it. */
  imageResetAt: number | null;
  hasImageModels: boolean;
}
/** A model paused on its own, by a refusal that named it. Mirrors the provider's pause and strikes. */
interface ModelPause { pausedUntil: number; strikes: number }
interface Entry { provider: Provider; model: ModelSpec }
// caller: who the Access identity says is asking, null when nothing
// identified them (verification disabled, or a token with nothing in it).
// deliberation: the council run this call belongs to, absent for a request a
// client made directly. It is what ties the nine rows of one question
// together in the usage table (spec 12.7); the rows stay under the real
// models that served them, because quotas belong to those models.
interface Context { signal?: AbortSignal; source: "http" | "mcp"; caller?: string | null; deliberation?: string }

export class Core {
  private readonly states = new Map<string, State>();
  private readonly modelIndex = new Map<string, Entry>();
  /** By model name: the pause installed by a refusal that named that model alone. */
  private readonly modelPauses = new Map<string, ModelPause>();
  /** Health checks still running; awaited by idle() before the usage store is closed. */
  private readonly inFlight = new Set<Promise<void>>();
  private readonly now: () => number;

  constructor(providers: Provider[], private readonly usage: UsageStore, private readonly opts: CoreOptions) {
    this.now = opts.now ?? Date.now;
    for (const p of providers) {
      const models = p.models();
      this.states.set(p.id, {
        provider: p, sem: new Semaphore(p.concurrencyLimit), health: null, pausedUntil: null, strikes: 0,
        imageLimit: opts.imageQuotas?.[p.id] ?? null, imageResetAt: null, hasImageModels: models.some((m) => m.kind === "image"),
      });
      for (const m of models) this.modelIndex.set(m.name, { provider: p, model: m });
    }
  }

  private isPaused(s: State): boolean { return s.pausedUntil !== null && s.pausedUntil > this.now(); }

  private remainingS(s: State): number { return Math.ceil((s.pausedUntil! - this.now()) / 1000); }

  private pausedError(id: string, s: State): CapitolineError {
    return new CapitolineError("rate_limited", `provider ${id} is paused after a rate limit`, this.remainingS(s));
  }

  // Seconds left on a model's own pause, undefined when it has none standing.
  private modelRemainingS(model: string): number | undefined {
    const p = this.modelPauses.get(model);
    if (!p) return undefined;
    const left = Math.ceil((p.pausedUntil - this.now()) / 1000);
    return left > 0 ? left : undefined;
  }

  private modelPausedError(model: string, remaining: number): CapitolineError {
    return new CapitolineError("rate_limited", `model "${model}" is paused after a rate limit`, remaining);
  }

  // Seconds until the pause installed for a provider ends, undefined when it
  // is not paused. This is what a client must be told in Retry-After: the
  // CLI's own retry-after is shorter than the pause (onError adds slack and
  // never shortens an earlier, longer pause), so echoing it back would send
  // the client into pausedError a minute early.
  // With a model name it is the longer of the two pauses in force, since both
  // hold that model back: a client told only the provider's would come back
  // while the model itself is still out.
  pauseRemainingS(providerId: string, model?: string): number | undefined {
    const s = this.states.get(providerId);
    const provider = s && this.isPaused(s) ? this.remainingS(s) : undefined;
    const own = model === undefined ? undefined : this.modelRemainingS(model);
    if (provider === undefined) return own;
    return own === undefined ? provider : Math.max(provider, own);
  }

  private unavailableReason(s: State): string | undefined {
    if (s.health && !s.health.ok) return s.health.kind ?? "unhealthy";
    if (this.isPaused(s)) return "rate_limited";
    return undefined;
  }

  // Over budget never blocks a request: it is informational (spec 7.1). The
  // rate-limit windows come from the store so the flag survives a restart and
  // a partial rate_limit event (one window only) cannot clear the other one.
  private overBudget(id: string): boolean {
    const w = this.usage.windows(id);
    if ((w.five_hour?.utilization ?? 0) >= 1 || (w.seven_day?.utilization ?? 0) >= 1) return true;
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
      const overBudget = this.overBudget(id);
      // One query per provider, not per model: every image model of a provider
      // draws on the same quota.
      const quota = this.imageQuota(id, s);
      for (const m of s.provider.models()) {
        // A model paused on its own is unavailable while its provider is not:
        // this list is the only place that difference can be read.
        const modelReason = reason ?? (this.modelRemainingS(m.name) !== undefined ? "rate_limited" : undefined);
        out.push({ name: m.name, provider: id, kind: m.kind, available: modelReason === undefined, reason: modelReason, overBudget, ...(m.kind === "image" && quota ? { quota } : {}) });
      }
    }
    return out;
  }

  // The quota of a provider that has image models, null for the others. `used`
  // and `windowStartedAt` are counted from the recorded generations, so they
  // survive a restart; `resetAt` only lives in memory (a reported reset is not
  // a fact about our own calls) and is dropped once it has passed.
  private imageQuota(id: string, s: State): ImageQuota | null {
    if (!s.hasImageModels) return null;
    const now = this.now();
    const w = this.usage.imageWindow(id, H5, now);
    return { used: w.used, limit: s.imageLimit, windowStartedAt: w.windowStartedAt, resetAt: s.imageResetAt !== null && s.imageResetAt > now ? s.imageResetAt : null };
  }

  // Who spent the last day, busiest first: with more than one application on
  // the gateway this is the only place that says which one. The health probes
  // are the gateway's own and the store leaves them out.
  callers(): CallerUsage[] {
    return this.usage.callers(D1, this.now());
  }

  // The health `detail` carries raw CLI stderr and must never reach a client
  // (/health is unauthenticated): only the classification is exposed.
  providerStates(): ProviderState[] {
    return [...this.states].map(([id, s]) => ({
      id, health: s.health ? { ok: s.health.ok, kind: s.health.kind, checkedAt: s.health.checkedAt } : null,
      pausedUntil: s.pausedUntil, strikes: s.strikes, overBudget: this.overBudget(id),
      windows: this.usage.windows(id), active: s.sem.active, waiting: s.sem.waiting, imageQuota: this.imageQuota(id, s),
    }));
  }

  private lookup(model: string): Entry {
    const entry = this.modelIndex.get(model);
    if (!entry) throw new CapitolineError("unknown_model", `unknown model "${model}"`);
    return entry;
  }

  // The kind check comes before the provider state: a request for the wrong
  // endpoint is a client error whatever the provider is doing right now.
  async *execute(req: InternalRequest, ctx: Context): AsyncIterable<ProviderEvent> {
    const entry = this.lookup(req.model);
    if (entry.model.kind !== "text") throw new CapitolineError("bad_request", `model "${req.model}" generates images: use the images endpoint`);
    yield* this.guarded(entry, req.model, ctx, () => entry.provider.execute(req, entry.model, ctx.signal));
  }

  async *generateImage(req: ImageRequest, ctx: Context): AsyncIterable<ProviderEvent> {
    const entry = this.lookup(req.model);
    if (entry.model.kind !== "image") throw new CapitolineError("bad_request", `model "${req.model}" is a text model: use the chat endpoint`);
    const generate = entry.provider.generateImage?.bind(entry.provider);
    if (!generate) throw new CapitolineError("bad_request", `provider ${entry.provider.id} cannot generate images`);
    yield* this.guarded(entry, req.model, ctx, () => generate(req, entry.model, ctx.signal));
  }

  // Everything both request kinds share: pause and health gates, the
  // provider's concurrency slot, strike/pause bookkeeping and the usage record.
  private async *guarded(entry: Entry, modelName: string, ctx: Context, produce: () => AsyncIterable<ProviderEvent>): AsyncIterable<ProviderEvent> {
    const kind = entry.model.kind;
    const id = entry.provider.id;
    const s = this.states.get(id)!;
    if (this.isPaused(s)) throw this.pausedError(id, s);
    const ownPause = this.modelRemainingS(modelName);
    if (ownPause !== undefined) throw this.modelPausedError(modelName, ownPause);
    const reason = this.unavailableReason(s);
    if (reason) throw new CapitolineError("model_unavailable", `model "${modelName}" unavailable: ${reason}`);

    const release = await s.sem.acquire(this.opts.maxWaitMs);
    // A pause installed while this request sat in the queue must still stop it
    // (spec 7.1: queued requests get 429 immediately), whichever of the two it is.
    if (this.isPaused(s)) { release(); throw this.pausedError(id, s); }
    const queuedPause = this.modelRemainingS(modelName);
    if (queuedPause !== undefined) { release(); throw this.modelPausedError(modelName, queuedPause); }

    const started = this.now();
    let outcome: "ok" | ErrorKind = "bad_output";
    let usage = { input: 0, output: 0 };
    let sawTerminal = false;
    let phase: "running" | "ended" | "threw" = "running";
    try {
      for await (const ev of produce()) {
        if (ev.type === "done") { sawTerminal = true; outcome = "ok"; usage = ev.usage ?? usage; this.onSuccess(id, s, modelName); }
        else if (ev.type === "error") { sawTerminal = true; outcome = ev.kind; this.onError(id, s, modelName, ev, kind); }
        else if (ev.type === "rate_limit") this.onRateLimit(id, ev);
        yield ev;
      }
      phase = "ended";
    } catch (e) {
      phase = "threw";
      throw e;
    } finally {
      release();
      // No terminal event and no provider failure: the caller gave up, either
      // through its signal or by stopping the iteration (client disconnected).
      const aborted = !sawTerminal && phase !== "threw" && (phase === "running" || ctx.signal?.aborted === true);
      this.usage.record({ provider: id, model: modelName, kind, inputTokens: usage.input, outputTokens: usage.output,
        durationMs: this.now() - started, outcome: aborted ? "aborted" : outcome, source: ctx.source, caller: ctx.caller ?? null,
        deliberation: ctx.deliberation ?? null, ts: this.now() });
    }
  }

  // A model that answered: its strikes go back to zero and its pause goes with
  // them, in memory and in the store alike, so nothing stale is restored at the
  // next start. Neither pause is lifted while it still stands — with
  // concurrency above one a request that started before the refusal landed
  // still completes, and it must not open a window a rate limit closed — so
  // the row is rewritten with the zeroed strikes instead of being dropped, for
  // the model exactly as for the provider.
  //
  // Nothing is written when there is no pause to clear: this runs on every
  // successful request, and an unconditional pair of DELETEs would open a write
  // transaction on the WAL database for each one of them.
  private onSuccess(id: string, s: State, modelName: string) {
    s.strikes = 0;
    if (this.isPaused(s)) this.usage.setPause(id, null, s.pausedUntil!, 0, this.now());
    else if (s.pausedUntil !== null) { s.pausedUntil = null; this.usage.clearPause(id, null); }
    const own = this.modelPauses.get(modelName);
    if (own === undefined) return;
    if (this.modelRemainingS(modelName) !== undefined) { own.strikes = 0; this.usage.setPause(id, modelName, own.pausedUntil, 0, this.now()); }
    else { this.modelPauses.delete(modelName); this.usage.clearPause(id, modelName); }
  }

  // An explicit retry-after (the quota reset the CLI reported) replaces the
  // backoff: waiting less would only burn a strike, waiting the backoff when
  // the reset is days away would probe uselessly. One minute of slack covers
  // clock skew between the gateway and the provider. Strikes still grow so a
  // provider that lies about its reset keeps backing off once the wait ends.
  // A pause only ever grows until it expires: with concurrency above one, a
  // second 429 from a request already past the gate (a short-window reset, or
  // a bare 429) must not cut a multi-day quota pause down to a minute. A
  // negative retry-after (a reset already in the past, or a provider clock
  // ahead of ours) is treated as zero so the minute of slack still applies.
  private onError(id: string, s: State, modelName: string, ev: Extract<ProviderEvent, { type: "error" }>, modelKind: ModelKind = "text") {
    const { kind, retryAfterS } = ev;
    if (kind === "rate_limited") {
      // Only an image run says anything about the image quota, and only the
      // reset it reported: the exhausted window is the one the client asks
      // about, so the bare instant is kept without the pause's slack. Like the
      // pause, it only ever grows while it stands, so a short-window 429 from a
      // request already in flight cannot hide a multi-day exhaustion. It is
      // recorded before the scope branch below: the reset is a fact about the
      // provider's quota, not about which pause this refusal installs, and
      // /health and /v1/models report it either way.
      if (modelKind === "image" && retryAfterS !== undefined) {
        s.imageResetAt = Math.max(s.imageResetAt ?? 0, this.now() + Math.max(0, retryAfterS) * 1000);
      }
      // A refusal the CLI attributed to the model that was asked for: pausing
      // the provider would take down the models that still answer, which is
      // what the Fable capture of 2026-09-21 showed happening.
      if (ev.scope === "model") { this.pauseModel(id, modelName, retryAfterS); return; }
      const waitMs = retryAfterS !== undefined ? (Math.max(0, retryAfterS) + 60) * 1000 : Math.min(30, 2 ** s.strikes) * 60_000;
      s.strikes++;
      s.pausedUntil = Math.max(s.pausedUntil ?? 0, this.now() + waitMs);
      this.usage.setPause(id, null, s.pausedUntil, s.strikes, this.now());
      this.opts.log.warn({ provider: id, seconds: Math.round((s.pausedUntil - this.now()) / 1000), explicit: retryAfterS !== undefined, strikes: s.strikes }, "provider paused after rate limit");
    } else if (kind === "auth_expired") {
      s.health = { ok: false, kind, detail: "auth_expired reported by a request", checkedAt: this.now() };
      this.opts.log.error({ provider: id }, "provider authentication expired");
    }
  }

  // The model's own pause, by the same rules as the provider's: an explicit
  // reset plus a minute of slack, the doubling backoff without one, and a
  // pause that only ever grows while it stands. Its strikes are the model's,
  // so a second model of the same provider starts its own count, and a
  // successful run of this model clears both (guarded(), on `done`).
  private pauseModel(providerId: string, model: string, retryAfterS?: number) {
    const p = this.modelPauses.get(model) ?? { pausedUntil: 0, strikes: 0 };
    const waitMs = retryAfterS !== undefined ? (Math.max(0, retryAfterS) + 60) * 1000 : Math.min(30, 2 ** p.strikes) * 60_000;
    p.strikes++;
    p.pausedUntil = Math.max(p.pausedUntil, this.now() + waitMs);
    this.modelPauses.set(model, p);
    this.usage.setPause(providerId, model, p.pausedUntil, p.strikes, this.now());
    this.opts.log.warn({ provider: providerId, model, seconds: Math.round((p.pausedUntil - this.now()) / 1000), explicit: retryAfterS !== undefined, strikes: p.strikes }, "model paused after a rate limit");
  }

  private onRateLimit(id: string, ev: Extract<ProviderEvent, { type: "rate_limit" }>) {
    if (ev.fiveHour) this.usage.setWindow(id, "five_hour", ev.fiveHour, this.now());
    if (ev.sevenDay) this.usage.setWindow(id, "seven_day", ev.sevenDay, this.now());
  }

  /**
   * Reads back the pauses a previous process installed. Called by start() right
   * after the core is built and before the first health check, so a restart
   * does not spend a real call to rediscover a refusal that reopens in days
   * (the five-day image pause lost on a deploy, host 2026-09-22).
   *
   * Strikes come back with the pause, so the backoff carries on doubling
   * instead of restarting at one minute after a bounce. A row naming a provider
   * or a model the configuration no longer declares is left alone rather than
   * restored: nothing can ask for it, and the prune below drops it once it
   * expires.
   *
   * The collection is here, once per start, and not inside the store's read:
   * a delete that runs on a clock nobody checked is how a five-day pause
   * disappears without a line anywhere after an NTP step or a restored
   * snapshot. Logged, so the journal says what went.
   */
  restorePauses(): void {
    const rows = this.usage.pauses(this.now());
    const removed = this.usage.prunePauses(this.now());
    if (removed > 0) this.opts.log.info({ removed }, "expired pauses pruned");
    for (const row of rows) {
      if (row.model === null) {
        const s = this.states.get(row.provider);
        if (!s) continue;
        s.pausedUntil = row.until;
        s.strikes = row.strikes;
      } else {
        if (this.modelIndex.get(row.model)?.provider.id !== row.provider) continue;
        this.modelPauses.set(row.model, { pausedUntil: row.until, strikes: row.strikes });
      }
      this.opts.log.info({ provider: row.provider, model: row.model, seconds: Math.round((row.until - this.now()) / 1000), strikes: row.strikes }, "pause restored");
    }
  }

  // Wrapper, so a shutdown can wait for a check already in flight: a probe runs
  // a real CLI (up to the health deadline) and writes a row when it lands, so
  // closing the usage store under it makes node:sqlite throw — during a
  // shutdown that throw becomes an unhandled rejection and a non-zero exit.
  checkHealth(providerId?: string): Promise<void> {
    const run = this.runHealthCheck(providerId);
    const tracked = run.then(() => {}, () => {});   // idle() waits, it does not report
    this.inFlight.add(tracked);
    void tracked.finally(() => this.inFlight.delete(tracked));
    return run;
  }

  /** Resolves when no health check is in flight. Never rejects. */
  idle(): Promise<void> {
    return Promise.all([...this.inFlight]).then(() => {});
  }

  private async runHealthCheck(providerId?: string): Promise<void> {
    const one = providerId ? this.states.get(providerId) : undefined;
    if (providerId && !one) throw new CapitolineError("unknown_model", `unknown provider "${providerId}"`);
    const targets = one ? [one] : [...this.states.values()];
    await Promise.all(targets.map(async (s) => {
      // A probe is a real call on a real CLI. While a pause stands it would
      // spend the refusal all over again and learn nothing the pause does not
      // already say — and that call is exactly what restorePauses() before the
      // first check (main.ts) exists to save. The health already on record is
      // kept: isPaused() alone makes the models unavailable, and the next
      // round after the pause expires takes a fresh verdict.
      if (this.isPaused(s)) {
        this.opts.log.info({ provider: s.provider.id, seconds: this.remainingS(s) }, "health check skipped: provider paused");
        return;
      }
      // The probe runs one model, the configured health_model, so a pause
      // naming that model is a pause on the probe itself. A pause on any other
      // model of the provider is not: the probe still says something about the
      // ones that answer.
      const probed = s.provider.healthModel;
      const modelPaused = probed === undefined ? undefined : this.modelRemainingS(probed);
      if (modelPaused !== undefined) {
        this.opts.log.info({ provider: s.provider.id, model: probed, seconds: modelPaused }, "health check skipped: health model paused");
        return;
      }
      let status: HealthStatus;
      try { status = await s.provider.health(); }
      catch (e) { status = { ok: false, kind: "cli_crashed", detail: String(e), checkedAt: this.now() }; }
      // A rate limit the CLI attributed to the probe's own model is about that
      // model, not about the provider: the very same answer coming from a
      // client request pauses the model alone (onError). Marking the provider
      // here would make every one of its models unavailable — 404 in
      // /v1/models, model_unavailable on a request — until that single model's
      // limit expires, and the loop would renew the verdict every round. So the
      // model is paused and the provider keeps the health it had.
      const modelOnly = !status.ok && status.kind === "rate_limited" && status.scope === "model" && status.model !== undefined;
      if (modelOnly) this.pauseModel(s.provider.id, status.model!, undefined);
      else s.health = status;
      this.usage.record({ provider: s.provider.id, model: "health", inputTokens: 0, outputTokens: 0, durationMs: 0, outcome: status.ok ? "ok" : (status.kind ?? "cli_crashed"), source: "health", ts: this.now() });
      this.opts.log.info({ provider: s.provider.id, ok: status.ok, kind: status.kind, detail: status.detail, ...(modelOnly ? { model: status.model, scope: "model" } : {}) }, "health check");
    }));
  }

  startHealthLoop(intervalMs: number): () => void {
    // .catch, not a bare `void`: a check that rejects (a store gone during a
    // shutdown, a provider throwing outside its own try) would otherwise be an
    // unhandled rejection, which on Node 24 ends the process.
    const timer = setInterval(() => {
      this.checkHealth().catch((err: unknown) => this.opts.log.error({ err }, "health check failed"));
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}
