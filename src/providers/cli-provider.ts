import type { ProviderConfig } from "../config.js";
import type { Logger } from "../log.js";
import type { InternalRequest, ProviderEvent } from "../core/types.js";
import type { Runner } from "../runner/runner.js";
import { modelSpecs, type Adapter, type HealthStatus, type ModelSpec, type Provider } from "./adapter.js";
import { classifyError } from "./errors.js";

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
}
const DEFAULTS: Required<CliProviderOptions> = { exitGraceMs: 1000, healthDeadlineMs: 60_000 };

export class CliProvider implements Provider {
  readonly id: string;
  readonly concurrencyLimit: number;
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
    this.opts = { ...DEFAULTS, ...opts };
  }

  models(): ModelSpec[] { return modelSpecs(this.id, this.cfg); }

  async *execute(req: InternalRequest, model: ModelSpec, signal?: AbortSignal): AsyncIterable<ProviderEvent> {
    const { args, stdin } = this.adapter.buildCommand(this.cfg, model, req);
    const files = (req.attachments ?? []).map((a, i) => ({ name: `attachment-${i + 1}.${extensionFor(a.mime)}`, bytes: a.bytes }));
    // The run gets an internal controller: it follows the caller's signal, and
    // execute() itself uses it to stop a CLI that keeps running after its final
    // event (Antigravity stalls on tool calls) or after the consumer went away.
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (signal?.aborted) ac.abort(); else signal?.addEventListener("abort", onAbort, { once: true });
    const handle = await this.runner.run({ binary: this.cfg.binary, args, stdin, timeoutMs: this.cfg.timeout_s * 1000, signal: ac.signal, files });
    void handle.result.then(() => signal?.removeEventListener("abort", onAbort));
    let terminal = false;
    try {
      for await (const ev of this.adapter.parse(handle.lines)) {
        // Adapter-internal events stay here: a text run has no use for them and
        // the Provider contract (AsyncIterable<ProviderEvent>) forbids forwarding them.
        if (ev.type === "meta" || ev.type === "tool") continue;
        if (ev.type === "done" || ev.type === "error") terminal = true;
        yield ev;
        if (terminal) return; // do not wait for the process: the answer is complete
      }
      const r = await handle.result;
      if (r.timedOut) {
        this.log.warn({ model: model.name, timeoutS: this.cfg.timeout_s }, "cli run timed out");
        yield { type: "error", kind: "timeout", detail: `killed after ${this.cfg.timeout_s}s` };
      } else if (r.aborted) {
        // The caller gave up (client disconnected): not a CLI failure, so no error event.
        this.log.info({ model: model.name }, "cli run aborted by caller");
      } else if (r.exitCode !== 0) {
        const kind = classifyError(r.stderr);
        this.log.warn({ model: model.name, exitCode: r.exitCode, kind, stderr: r.stderr.slice(-2000) }, "cli run failed");
        yield { type: "error", kind, detail: r.stderr.slice(-2000) };
      } else {
        this.log.warn({ model: model.name, stderr: r.stderr.slice(-2000) }, "cli exited without a result event");
        yield { type: "error", kind: "bad_output", detail: "CLI exited without a result event" };
      }
    } finally {
      // Runs on normal completion, on the early return above and when the
      // consumer stops iterating: the process must never outlive its consumer.
      if (terminal) {
        const grace = setTimeout(() => ac.abort(), this.opts.exitGraceMs);
        grace.unref();
        void handle.result.then(() => clearTimeout(grace));
      } else {
        ac.abort(); // no-op when the process has already ended
      }
    }
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
      for await (const ev of this.execute({ model: model.name, stream: false, effort: "low", messages: [{ role: "user", text: "Reply with the single word: ok" }] }, model, ac.signal)) {
        if (ev.type === "done") status = { ok: true, checkedAt: Date.now() };
        else if (ev.type === "error") status = { ok: false, kind: ev.kind, detail: ev.detail, checkedAt: Date.now() };
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
