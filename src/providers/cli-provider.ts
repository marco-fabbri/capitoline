import type { Effort, ProviderConfig } from "../config.js";
import type { Logger } from "../log.js";
import type { ImageRequest, InternalRequest, ProviderEvent, Usage } from "../core/types.js";
import type { Runner, RunHandle } from "../runner/runner.js";
import { cliId as resolveCliId, modelSpecs, type Adapter, type HealthStatus, type ModelSpec, type Provider } from "./adapter.js";
import { classifyError, detectQuotaExhausted, type QuotaHit } from "./errors.js";
import { inspectImage } from "./image-check.js";

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

// The mime comes from the client's data URL: parameters are dropped and only
// own keys of EXT count, so "__proto__" or "constructor" cannot name a file.
function extensionFor(mime: string): string {
  const key = (mime.split(";")[0] ?? "").trim().toLowerCase();
  return Object.hasOwn(EXT, key) ? EXT[key] : "bin";
}

export interface CliProviderOptions {
  /** How long a CLI may linger after its final event before it is stopped. */
  exitGraceMs?: number;
  /** Deadline for a health probe. */
  healthDeadlineMs?: number;
  /** Clock used to turn a quota reset instant into a wait (tests pin it). */
  now?: () => number;
  /** Deadline for the image collect helper (tests shorten it). */
  collectTimeoutMs?: number;
}
// Bounds for the collect helper: a generation is ~1 MB, and the helper only
// reads one file, so anything beyond these is a fault, not a bigger picture.
const COLLECT_TIMEOUT_MS = 30_000;
const COLLECT_MAX_BYTES = 20 * 1024 * 1024;
// The probe runs at the cheapest level the configuration prices: it asks for
// one word and only needs to learn whether the CLI answers at all. Named
// because the id the model resolves to depends on it, and that id is the key
// a refusal during a probe is filed under.
const HEALTH_EFFORT = "low" as const;
// Exit code of the collect helper when the conversation exists but holds no image.
const COLLECT_NO_IMAGE = 4;
const DEFAULTS: Required<CliProviderOptions> = { exitGraceMs: 1000, healthDeadlineMs: 60_000, now: Date.now, collectTimeoutMs: COLLECT_TIMEOUT_MS };
// The conversation id becomes an argument of a privileged command: only this
// shape is ever passed on, whatever an adapter reports.
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A run's process, its internal abort controller and the wind-down shared by
// execute() and generateImage(): the process must never outlive its consumer.
interface Run {
  handle: RunHandle;
  ac: AbortController;
  /** After the terminal event: let the CLI exit by itself, stop it after the grace. */
  windDown(): void;
}

export class CliProvider implements Provider {
  readonly id: string;
  readonly concurrencyLimit: number;
  /** The model health() runs, so Core can skip the probe while that model is paused. */
  readonly healthModel: string;
  /** What that model resolves to at HEALTH_EFFORT: the key its pause is filed under. */
  readonly healthCliId: string;
  private readonly opts: Required<CliProviderOptions>;
  constructor(
    id: string,
    private readonly cfg: ProviderConfig,
    private readonly adapter: Adapter,
    private readonly runner: Runner,
    private readonly log: Logger,
    opts: CliProviderOptions = {},
  ) {
    this.id = id;
    this.concurrencyLimit = cfg.concurrency;
    this.healthModel = cfg.health_model;
    const probed = modelSpecs(id, cfg).find((m) => m.name === cfg.health_model);
    this.healthCliId = probed ? resolveCliId(cfg, probed, HEALTH_EFFORT) : cfg.health_model;
    this.opts = { ...DEFAULTS, ...opts };
  }

  models(): ModelSpec[] { return modelSpecs(this.id, this.cfg); }

  cliId(model: ModelSpec, effort?: Effort): string { return resolveCliId(this.cfg, model, effort); }

  private async start(args: string[], stdin: string, timeoutMs: number, signal: AbortSignal | undefined, files?: { name: string; bytes: Buffer }[]): Promise<Run> {
    // The run gets an internal controller: it follows the caller's signal, and
    // the provider itself uses it to stop a CLI that keeps running after its final
    // event (Antigravity stalls on tool calls) or after the consumer went away.
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (signal?.aborted) ac.abort(); else signal?.addEventListener("abort", onAbort, { once: true });
    const handle = await this.runner.run({ binary: this.cfg.binary, args, stdin, timeoutMs, signal: ac.signal, files });
    void handle.result.then(() => signal?.removeEventListener("abort", onAbort));
    let wound = false;
    const windDown = () => {
      if (wound) return;
      wound = true;
      const grace = setTimeout(() => ac.abort(), this.opts.exitGraceMs);
      grace.unref();
      void handle.result.then(() => clearTimeout(grace));
    };
    return { handle, ac, windDown };
  }

  // What to report when the stream ended without a terminal event: the process
  // result decides. Null when the caller aborted (not a CLI failure).
  private async endedEarly(run: Run, model: ModelSpec, timeoutS: number): Promise<ProviderEvent | null> {
    const r = await run.handle.result;
    if (r.timedOut) {
      this.log.warn({ model: model.name, timeoutS }, "cli run timed out");
      return { type: "error", kind: "timeout", detail: `killed after ${timeoutS}s` };
    }
    if (r.aborted) {
      // The caller gave up (client disconnected): not a CLI failure, so no error event.
      this.log.info({ model: model.name }, "cli run aborted by caller");
      return null;
    }
    if (r.exitCode !== 0) {
      const kind = classifyError(r.stderr);
      this.log.warn({ model: model.name, exitCode: r.exitCode, kind, stderr: r.stderr.slice(-2000) }, "cli run failed");
      return { type: "error", kind, detail: r.stderr.slice(-2000) };
    }
    this.log.warn({ model: model.name, stderr: r.stderr.slice(-2000) }, "cli exited without a result event");
    return { type: "error", kind: "bad_output", detail: "CLI exited without a result event" };
  }

  async *execute(req: InternalRequest, model: ModelSpec, signal?: AbortSignal): AsyncIterable<ProviderEvent> {
    const { args, stdin } = this.adapter.buildCommand(this.cfg, model, req);
    const files = (req.attachments ?? []).map((a, i) => ({ name: `attachment-${i + 1}.${extensionFor(a.mime)}`, bytes: a.bytes }));
    const run = await this.start(args, stdin, this.cfg.timeout_s * 1000, signal, files);
    let terminal = false;
    try {
      for await (const ev of this.adapter.parse(run.handle.lines)) {
        // Adapter-internal events stay here: a text run has no use for them and
        // the Provider contract (AsyncIterable<ProviderEvent>) forbids forwarding them.
        if (ev.type === "meta" || ev.type === "tool") continue;
        if (ev.type === "done" || ev.type === "error") terminal = true;
        yield ev;
        if (terminal) return; // do not wait for the process: the answer is complete
      }
      const ended = await this.endedEarly(run, model, this.cfg.timeout_s);
      if (ended) yield ended;
    } finally {
      // Runs on normal completion, on the early return above and when the
      // consumer stops iterating: the process must never outlive its consumer.
      if (terminal) run.windDown(); else run.ac.abort(); // abort is a no-op when the process has already ended
    }
  }

  // One image: the CLI is an agent, so the run is guarded (only the configured
  // tools may be called), the silent quota failure is detected from the tool
  // step or the agent's prose, and the bytes are collected through the
  // configured helper, never by reading the CLI's home.
  async *generateImage(req: ImageRequest, model: ModelSpec, signal?: AbortSignal): AsyncIterable<ProviderEvent> {
    if (!this.adapter.buildImageCommand || !this.cfg.image.collect) {
      yield { type: "error", kind: "bad_output", detail: `provider "${this.id}" cannot generate images` };
      return;
    }
    const { args, stdin } = this.adapter.buildImageCommand(this.cfg, model, req);
    const timeoutS = model.timeoutS ?? this.cfg.timeout_s;
    const run = await this.start(args, stdin, timeoutS * 1000, signal);
    const allowed = new Set(this.cfg.image.allowed_tools);
    // Tools that reached a terminal phase: a later call is a second invocation,
    // which the prompt forbids and which would spend quota on an image the
    // helper never collects (it returns one file).
    const finished = new Set<string>();
    let conversationId: string | undefined;
    let prose = "";
    let usage: Usage | undefined;
    let terminal = false;
    try {
      for await (const ev of this.adapter.parse(run.handle.lines)) {
        if (ev.type === "meta") {
          conversationId = ev.conversationId;
        } else if (ev.type === "tool") {
          if (ev.phase === "call" && !allowed.has(ev.name)) {
            this.log.warn({ model: model.name, tool: ev.name }, "unexpected tool call: run aborted");
            run.ac.abort();
            yield { type: "error", kind: "bad_output", detail: `unexpected tool call: ${ev.name}` };
            return;
          }
          if (ev.phase === "call" && finished.has(ev.name)) {
            this.log.warn({ model: model.name, tool: ev.name }, "tool called more than once: run aborted");
            run.ac.abort();
            yield { type: "error", kind: "bad_output", detail: `tool called more than once: ${ev.name}` };
            return;
          }
          if (ev.phase === "done" || ev.phase === "error") finished.add(ev.name);
          const hit = detectQuotaExhausted(ev.raw, this.opts.now());
          if (hit) {
            run.ac.abort();
            // Nothing landed, but the CLI created the conversation directory:
            // collect it best effort so a run of 429s leaves no litter behind.
            await run.handle.result;
            await this.discardConversation(model, conversationId);
            yield this.quotaError(model, hit);
            return;
          }
          if (ev.phase === "error") this.log.warn({ model: model.name, tool: ev.name, raw: ev.raw.slice(0, 2000) }, "image tool step failed");
        } else if (ev.type === "text") {
          prose += ev.delta;
        } else if (ev.type === "error") {
          terminal = true;
          yield ev;
          return;
        } else if (ev.type === "done") {
          terminal = true;
          usage = ev.usage;
          break;
        }
        // rate_limit and image events are not produced by this path; nothing to forward.
      }
      if (!terminal) {
        const ended = await this.endedEarly(run, model, timeoutS);
        if (ended) yield ended;
        return;
      }
      // The collect helper removes the conversation directory: the CLI must be
      // done with it, so the process is let go (with its grace) before collecting.
      run.windDown();
      await run.handle.result;

      const proseHit = detectQuotaExhausted(prose, this.opts.now());
      if (!conversationId || !CONVERSATION_ID.test(conversationId)) {
        if (proseHit) { yield this.quotaError(model, proseHit); return; }
        this.log.warn({ model: model.name, conversationId }, "image run reported no usable conversation id");
        yield { type: "error", kind: "bad_output", detail: "no conversation id in the CLI output" };
        return;
      }
      const collected = await this.collect(conversationId);
      if (collected.exitCode === COLLECT_NO_IMAGE || (collected.exitCode === 0 && collected.stdout.length === 0)) {
        // Only now does the prose count: a quota hit leaves nothing in the
        // conversation, so an image that came out disproves it, and the prose
        // is prompt-driven text that may merely echo "rate limit" or "429".
        if (proseHit) { yield this.quotaError(model, proseHit); return; }
        this.log.warn({ model: model.name, conversationId, prose: prose.slice(-500) }, "image run produced no image");
        yield { type: "error", kind: "bad_output", detail: "no image produced" };
        return;
      }
      if (collected.exitCode !== 0) {
        // The helper's stderr may name host paths and users: logs only.
        this.log.warn({ model: model.name, conversationId, exitCode: collected.exitCode, timedOut: collected.timedOut, stderr: collected.stderr.slice(-2000) }, "image collection failed");
        const detail = collected.timedOut
          ? `image collection timed out after ${this.opts.collectTimeoutMs / 1000}s`
          : `image collection failed (exit ${String(collected.exitCode)})`;
        yield { type: "error", kind: "bad_output", detail };
        return;
      }
      const verdict = inspectImage(collected.stdout, { minBytes: this.cfg.image.min_bytes });
      if (!verdict.ok) {
        this.log.warn({ model: model.name, conversationId, bytes: collected.stdout.length, reason: verdict.reason }, "collected file is not a usable image");
        yield { type: "error", kind: "bad_output", detail: `collected file rejected: ${verdict.reason}` };
        return;
      }
      yield { type: "image", mime: verdict.info.mime, bytes: collected.stdout, width: verdict.info.width, height: verdict.info.height };
      yield { type: "done", usage };
    } finally {
      if (terminal) run.windDown(); else run.ac.abort();
    }
  }

  // Runs the configured collect helper: image bytes on stdout, and the
  // conversation directory is removed either way.
  private collect(conversationId: string) {
    const [binary, ...collectArgs] = this.cfg.image.collect!;
    return this.runner.capture({ binary, args: [...collectArgs, conversationId], timeoutMs: this.opts.collectTimeoutMs, maxBytes: COLLECT_MAX_BYTES });
  }

  // Clean-up only: whatever the helper returns is irrelevant to a run that
  // already failed, and its own failure must not mask the real error.
  private async discardConversation(model: ModelSpec, conversationId: string | undefined): Promise<void> {
    if (!conversationId || !CONVERSATION_ID.test(conversationId)) return;
    try {
      const r = await this.collect(conversationId);
      if (r.exitCode !== 0 && r.exitCode !== COLLECT_NO_IMAGE) this.log.warn({ model: model.name, conversationId, exitCode: r.exitCode, timedOut: r.timedOut }, "conversation clean-up failed");
    } catch (e) {
      this.log.warn({ model: model.name, conversationId, err: String(e) }, "conversation clean-up threw");
    }
  }

  private quotaError(model: ModelSpec, hit: QuotaHit): ProviderEvent {
    this.log.warn({ model: model.name, quotaModel: hit.model, matched: hit.matched, retryAfterS: hit.retryAfterS, resetAt: hit.resetAt }, "image quota exhausted");
    const detail = `image quota exhausted for ${hit.model ?? model.cliModel} (${hit.matched})` + (hit.retryAfterS === undefined ? "" : `, resets in ${hit.retryAfterS}s`);
    // Scoped to the model, always: the image tool has a quota of its own
    // (gemini-3.1-flash-image, 12 per 5 hours and 58 per week) and the text
    // models of the same CLI draw on a different pool. Pausing the provider
    // here took every Antigravity text model down for five days over an image
    // refusal (observed in production 2026-09-22) — and that pause outlives
    // the quota it came from, because the image window is the longer one.
    return { type: "error", kind: "rate_limited", detail, retryAfterS: hit.retryAfterS, scope: "model" };
  }

  async health(): Promise<HealthStatus> {
    const model = this.models().find((m) => m.name === this.cfg.health_model);
    if (!model) return { ok: false, kind: "bad_output", detail: `unknown health_model "${this.cfg.health_model}"`, checkedAt: Date.now() };
    const ac = new AbortController();
    let deadlineHit = false;
    const timer = setTimeout(() => { deadlineHit = true; ac.abort(); }, this.opts.healthDeadlineMs);
    let status: HealthStatus | null = null;
    try {
      // No early return here: execute() ends by itself right after the terminal
      // event and winds the CLI down with its grace period.
      for await (const ev of this.execute({ model: model.name, stream: false, effort: HEALTH_EFFORT, messages: [{ role: "user", text: "Reply with the single word: ok" }] }, model, ac.signal)) {
        if (ev.type === "done") status = { ok: true, checkedAt: Date.now() };
        // The attribution travels with the verdict: the probe runs one model
        // (health_model), so a refusal the CLI blamed on that model must pause
        // that model alone, exactly as it would coming from a client request.
        // Marking the provider here would take down every other model of it
        // until this one's limit expires, and the loop would renew it.
        else if (ev.type === "error") status = { ok: false, kind: ev.kind, detail: ev.detail, model: model.name, cliId: this.cliId(model, HEALTH_EFFORT), ...(ev.scope ? { scope: ev.scope } : {}), checkedAt: Date.now() };
      }
    } finally {
      clearTimeout(timer);
      if (!status) ac.abort(); // deadline or exception: stop the probe's process now
    }
    if (status) return status;
    if (deadlineHit) return { ok: false, kind: "timeout", detail: `no answer within ${this.opts.healthDeadlineMs / 1000}s`, checkedAt: Date.now() };
    return { ok: false, kind: "bad_output", detail: "no terminal event", checkedAt: Date.now() };
  }
}
