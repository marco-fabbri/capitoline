import { EffortSchema, type Effort } from "../config.js";
import { checkAttachments } from "./attachments.js";
import type { CouncilEvent } from "../council/council.js";
import type { Logger } from "../log.js";
import type { CatalogChange, HealthStatus, ModelKind, ModelSpec, Provider, QuotaBucket } from "../providers/adapter.js";
import { H5, type CallerUsage, type ModelIdentity, type UsageStore } from "../usage/store.js";
import { flatten, splitSystem } from "./prompt.js";
import { Semaphore } from "./semaphore.js";
import { CLIENT_MESSAGE, CapitolineError, type ErrorKind, type ImageRequest, type InternalRequest, type ProviderEvent, type Usage } from "./types.js";

/**
 * What a virtual model is owned by in `/v1/models` and in the `capitoline`
 * field of a response: the gateway itself. A council is served by no provider
 * — it is nine calls on the providers of its seats, each accounted under the
 * real model that served it (spec §12.7).
 */
export const VIRTUAL_PROVIDER = "capitoline";
/** The `kind` a virtual model is listed with, beside the "text" and "image" of the real ones. */
export type VirtualKind = "council";

// What is left of a provider's image quota. `limit` is the configured cap of
// the short window (null when none is configured); `resetAt` is when the
// provider said the exhausted quota frees up (null when it never said so, or
// when that instant has passed). The provider has two quotas, one of hours and
// one of days, and only the short one is countable here: the long one shows up
// solely as a `resetAt` far in the future (spike, 2026-09-21).
export interface ImageQuota { used: number; limit: number | null; windowStartedAt: number | null; resetAt: number | null }
export interface ModelInfo { name: string; provider: string; kind: ModelKind | VirtualKind; available: boolean; reason?: string; overBudget: boolean; quota?: ImageQuota }
/**
 * The catalog of a provider that lists its models (docs/deploy.md §7.2), as
 * /health shows it: when the CLI was last asked and whether it answered, the
 * names discovery added, the declared names it retired, and the model the
 * health probe is running on — `health_fallback`'s once `health_model` is
 * retired. The listing's own error is logged, never shown: /health is open.
 */
export interface CatalogState { checkedAt: number | null; ok: boolean | null; discovered: string[]; retired: string[]; healthModel: string | null }
export interface ProviderState {
  id: string; health: HealthStatus | null; pausedUntil: number | null; strikes: number; overBudget: boolean;
  windows: ReturnType<UsageStore["windows"]>; active: number; waiting: number; imageQuota: ImageQuota | null;
  catalog: CatalogState | null;
  /** What the CLI last reported of the subscription's quota; null for a provider with no report. `ok` false keeps the last buckets read. */
  quota: { checkedAt: number; ok: boolean; buckets: QuotaBucket[] } | null;
}
export interface CoreOptions {
  maxWaitMs: number; budgets: Record<string, { window5h: number; window7d: number }>; log: Logger; now?: () => number;
  /** Per provider: how many images the short quota window allows (config image.quota_per_window). */
  imageQuotas?: Record<string, number>;
  /** Told of every change a fresh listing makes to a provider's catalog; never of a restore at startup. */
  onCatalogChange?: (provider: string, change: CatalogChange) => void;
  /** Told when a quota pause starts and, if it was long, ends, and when a provider signs out or back in. */
  onAvailability?: (event: AvailabilityEvent) => void;
  /** How long after a healthy provider's first auth_expired probe the confirming one runs (AUTH_RECHECK_MS). Tests shorten it. */
  authRecheckMs?: number;
  /** Per provider: the share of a weekly quota bucket under which it is announced (config quota.notify_below). */
  quotaNotifyBelow?: Record<string, number>;
}

/**
 * What server.notify is told about a provider or a model going away and coming
 * back. `scope` is null for the whole provider, otherwise a `scopeOf` scope
 * (`image:gemini-3.1-flash-image`).
 *
 * `paused` only for a quota the provider said when it frees up: a pause with
 * no reset is the gateway's own backoff after a bare refusal, a minute that
 * doubles, and not news. `resumed` only for such a pause, and only when it
 * stood at least RESUME_NOTICE_MS: a short window reopening every few hours
 * would drown the rest.
 */
export type AvailabilityEvent =
  | { kind: "paused"; provider: string; scope: string | null; until: number }
  | { kind: "resumed"; provider: string; scope: string | null; pausedMs: number }
  | { kind: "refusing"; provider: string; scope: string | null; refusedMs: number; weeklyResetAt?: number }
  | { kind: "signed_out"; provider: string }
  | { kind: "signed_in"; provider: string }
  // A weekly bucket of the provider's own quota report under the configured
  // share: once per window, so the operator hears of it before the refusals.
  | { kind: "quota_low"; provider: string; group: string; remaining: number; resetsAt: number | null };

/** A pause as the operator sees it: `scope` null for the whole provider, else a model's scope, with the names it holds back. */
export interface PauseInfo { provider: string; scope: string | null; until: number; strikes: number; models: string[] }

export const RESUME_NOTICE_MS = 3600_000;

// A refusal with no reset time is a backoff and not news, until it keeps
// coming: a limit the provider words as "you've reached your limit", with no
// instant attached, kept a model away for days with nothing announced at
// either end (2026-09-28 to 2026-10-03). So a provider or a model refused for
// this long with no reset given is told once (`refusing`), and its first
// success after that is told too (`resumed`). In memory only: a restart in the
// middle starts the count again, which delays the notice and loses nothing.
export const REFUSING_NOTICE_MS = 3600_000;

// A CLI that fails to renew its token once answers a probe exactly as a
// signed-out one does, and the next probe an hour later finds it signed in:
// seen on 2026-10-02, when one such probe took a provider's models away for an
// hour and told the owner to log in again for nothing. So a provider that was
// healthy is not believed on its first auth_expired: it is probed again after
// this long, and that verdict stands. A real sign-out fails twice. The same
// holds when it is a request, and not the probe, that gets the answer.
export const AUTH_RECHECK_MS = 60_000;

const D7 = 7 * 24 * 3600_000;
/** The window of the per-caller breakdown /health serves. */
const D1 = 24 * 3600_000;

interface State {
  provider: Provider; sem: Semaphore; health: HealthStatus | null; pausedUntil: number | null; strikes: number;
  /** Set only for a provider that has image models; null otherwise. */
  imageLimit: number | null;
  /** The instant the exhausted image quota frees up, as the provider reported it. */
  imageResetAt: number | null;
  /** When the provider's current run of refusals began; null while it answers. */
  refusedSince: number | null;
  hasImageModels: boolean;
  /** The last listing attempt, for a provider that lists its models; null until the first. */
  catalog: { checkedAt: number; ok: boolean } | null;
  /** The last quota report, for a provider whose CLI has one; null until the first. */
  quota: { checkedAt: number; ok: boolean; buckets: QuotaBucket[] } | null;
}
/** A model paused on its own, by a refusal that named it. Mirrors the provider's pause and strikes. */
interface ModelPause { pausedUntil: number; strikes: number; /** When the run of refusals this pause belongs to began. */ since?: number }
interface Entry { provider: Provider; model: ModelSpec }
// caller: who the Access identity says is asking, null when nothing
// identified them (verification disabled, or a token with nothing in it).
// deliberation: the council run this call belongs to, absent for a request a
// client made directly. It is what ties the nine rows of one question
// together in the usage table (spec 12.7); the rows stay under the real
// models that served them, because quotas belong to those models.
export interface Context { signal?: AbortSignal; source: "http" | "mcp"; caller?: string | null; deliberation?: string; /** The council a deliberation's call belongs to, by name. */ council?: string }

/**
 * A virtual model's work: a question in, the council's own events out. The
 * context is the one an ordinary request carries, unchanged — the signal that
 * cancels it, the source it came from, the caller that /v1/usage groups by —
 * because a council member is a request like any other and inherits all three.
 */
/**
 * The effort is the request's, passed through untouched: what it means is the
 * virtual model's own business (a council reads `low` as "skip the peer
 * ranking", design §12.9), and a virtual that declared no efforts at
 * registration is never handed one — the transport marks the field ignored
 * instead, as it does for every other request field a model has no channel
 * for.
 */
export type VirtualRun = (question: string, ctx: Context, effort?: Effort) => AsyncIterable<CouncilEvent>;

/**
 * Whether a virtual model can serve a request right now, decided against the
 * real models as `listModels()` has just reported them.
 *
 * The state is passed in and never read back from `Core`: this is called from
 * inside `listModels()`, so a council that answered by calling `listModels()`
 * again would recurse forever. The list it receives holds the real models
 * alone, which are the only ones a seat can be filled from.
 *
 * It is asked twice about the same council, and must answer the same way both
 * times: once when the model is listed, and once in front of a request for it
 * (`deliberate`), because what a listing published a minute ago is not what
 * the seats can do now.
 */
export type VirtualAvailability = (models: ModelInfo[]) => { available: boolean; reason?: string };

interface Virtual { run: VirtualRun; availability?: VirtualAvailability; efforts: Effort[] }

/**
 * What a model pause is about: one provider's quota for one CLI id **at one
 * kind of request**.
 *
 * The kind is part of it because the two quotas are different pools, measured
 * so (`docs/spike-2026-09.md` §8): Antigravity's image generation has its own
 * 12-per-5-hours and 58-per-7-days windows, and its text models answer from
 * another allowance entirely. One id sits in both — `antigravity-image` and
 * `antigravity-gemini-flash-low` are both `gemini-3.8-flash-low` — so a pause keyed by
 * the id alone let an exhausted image quota take a working text model down
 * with it, and with it the third rung of `capitoline-gemini` (observed in
 * production 2026-09-23, the first restart after the pause key moved onto the
 * CLI id). It is the same mistake as pausing the whole provider over one
 * model's refusal, one level down.
 *
 * The value is what the `pauses` table stores in its `model` column, so the
 * column holds a scope and not a model name. `restorePauses()` absorbs the two
 * older shapes that column has held.
 */
const scopeOf = (kind: ModelKind, cliId: string): string => `${kind}:${cliId}`;

export class Core {
  private readonly states = new Map<string, State>();
  private readonly modelIndex = new Map<string, Entry>();
  /**
   * The pause installed by a refusal that named one model alone, keyed by
   * `pauseKey`: the provider and a `scopeOf` scope — the id the CLI was
   * actually given, qualified by the kind of request it was given for. Never
   * the gateway name: several gateway names can resolve to one id, and keyed
   * by the name a refusal on one left the others to rediscover the same
   * exhausted model by spending a call apiece.
   */
  private readonly modelPauses = new Map<string, ModelPause>();
  /** Every pause scope reachable through the configuration, by provider: what a restored row must name. */
  private readonly knownScopes = new Map<string, Set<string>>();
  /** Virtual models by the name a client asks for: the councils main.ts registers. */
  private readonly virtuals = new Map<string, Virtual>();
  /** Health checks still running; awaited by idle() before the usage store is closed. */
  private readonly inFlight = new Set<Promise<void>>();
  // Providers waiting for their confirming probe (AUTH_RECHECK_MS), and the ones it is running for.
  private readonly authRechecks = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly confirming = new Set<string>();
  private readonly now: () => number;

  constructor(providers: Provider[], private readonly usage: UsageStore, private readonly opts: CoreOptions) {
    this.now = opts.now ?? Date.now;
    for (const p of providers) {
      const models = p.models();
      this.states.set(p.id, {
        provider: p, sem: new Semaphore(p.concurrencyLimit), health: null, pausedUntil: null, strikes: 0,
        imageLimit: opts.imageQuotas?.[p.id] ?? null, imageResetAt: null, refusedSince: null, hasImageModels: models.some((m) => m.kind === "image"),
        catalog: null,
        quota: null,
      });
      this.reindex(p);
    }
  }

  /**
   * A provider's entries in the model index, rebuilt from what it serves now:
   * at construction, and again whenever its catalog changes, so routing, the
   * listing and the pause scopes never disagree about which models exist.
   * Scopes are only ever added: a pause restored for a model the catalog has
   * since dropped is still a fact about the provider's quota.
   */
  private reindex(p: Provider): void {
    for (const [name, e] of this.modelIndex) if (e.provider === p) this.modelIndex.delete(name);
    const scopes = this.knownScopes.get(p.id) ?? new Set<string>();
    for (const m of p.models()) {
      // Declared names are checked unique at load; a discovered one could only
      // clash through a prefix another provider also uses, and loses.
      const owner = this.modelIndex.get(m.name);
      if (owner || this.virtuals.has(m.name)) {
        this.opts.log.warn({ provider: p.id, model: m.name, owner: owner?.provider.id ?? VIRTUAL_PROVIDER }, "model name already taken; not served");
        continue;
      }
      this.modelIndex.set(m.name, { provider: p, model: m });
      // Every effort, not just the default: a request naming `low` resolves
      // to a different id, and a pause installed under it has to survive a
      // restart like any other.
      scopes.add(scopeOf(m.kind, p.cliId(m)));
      for (const e of EffortSchema.options) scopes.add(scopeOf(m.kind, p.cliId(m, e)));
    }
    // The probe is a chat request, whatever the model it names.
    if (p.healthCliId !== undefined) scopes.add(scopeOf("text", p.healthCliId));
    this.knownScopes.set(p.id, scopes);
  }

  private isPaused(s: State): boolean { return s.pausedUntil !== null && s.pausedUntil > this.now(); }

  private remainingS(s: State): number { return Math.ceil((s.pausedUntil! - this.now()) / 1000); }

  private pausedError(id: string, s: State): CapitolineError {
    return new CapitolineError("rate_limited", `provider ${id} is paused after a rate limit`, this.remainingS(s));
  }

  // A model pause is about one CLI id of one provider, and two providers may
  // well serve an id of the same name (`claude-sonnet-4-6` is both Anthropic's
  // and Antigravity's), so the provider is part of the key. The separator is a
  // NUL, which no provider id or model id can contain.
  private pauseKey(providerId: string, scope: string): string { return `${providerId}\u0000${scope}`; }

  // The quota pauses whose start was announced, by the provider and the scope
  // ("" for the whole provider), with when it was announced and when the
  // pause ends as it stands. Rebuilt from the store at startup.
  private readonly announced = new Map<string, { provider: string; scope: string | null; at: number; until: number }>();
  // The runs of refusals with no reset that were told (REFUSING_NOTICE_MS), by the same key, with when each began.
  private readonly refusing = new Map<string, number>();

  private tell(event: AvailabilityEvent): void {
    try { this.opts.onAvailability?.(event); }
    catch (e) { this.opts.log.warn({ provider: event.provider, err: String(e) }, "availability listener threw"); }
  }

  // Called after a pause was installed or grown. `fresh` is whether nothing
  // stood before it: a pause that only grew was announced, or not, when it
  // started, and its new end is all there is to keep.
  private pauseInstalled(provider: string, scope: string | null, until: number, quota: boolean, fresh: boolean): void {
    if (!this.opts.onAvailability) return;
    const key = `${provider}\u0000${scope ?? ""}`;
    if (!fresh) {
      const own = this.announced.get(key);
      if (own) own.until = until;
      return;
    }
    // A pause announced before, which expired before the sweep came round.
    if (this.announced.has(key)) this.retire(key);
    if (!quota) { this.usage.markPauseAnnounced(provider, scope, null); return; }
    this.announced.set(key, { provider, scope, at: this.now(), until });
    this.usage.markPauseAnnounced(provider, scope, this.now());
    this.tell({ kind: "paused", provider, scope, until });
  }

  private retire(key: string): void {
    const own = this.announced.get(key);
    if (!own) return;
    this.announced.delete(key);
    // The row can outlive the pause (it goes on the next success or the next
    // start): unmarked, so a restart does not tell the same end again.
    this.usage.markPauseAnnounced(own.provider, own.scope, null);
    const pausedMs = own.until - own.at;
    if (pausedMs >= RESUME_NOTICE_MS) this.tell({ kind: "resumed", provider: own.provider, scope: own.scope, pausedMs });
  }

  /**
   * The pauses standing now: a provider's own (scope null) and each model's,
   * with the gateway names a model pause holds back. For the operator.
   */
  pauses(): PauseInfo[] {
    const out: PauseInfo[] = [];
    const now = this.now();
    for (const [id, s] of this.states) {
      if (s.pausedUntil !== null && s.pausedUntil > now) out.push({ provider: id, scope: null, until: s.pausedUntil, strikes: s.strikes, models: s.provider.models().map((m) => m.name) });
      for (const [key, p] of this.modelPauses) {
        if (!key.startsWith(`${id}\u0000`) || p.pausedUntil <= now) continue;
        const scope = key.slice(id.length + 1);
        out.push({ provider: id, scope, until: p.pausedUntil, strikes: p.strikes, models: s.provider.models().filter((m) => scopeOf(m.kind, s.provider.cliId(m)) === scope).map((m) => m.name) });
      }
    }
    return out;
  }

  /**
   * Lifts a pause by hand, the provider's own (scope null) or one model's.
   * Silent: nothing is announced, since the operator who lifts it knows. False
   * when no such pause stands.
   */
  liftPause(providerId: string, scope: string | null): boolean {
    const s = this.states.get(providerId);
    if (!s) return false;
    const announcedKey = `${providerId}\u0000${scope ?? ""}`;
    if (scope === null) {
      if (s.pausedUntil === null || s.pausedUntil <= this.now()) return false;
      s.pausedUntil = null; s.strikes = 0;
    } else {
      const key = this.pauseKey(providerId, scope);
      if (this.keyRemainingS(key) === undefined) return false;
      this.modelPauses.delete(key);
      if (scope.startsWith("image:")) s.imageResetAt = null;
    }
    this.usage.clearPause(providerId, scope);
    this.announced.delete(announcedKey);
    this.refusing.delete(announcedKey);
    this.opts.log.info({ provider: providerId, scope }, "pause lifted by hand");
    return true;
  }

  /**
   * Holds a provider, or one of its models by gateway name, back for a while
   * by hand: a pause like any other, stored and restored and lifted the same
   * way, and never announced. For maintenance, or to stop spending a quota.
   */
  holdBack(providerId: string, model: string | undefined, forMs: number): PauseInfo {
    const s = this.states.get(providerId);
    if (!s) throw new CapitolineError("bad_request", `unknown provider "${providerId}"`);
    if (!(forMs > 0)) throw new CapitolineError("bad_request", "the pause must last some time");
    const until = this.now() + forMs;   // by Core's own clock, like every other pause
    let scope: string | null = null;
    if (model === undefined) {
      s.pausedUntil = Math.max(s.pausedUntil ?? 0, until);
      this.usage.setPause(providerId, null, s.pausedUntil, s.strikes, this.now());
    } else {
      const spec = s.provider.models().find((m) => m.name === model);
      if (!spec) throw new CapitolineError("bad_request", `provider "${providerId}" has no model "${model}"`);
      scope = scopeOf(spec.kind, s.provider.cliId(spec));
      const key = this.pauseKey(providerId, scope);
      const p = this.modelPauses.get(key) ?? { pausedUntil: 0, strikes: 0 };
      p.pausedUntil = Math.max(p.pausedUntil, until);
      this.modelPauses.set(key, p);
      this.usage.setPause(providerId, scope, p.pausedUntil, p.strikes, this.now());
    }
    this.usage.markPauseAnnounced(providerId, scope, null);
    this.opts.log.info({ provider: providerId, model, until }, "pause installed by hand");
    return this.pauses().find((x) => x.provider === providerId && x.scope === scope)!;
  }

  /** Announces the end of every announced pause that has run out. Cheap: no CLI, no store read. */
  sweepPauses(): void {
    for (const [key, own] of [...this.announced]) if (own.until <= this.now()) this.retire(key);
  }

  startPauseSweep(intervalMs: number): () => void {
    const timer = setInterval(() => this.sweepPauses(), intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  // Signed out and back in, told on the transition only: a provider that stays
  // signed out answers auth_expired to every probe, and that is one piece of
  // news, not one an hour.
  private healthChanged(provider: string, before: HealthStatus | null, after: HealthStatus): void {
    const wasOut = before?.kind === "auth_expired";
    if (after.kind === "auth_expired" && !wasOut) this.tell({ kind: "signed_out", provider });
    else if (wasOut && after.ok) this.tell({ kind: "signed_in", provider });
  }

  // The id this request will actually be sent under, which is what its pause
  // is keyed by. Image requests carry no effort and take the default.
  private cliIdOf(entry: Entry, effort?: Effort): string { return entry.provider.cliId(entry.model, effort); }

  // Seconds left on a model's own pause, undefined when it has none standing.
  private keyRemainingS(key: string): number | undefined {
    const p = this.modelPauses.get(key);
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
  // The model is named the way a client named it, so it is resolved here. At
  // the default effort: this answers a client that has already been refused,
  // and the request's own level is no longer in hand. A pause installed at
  // another level is then invisible to this number and the provider's own
  // wait is reported instead, which is the safe direction to be wrong in.
  pauseRemainingS(providerId: string, model?: string): number | undefined {
    const s = this.states.get(providerId);
    const provider = s && this.isPaused(s) ? this.remainingS(s) : undefined;
    const entry = model === undefined ? undefined : this.modelIndex.get(model);
    const own = entry === undefined ? undefined : this.keyRemainingS(this.pauseKey(providerId, scopeOf(entry.model.kind, this.cliIdOf(entry))));
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
    // The virtual models come last, decided against a snapshot of the real ones
    // taken before the first of them is appended: a council is seated from
    // models a provider serves, never from another council.
    const real = this.realModels();
    return [...real, ...[...this.virtuals].map(([name, v]) => this.virtualInfo(name, v, real))];
  }

  // The real models alone, which are the only ones a seat can be filled from:
  // the listing above appends the virtual ones to this, and the gate on the
  // virtual path (`virtualState`) decides against this and nothing else.
  private realModels(): ModelInfo[] {
    const out: ModelInfo[] = [];
    for (const [id, s] of this.states) {
      const reason = this.unavailableReason(s);
      const overBudget = this.overBudget(id);
      // One query per provider, not per model: every image model of a provider
      // draws on the same quota.
      const quota = this.imageQuota(id, s);
      for (const m of s.provider.models()) {
        // Only what routing would serve: a discovered name that lost a clash
        // in reindex() is not this provider's to list.
        if (this.modelIndex.get(m.name)?.provider !== s.provider) continue;
        // A model paused on its own is unavailable while its provider is not:
        // this list is the only place that difference can be read.
        // By the resolved id, so one refusal darkens every gateway name that
        // resolves to the refused model instead of only the one that called.
        // A retired model says so before anything else: it is not coming back
        // when a pause or a health verdict clears.
        const modelReason = (s.provider.isRetired?.(m) ? "retired" : undefined) ?? reason ?? (this.keyRemainingS(this.pauseKey(id, scopeOf(m.kind, s.provider.cliId(m)))) !== undefined ? "rate_limited" : undefined);
        out.push({ name: m.name, provider: id, kind: m.kind, available: modelReason === undefined, reason: modelReason, overBudget, ...(m.kind === "image" && quota ? { quota } : {}) });
      }
    }
    return out;
  }

  // One virtual model as it is listed. `overBudget` is false for the same
  // reason a council has no provider — the budgets are the providers' own, and
  // the member calls carry the flag of whatever served them.
  private virtualInfo(name: string, v: Virtual, real: ModelInfo[]): ModelInfo {
    const state = this.virtualState(v, real);
    return { name, provider: VIRTUAL_PROVIDER, kind: "council", available: state.available, ...(state.reason !== undefined ? { reason: state.reason } : {}), overBudget: false };
  }

  // Whether a virtual model can serve a request, against the real models as
  // they stand. A virtual model registered without an availability rule (a
  // test, a virtual model that is always on) is always available.
  private virtualState(v: Virtual, real: ModelInfo[]): { available: boolean; reason?: string } {
    return v.availability?.(real) ?? { available: true };
  }

  /**
   * Declares a virtual model: a name a client asks for in `model` exactly as it
   * asks for a real one, served by `run` instead of by a provider (design §12).
   *
   * The name is checked against the real models here as well as at
   * configuration load, because the two lists are built from different things —
   * the providers are constructed from the configuration, the councils are
   * registered by `main.ts` — and a name held by both would route to one of
   * them and never the other, with nothing saying which. It throws a plain
   * Error: this happens at start-up, in front of the operator, and is a
   * misconfiguration rather than an answer to any request.
   *
   * `availability` is optional so a caller that has no opinion (a test, a
   * virtual model that is always on) can leave it out; a council passes the
   * seating rule of §12.2, which is the only thing that knows what a seat is.
   */
  registerVirtual(name: string, run: VirtualRun, availability?: VirtualAvailability, efforts: Effort[] = []): void {
    const owner = this.modelIndex.get(name);
    if (owner) throw new Error(`virtual model "${name}" is also a model of provider ${owner.provider.id}`);
    if (this.virtuals.has(name)) throw new Error(`virtual model "${name}" is already registered`);
    this.virtuals.set(name, { run, availability, efforts });
  }

  /** Whether the name is a virtual model, which is what a transport asks before choosing between execute() and deliberate(). */
  isVirtual(model: string): boolean {
    return this.virtuals.has(model);
  }

  /**
   * Whether a request's effort means anything to this virtual model. A
   * council with its ranking stage accepts `low` and `high`; one configured
   * without it (`ranking: false`) is pinned to its shape and accepts none, so
   * a transport declares the field ignored rather than passing it on.
   */
  acceptsEffort(model: string): boolean {
    return (this.virtuals.get(model)?.efforts.length ?? 0) > 0;
  }

  // The quota of a provider that has image models, null for the others. `used`
  // and `windowStartedAt` are counted from the recorded generations, so they
  // survive a restart; `resetAt` lives in memory (a reported reset is not a
  // fact about our own calls), is restored from the pause it installed
  // (restorePauses), and is dropped once it has passed.
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

  /**
   * Which real model has served each gateway name over the last week. A week
   * and not a day, because the reading is the *change*: two rows under one
   * name is an alias that moved, and a day is too short to catch it.
   */
  modelIdentities(): ModelIdentity[] {
    return this.usage.modelIdentities(D7, this.now());
  }

  // The health `detail` carries raw CLI stderr and must never reach a client
  // (/health is unauthenticated): only the classification is exposed.
  providerStates(): ProviderState[] {
    return [...this.states].map(([id, s]) => ({
      id, health: s.health ? { ok: s.health.ok, kind: s.health.kind, checkedAt: s.health.checkedAt } : null,
      pausedUntil: s.pausedUntil, strikes: s.strikes, overBudget: this.overBudget(id),
      windows: this.usage.windows(id), active: s.sem.active, waiting: s.sem.waiting, imageQuota: this.imageQuota(id, s),
      catalog: s.provider.discovers
        ? { checkedAt: s.catalog?.checkedAt ?? null, ok: s.catalog?.ok ?? null, ...(s.provider.catalogNames?.() ?? { discovered: [], retired: [] }), healthModel: s.provider.healthModel ?? null }
        : null,
      quota: s.quota,
    }));
  }

  private lookup(model: string): Entry {
    const entry = this.modelIndex.get(model);
    // A council reaching here is a chat model asked for on the wrong endpoint,
    // the same mistake as an image model on /v1/chat/completions, and
    // unknown_model (a 404) would send the caller looking for a name that is
    // right there in /v1/models.
    if (!entry) {
      if (this.virtuals.has(model)) throw new CapitolineError("bad_request", `model "${model}" is a council: use the chat endpoint`);
      throw new CapitolineError("unknown_model", `unknown model "${model}"`);
    }
    return entry;
  }

  // The kind check comes before the provider state: a request for the wrong
  // endpoint is a client error whatever the provider is doing right now.
  async *execute(req: InternalRequest, ctx: Context): AsyncIterable<ProviderEvent> {
    // A virtual model first: it is asked for in the same field and answered on
    // the same endpoint, and it holds no concurrency slot of its own. The slots
    // are taken by its member calls, one by one, as they come back through this
    // very method — which is what keeps the queue, the pauses and the usage
    // rows honest for a council member (plan, global constraints).
    if (this.virtuals.has(req.model)) { yield* this.flattenVirtual(req, ctx); return; }
    const entry = this.lookup(req.model);
    if (entry.model.kind !== "text") throw new CapitolineError("bad_request", `model "${req.model}" generates images: use the images endpoint`);
    // Refused, never dropped: before this the images of a request were written
    // into the sandbox and no CLI was told of them, so every model answered as
    // if none had been sent (checked on the host, 2026-09-30).
    if (req.attachments?.length) {
      if (!entry.provider.acceptsAttachments) throw new CapitolineError("bad_request", `model "${req.model}" cannot take images: its CLI accepts text only`);
      checkAttachments(req.attachments, req.model);
    }
    yield* this.guarded(entry, req.model, this.cliIdOf(entry, req.effort), ctx, () => entry.provider.execute(req, entry.model, ctx.signal));
  }

  /**
   * A virtual model's own events: the progress of the stages it is running and,
   * at the end, the whole deliberation. This is what a transport that can
   * render them calls — SSE progress chunks, MCP progress notifications, the
   * `capitoline` field of a completion (spec §12.6).
   */
  async *deliberate(req: InternalRequest, ctx: Context): AsyncIterable<CouncilEvent> {
    const virtual = this.virtuals.get(req.model);
    if (!virtual) throw new CapitolineError("bad_request", `model "${req.model}" is not a council`);
    // What the request carries and a council cannot: refused here, before nine
    // real calls are spent on a question that is not the one the client asked
    // (spec 6.1, "reject explicitly what cannot be honored").
    //
    // An attachment has no channel in any of the three prompts, which are the
    // strategy and take a question and nothing else (§12.8); the conversion of
    // an OpenAI body leaves the image in `attachments` and only its text in the
    // message, so accepting this would deliberate on the text alone — and on a
    // message that is an image and nothing else, on the empty question. The
    // empty question is refused in its own right for the same reason: every
    // seat would be asked nothing, and the ranking stage would rank the answers
    // to it.
    if (req.attachments?.length) throw new CapitolineError("bad_request", `model "${req.model}" is a council and cannot take attachments: ask a single model`);
    const question = this.questionOf(req);
    if (question.trim() === "") throw new CapitolineError("bad_request", `model "${req.model}" is a council and needs a question`);
    // The same gate `guarded()` puts in front of a real model, for the virtual
    // one: a council whose seats cannot fill the quorum is refused with the
    // refusal /v1/models and /health have already published, instead of
    // spending the one call it can make and returning a single model's answer
    // under the council's name (§12.5, spec 6.1).
    const state = this.virtualState(virtual, this.realModels());
    if (!state.available) throw new CapitolineError("model_unavailable", `model "${req.model}" unavailable: ${state.reason ?? "the council cannot be seated"}`);
    yield* virtual.run(question, ctx, virtual.efforts.length > 0 ? req.effort : undefined);
  }

  /**
   * The same deliberation as an ordinary completion, for a caller that asked
   * for the council without knowing it is one.
   *
   * The progress is dropped: an OpenAI completion has nowhere to put "2/4
   * answers", and the whole point of the field is that a client which does not
   * know about it sees a perfectly ordinary answer. The failure is thrown
   * rather than yielded, because `CapitolineError` carries a `FailureKind` and
   * the event does too: a council that ended on `queue_full` or
   * `model_unavailable` must still reach the client as a 503 or a 404, which
   * yielding a provider `error` event (an `ErrorKind`, five values) could not
   * express.
   */
  private async *flattenVirtual(req: InternalRequest, ctx: Context): AsyncIterable<ProviderEvent> {
    for await (const ev of this.deliberate(req, ctx)) {
      if (ev.type === "text") yield ev;
      else if (ev.type === "done") yield { type: "done", usage: ev.usage };
      // The kind travels, the council's own words do not: the detail names the
      // models of every chain and what each was refused for, and this gateway
      // answers every other failure with the fixed sentence of its kind (spec
      // 8.3). It is written to the log by the council as it happens, and the
      // un-blinded account of a deliberation that did finish reaches the client
      // in the `capitoline` field, which is where §12.6 puts it.
      else if (ev.type === "error") throw new CapitolineError(ev.kind, CLIENT_MESSAGE[ev.kind]);
    }
  }

  /**
   * The conversation as the one question a council is asked (§12.1: every
   * member answers "the same question").
   *
   * A system message is folded into the text instead of being dropped: the
   * council's prompts are the strategy and have no channel for one (§12.8), and
   * a client that wrote "answer in French" would otherwise be ignored in
   * silence by all nine calls. `flatten` refuses a system message outright,
   * which is why `splitSystem` comes first.
   */
  private questionOf(req: InternalRequest): string {
    const { system, rest } = splitSystem(req.messages);
    const body = flatten(rest);
    return system === null ? body : `${system}\n\n${body}`;
  }

  async *generateImage(req: ImageRequest, ctx: Context): AsyncIterable<ProviderEvent> {
    const entry = this.lookup(req.model);
    if (entry.model.kind !== "image") throw new CapitolineError("bad_request", `model "${req.model}" is a text model: use the chat endpoint`);
    const generate = entry.provider.generateImage?.bind(entry.provider);
    if (!generate) throw new CapitolineError("bad_request", `provider ${entry.provider.id} cannot generate images`);
    yield* this.guarded(entry, req.model, this.cliIdOf(entry), ctx, () => generate(req, entry.model, ctx.signal));
  }

  // Everything both request kinds share: pause and health gates, the
  // provider's concurrency slot, strike/pause bookkeeping and the usage record.
  private async *guarded(entry: Entry, modelName: string, cliId: string, ctx: Context, produce: () => AsyncIterable<ProviderEvent>): AsyncIterable<ProviderEvent> {
    const kind = entry.model.kind;
    const id = entry.provider.id;
    const scope = scopeOf(kind, cliId);
    const key = this.pauseKey(id, scope);
    const s = this.states.get(id)!;
    // Before the pauses: a retired model is not coming back when they clear,
    // and the client should stop asking rather than wait.
    if (entry.provider.isRetired?.(entry.model)) throw new CapitolineError("model_unavailable", `model "${modelName}" unavailable: retired, its CLI no longer lists it`);
    if (this.isPaused(s)) throw this.pausedError(id, s);
    const ownPause = this.keyRemainingS(key);
    if (ownPause !== undefined) throw this.modelPausedError(modelName, ownPause);
    const reason = this.unavailableReason(s);
    if (reason) throw new CapitolineError("model_unavailable", `model "${modelName}" unavailable: ${reason}`);

    const release = await s.sem.acquire(this.opts.maxWaitMs);
    // A pause installed while this request sat in the queue must still stop it
    // (spec 7.1: queued requests get 429 immediately), whichever of the two it is.
    if (this.isPaused(s)) { release(); throw this.pausedError(id, s); }
    const queuedPause = this.keyRemainingS(key);
    if (queuedPause !== undefined) { release(); throw this.modelPausedError(modelName, queuedPause); }

    const started = this.now();
    let outcome: "ok" | ErrorKind = "bad_output";
    let usage: Usage = { input: 0, output: 0 };
    // What the provider says actually answered, when it says anything.
    let cliModelId: string | undefined;
    let sawTerminal = false;
    let phase: "running" | "ended" | "threw" = "running";
    try {
      for await (const ev of produce()) {
        if (ev.type === "done") { sawTerminal = true; outcome = "ok"; usage = ev.usage ?? usage; cliModelId = ev.cliModelId; this.onSuccess(id, s, key, scope); }
        else if (ev.type === "error") { sawTerminal = true; outcome = ev.kind; usage = ev.usage ?? usage; cliModelId = ev.cliModelId ?? cliModelId; this.onError(id, s, key, scope, ev, kind); }
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
      this.usage.record({ provider: id, model: modelName, kind, inputTokens: usage.input, outputTokens: usage.output, cachedInputTokens: usage.cachedInput ?? 0, costUsd: usage.costUsd ?? null,
        durationMs: this.now() - started, outcome: aborted ? "aborted" : outcome, source: ctx.source, caller: ctx.caller ?? null,
        deliberation: ctx.deliberation ?? null, council: ctx.council ?? null, cliModelId: cliModelId ?? null, ts: this.now() });
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
  // Told once when a run of refusals with no reset time has lasted
  // REFUSING_NOTICE_MS, with the weekly window's reset when the provider
  // reports one: not a promise that the limit lifts then, but the one instant
  // there is to offer.
  private noteRefusing(provider: string, scope: string | null, since: number): void {
    if (!this.opts.onAvailability) return;
    const key = `${provider}\u0000${scope ?? ""}`;
    if (this.refusing.has(key) || this.now() - since < REFUSING_NOTICE_MS) return;
    this.refusing.set(key, since);
    const weekly = this.usage.windows(provider).seven_day?.resetsAt;
    // The CLI reports epoch seconds; anything already past says nothing.
    const weeklyMs = weekly === undefined ? undefined : (weekly < 1e12 ? weekly * 1000 : weekly);
    this.tell({ kind: "refusing", provider, scope, refusedMs: this.now() - since, ...(weeklyMs !== undefined && weeklyMs > this.now() ? { weeklyResetAt: weeklyMs } : {}) });
  }

  private endRefusing(provider: string, scope: string | null): void {
    const key = `${provider}\u0000${scope ?? ""}`;
    const since = this.refusing.get(key);
    if (since === undefined) return;
    this.refusing.delete(key);
    this.tell({ kind: "resumed", provider, scope, pausedMs: this.now() - since });
  }

  private onSuccess(id: string, s: State, key: string, scope: string) {
    s.strikes = 0;
    s.refusedSince = null;
    this.endRefusing(id, null);
    this.endRefusing(id, scope);
    if (this.isPaused(s)) this.usage.setPause(id, null, s.pausedUntil!, 0, this.now());
    else if (s.pausedUntil !== null) { s.pausedUntil = null; this.usage.clearPause(id, null); }
    const own = this.modelPauses.get(key);
    if (own === undefined) return;
    if (this.keyRemainingS(key) !== undefined) { own.strikes = 0; this.usage.setPause(id, scope, own.pausedUntil, 0, this.now()); }
    else { this.modelPauses.delete(key); this.usage.clearPause(id, scope); }
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
  private onError(id: string, s: State, key: string, scope: string, ev: Extract<ProviderEvent, { type: "error" }>, modelKind: ModelKind = "text") {
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
      if (ev.scope === "model") { this.pauseModel(id, scope, retryAfterS, key); return; }
      const waitMs = retryAfterS !== undefined ? (Math.max(0, retryAfterS) + 60) * 1000 : Math.min(30, 2 ** s.strikes) * 60_000;
      const fresh = !this.isPaused(s);
      if (s.strikes === 0 || s.refusedSince === null) s.refusedSince = this.now();
      s.strikes++;
      s.pausedUntil = Math.max(s.pausedUntil ?? 0, this.now() + waitMs);
      this.usage.setPause(id, null, s.pausedUntil, s.strikes, this.now());
      this.pauseInstalled(id, null, s.pausedUntil, retryAfterS !== undefined, fresh);
      if (retryAfterS === undefined) this.noteRefusing(id, null, s.refusedSince);
      this.opts.log.warn({ provider: id, seconds: Math.round((s.pausedUntil - this.now()) / 1000), explicit: retryAfterS !== undefined, strikes: s.strikes }, "provider paused after rate limit");
    } else if (kind === "auth_expired") {
      // The same doubt as for a probe (AUTH_RECHECK_MS): one failed token
      // renewal answers a request exactly as a sign-out does. A provider that
      // was healthy is not marked out on a request's word: a confirming probe
      // is scheduled and its verdict stands. While it is on its way, further
      // such answers add nothing. This request has failed either way.
      if (this.authRechecks.has(id) || this.confirming.has(id)) return;
      if (this.deferAuthVerdict(s)) {
        this.opts.log.warn({ provider: id }, "auth_expired reported by a request to a healthy provider, probing before believing it");
        return;
      }
      const before = s.health;
      s.health = { ok: false, kind, detail: "auth_expired reported by a request", checkedAt: this.now() };
      this.healthChanged(id, before, s.health);
      this.opts.log.error({ provider: id }, "provider authentication expired");
    }
  }

  // Schedules the confirming probe for a provider that was healthy and has
  // just answered auth_expired, to a probe or to a request. False when there
  // is nothing to defer: the provider was not healthy (startup, or already
  // out), or a confirming probe is already scheduled or running.
  private deferAuthVerdict(s: State): boolean {
    const id = s.provider.id;
    if (!s.health?.ok || this.confirming.has(id) || this.authRechecks.has(id)) return false;
    const timer = setTimeout(() => {
      this.authRechecks.delete(id);
      this.confirming.add(id);
      void this.checkHealth(id).catch(() => {}).finally(() => this.confirming.delete(id));
    }, this.opts.authRecheckMs ?? AUTH_RECHECK_MS);
    timer.unref();
    this.authRechecks.set(id, timer);
    return true;
  }

  // The model's own pause, by the same rules as the provider's: an explicit
  // reset plus a minute of slack, the doubling backoff without one, and a
  // pause that only ever grows while it stands. Its strikes are the model's,
  // so a second model of the same provider starts its own count, and a
  // successful run of this model clears both (guarded(), on `done`).
  private pauseModel(providerId: string, scope: string, retryAfterS?: number, precomputed?: string) {
    const key = precomputed ?? this.pauseKey(providerId, scope);
    const p = this.modelPauses.get(key) ?? { pausedUntil: 0, strikes: 0 };
    const waitMs = retryAfterS !== undefined ? (Math.max(0, retryAfterS) + 60) * 1000 : Math.min(30, 2 ** p.strikes) * 60_000;
    const fresh = p.pausedUntil <= this.now();
    if (p.strikes === 0 || p.since === undefined) p.since = this.now();
    p.strikes++;
    p.pausedUntil = Math.max(p.pausedUntil, this.now() + waitMs);
    this.modelPauses.set(key, p);
    this.usage.setPause(providerId, scope, p.pausedUntil, p.strikes, this.now());
    this.pauseInstalled(providerId, scope, p.pausedUntil, retryAfterS !== undefined, fresh);
    if (retryAfterS === undefined) this.noteRefusing(providerId, scope, p.since);
    this.opts.log.warn({ provider: providerId, model: scope, seconds: Math.round((p.pausedUntil - this.now()) / 1000), explicit: retryAfterS !== undefined, strikes: p.strikes }, "model paused after a rate limit");
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
  /**
   * What a stored `model` column means as a scope, or null when it names
   * nothing this configuration can reach. Takes the current shape unchanged
   * and translates the two older ones; see restorePauses() for the history.
   */
  private scopeOfRow(providerId: string, stored: string): string | null {
    const known = this.knownScopes.get(providerId);
    if (known === undefined) return null;
    if (known.has(stored)) return stored;
    // A bare CLI id, written on 2026-09-22. That shape carries no kind and
    // none can be recovered from it, so it is read as text — right for every
    // row but one. The exception is worth naming because it was a live row:
    // the deploy that first translated a gateway name wrote the image pause of
    // the 22nd in this shape, and the next deploy read it back as text, which
    // freed the image model and darkened the text one. It was repaired by hand
    // on the host (2026-09-23) and the shape existed for about an hour, so
    // nothing else can be holding one.
    if (known.has(scopeOf("text", stored))) return scopeOf("text", stored);
    // A gateway name, written before that: resolved through this
    // configuration, which is also where the kind comes from.
    const entry = this.modelIndex.get(stored);
    if (entry === undefined || entry.provider.id !== providerId) return null;
    return scopeOf(entry.model.kind, this.cliIdOf(entry));
  }

  restorePauses(): void {
    const rows = this.usage.pauses(this.now());
    // Announced pauses that ran out while no process was watching: their end
    // is still news, so it is told now, before the rows go.
    if (this.opts.onAvailability) {
      for (const row of this.usage.expiredAnnouncedPauses(this.now())) {
        const scope = row.model === null ? null : this.scopeOfRow(row.provider, row.model);
        const pausedMs = row.until - row.announcedAt!;
        if (pausedMs >= RESUME_NOTICE_MS) this.tell({ kind: "resumed", provider: row.provider, scope: row.model === null ? null : (scope ?? row.model), pausedMs });
      }
    }
    const removed = this.usage.prunePauses(this.now());
    if (removed > 0) this.opts.log.info({ removed }, "expired pauses pruned");
    for (const row of rows) {
      if (row.model === null) {
        const s = this.states.get(row.provider);
        if (!s) continue;
        s.pausedUntil = row.until;
        s.strikes = row.strikes;
      } else {
        // The column holds a `scopeOf` scope. It has held two older shapes,
        // and both are translated rather than dropped: restored under the
        // scope they mean, and rewritten in the store, so the translation
        // happens once and the next start finds the current shape.
        //
        //   before 2026-09-22  the gateway name        `antigravity-image`
        //   2026-09-22         the bare CLI id         `gemini-3.8-flash-low`
        //   since 2026-09-23   the scope               `image:gemini-3.8-flash-low`
        //
        // Dropping instead of translating was a real loss the first time:
        // the five-day image pause of 2026-09-22, the very case the doc
        // comment above names, went with the restart after the key first
        // moved, and the next image request would have spent one generation
        // of a weekly quota of 58 to rediscover a refusal written in the
        // table.
        //
        // A row that means none of the three is a model the configuration no
        // longer declares: skipped rather than restored under a key nothing
        // will ever look up, and pruned once it expires.
        //
        // Both translations are one-transition steps and can be deleted once
        // no deployed database can still hold an older row.
        const scope = this.scopeOfRow(row.provider, row.model);
        if (scope === null) continue;
        if (scope !== row.model) {
          this.usage.clearPause(row.provider, row.model);
          this.usage.setPause(row.provider, scope, row.until, row.strikes, this.now());
          this.opts.log.info({ provider: row.provider, from: row.model, to: scope }, "pause row translated to the current shape");
        }
        this.modelPauses.set(this.pauseKey(row.provider, scope), { pausedUntil: row.until, strikes: row.strikes });
        // The reset an image quota reported lives in memory only; after a
        // restart it is read back from the pause it installed, so /health
        // still says when the image model returns (the pause ends a minute
        // after the reset, which is when a request is let through again).
        const st = this.states.get(row.provider);
        if (st && scope.startsWith("image:")) st.imageResetAt = Math.max(st.imageResetAt ?? 0, row.until);
        if (row.announcedAt !== null && this.opts.onAvailability) this.announced.set(`${row.provider}\u0000${scope}`, { provider: row.provider, scope, at: row.announcedAt, until: row.until });
      }
      if (row.model === null && row.announcedAt !== null && this.opts.onAvailability && this.states.has(row.provider)) {
        this.announced.set(`${row.provider}\u0000`, { provider: row.provider, scope: null, at: row.announcedAt, until: row.until });
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

  /** Drops the confirming probes still waiting to run: a shutdown must not have one land on a closed store. */
  cancelAuthRechecks(): void {
    for (const timer of this.authRechecks.values()) clearTimeout(timer);
    this.authRechecks.clear();
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
      const probedId = s.provider.healthCliId;
      const modelPaused = probedId === undefined ? undefined : this.keyRemainingS(this.pauseKey(s.provider.id, scopeOf("text", probedId)));
      if (modelPaused !== undefined) {
        this.opts.log.info({ provider: s.provider.id, model: probed, seconds: modelPaused }, "health check skipped: health model paused");
        return;
      }
      let status: HealthStatus;
      try { status = await s.provider.health(); }
      catch (e) { status = { ok: false, kind: "cli_crashed", detail: String(e), checkedAt: this.now() }; }
      // Not at startup and not for a provider already out (s.health?.ok): there
      // the verdict is taken at once, so the port is never held for it.
      const id = s.provider.id;
      if (!status.ok && status.kind === "auth_expired" && this.deferAuthVerdict(s)) {
        this.usage.record({ provider: id, model: "health", inputTokens: 0, outputTokens: 0, durationMs: 0, outcome: "auth_expired", source: "health", ts: this.now() });
        this.opts.log.warn({ provider: id, detail: status.detail, recheckS: Math.round((this.opts.authRecheckMs ?? AUTH_RECHECK_MS) / 1000) }, "health check: auth_expired from a healthy provider, probing again before believing it");
        return;
      }
      // A rate limit the CLI attributed to the probe's own model is about that
      // model, not about the provider: the very same answer coming from a
      // client request pauses the model alone (onError). Marking the provider
      // here would make every one of its models unavailable — 404 in
      // /v1/models, model_unavailable on a request — until that single model's
      // limit expires, and the loop would renew the verdict every round. So the
      // model is paused and the provider keeps the health it had.
      const modelOnly = !status.ok && status.kind === "rate_limited" && status.scope === "model" && status.model !== undefined;
      // By the id the probe sent, which it reports: the probe picks its own
      // effort, so the id is not derivable from the model name out here.
      if (modelOnly) this.pauseModel(s.provider.id, scopeOf("text", status.cliId ?? status.model!), undefined);
      else { const before = s.health; s.health = status; this.healthChanged(s.provider.id, before, status); }
      this.usage.record({ provider: s.provider.id, model: "health", inputTokens: 0, outputTokens: 0, durationMs: 0, outcome: status.ok ? "ok" : (status.kind ?? "cli_crashed"), source: "health", ts: this.now() });
      this.opts.log.info({ provider: s.provider.id, ok: status.ok, kind: status.kind, detail: status.detail, ...(modelOnly ? { model: status.model, scope: "model" } : {}) }, "health check");
    }));
  }

  /**
   * The catalogs as the last process left them, applied before the port is
   * ready: a restart must neither drop the models discovery had added until
   * the next listing lands, nor report every one of them as new when it does.
   * Silent on purpose — nothing changed, the gateway only remembered.
   */
  restoreCatalog(): void {
    for (const row of this.usage.catalogs()) {
      const s = this.states.get(row.provider);
      if (!s?.provider.discovers || !s.provider.applyListing) continue;
      s.provider.applyListing(row.listing);
      this.reindex(s.provider);
      s.catalog = { checkedAt: row.checkedAt, ok: true };
      this.opts.log.info({ provider: row.provider, ...s.provider.catalogNames?.() }, "model catalog restored");
    }
  }

  /** Asks every provider that lists its models for a fresh listing. Tracked like a health check, so a shutdown waits for it. */
  checkCatalog(): Promise<void> {
    const run = this.runCatalog();
    const tracked = run.then(() => {}, () => {});
    this.inFlight.add(tracked);
    void tracked.finally(() => this.inFlight.delete(tracked));
    return run;
  }

  private async runCatalog(): Promise<void> {
    const targets = [...this.states.values()].filter((s) => s.provider.discovers && s.provider.listModels && s.provider.applyListing);
    await Promise.all(targets.map(async (s) => {
      const p = s.provider;
      let listed;
      try {
        listed = await p.listModels!();
      } catch (e) {
        // Nothing is retired on a failed listing: the catalog stays as it was.
        s.catalog = { checkedAt: this.now(), ok: false };
        this.opts.log.warn({ provider: p.id, err: e instanceof Error ? e.message : String(e) }, "model listing failed; catalog kept");
        return;
      }
      const change = p.applyListing!(listed);
      this.usage.saveCatalog(p.id, listed, this.now());
      this.reindex(p);
      s.catalog = { checkedAt: this.now(), ok: true };
      if (change.added.length === 0 && change.removed.length === 0) {
        this.opts.log.info({ provider: p.id, listed: listed.length }, "model catalog unchanged");
        return;
      }
      this.opts.log.info({ provider: p.id, added: change.added, removed: change.removed }, "model catalog changed");
      try { this.opts.onCatalogChange?.(p.id, change); }
      catch (e) { this.opts.log.warn({ provider: p.id, err: String(e) }, "catalog change listener threw"); }
    }));
  }

  /** Asks every provider whose CLI reports its quota for a fresh report. No model is called. Tracked like a health check. */
  checkQuota(): Promise<void> {
    const run = this.runQuota();
    const tracked = run.then(() => {}, () => {});
    this.inFlight.add(tracked);
    void tracked.finally(() => this.inFlight.delete(tracked));
    return run;
  }

  private async runQuota(): Promise<void> {
    const targets = [...this.states].filter(([, s]) => s.provider.reportsQuota && s.provider.quota);
    await Promise.all(targets.map(async ([id, s]) => {
      let buckets: QuotaBucket[];
      try {
        buckets = await s.provider.quota!();
      } catch (e) {
        // The last figures stay, marked as not fresh: a failed read is not an empty quota.
        s.quota = { checkedAt: this.now(), ok: false, buckets: s.quota?.buckets ?? [] };
        this.opts.log.warn({ provider: id, err: e instanceof Error ? e.message : String(e) }, "quota report failed; last figures kept");
        return;
      }
      s.quota = { checkedAt: this.now(), ok: true, buckets };
      this.noteQuota(id, buckets);
    }));
  }

  // A weekly bucket under the configured share is announced once per window.
  // What was announced is kept in the store, by the instant the window
  // refills, so a restart does not say it again and the next window can.
  private noteQuota(id: string, buckets: QuotaBucket[]): void {
    const below = this.opts.quotaNotifyBelow?.[id] ?? 0.2;
    for (const b of buckets) {
      if (b.window !== "weekly" || b.remaining >= below) continue;
      const key = `quota_low:${id}:${b.id}`, mark = b.resetsAt ?? 0, told = this.usage.setting(key);
      // The reset instant wobbles by seconds between two reports of one window.
      if (typeof told === "number" && Math.abs(told - mark) < 3600_000) continue;
      this.usage.setSetting(key, mark, this.now());
      this.opts.log.info({ provider: id, bucket: b.id, remaining: b.remaining, resetsAt: b.resetsAt }, "weekly quota is low");
      this.tell({ kind: "quota_low", provider: id, group: b.group, remaining: b.remaining, resetsAt: b.resetsAt });
    }
  }

  startQuotaLoop(intervalMs: number): () => void {
    const timer = setInterval(() => {
      this.checkQuota().catch((err: unknown) => this.opts.log.error({ err }, "quota check failed"));
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  startCatalogLoop(intervalMs: number): () => void {
    const timer = setInterval(() => {
      this.checkCatalog().catch((err: unknown) => this.opts.log.error({ err }, "model catalog check failed"));
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
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
