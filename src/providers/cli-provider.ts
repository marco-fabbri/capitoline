import type { Config, ProviderConfig } from "../config.js";
import type { Logger } from "../log.js";
import type { InternalRequest, ProviderEvent } from "../core/types.js";
import type { Runner } from "../runner/runner.js";
import { modelSpecs, type Adapter, type HealthStatus, type ModelSpec, type Provider } from "./adapter.js";
import { classifyError } from "./errors.js";

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

export class CliProvider implements Provider {
  readonly id: string;
  readonly concurrencyLimit: number;
  constructor(id: string, private readonly cfg: ProviderConfig, private readonly adapter: Adapter, private readonly runner: Runner, private readonly log: Logger) {
    this.id = id;
    this.concurrencyLimit = cfg.concurrency;
  }

  models(): ModelSpec[] { return modelSpecs(this.id, this.cfg); }

  async *execute(req: InternalRequest, model: ModelSpec, signal?: AbortSignal): AsyncIterable<ProviderEvent> {
    const { args, stdin } = this.adapter.buildCommand(this.cfg, model, req);
    const files = (req.attachments ?? []).map((a, i) => ({ name: `attachment-${i + 1}.${EXT[a.mime] ?? "bin"}`, bytes: a.bytes }));
    const handle = await this.runner.run({ binary: this.cfg.binary, args, stdin, timeoutMs: this.cfg.timeout_s * 1000, signal, files });
    let terminal = false;
    for await (const ev of this.adapter.parse(handle.lines)) {
      if (ev.type === "done" || ev.type === "error") terminal = true;
      yield ev;
      if (terminal) break;
    }
    const r = await handle.result;
    if (terminal) return;
    if (r.timedOut) yield { type: "error", kind: "timeout", detail: `killed after ${this.cfg.timeout_s}s` };
    else if (r.aborted) yield { type: "error", kind: "cli_crashed", detail: "aborted by client" };
    else if (r.exitCode !== 0) yield { type: "error", kind: classifyError(r.stderr), detail: r.stderr.slice(-2000) };
    else yield { type: "error", kind: "bad_output", detail: "CLI exited without a result event" };
  }

  async health(): Promise<HealthStatus> {
    const model = this.models().find((m) => m.name === this.cfg.health_model)!;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60_000);
    try {
      for await (const ev of this.execute({ model: model.name, stream: false, effort: "low", messages: [{ role: "user", text: "Reply with the single word: ok" }] }, model, ac.signal)) {
        if (ev.type === "done") return { ok: true, checkedAt: Date.now() };
        if (ev.type === "error") return { ok: false, kind: ev.kind, detail: ev.detail, checkedAt: Date.now() };
      }
      return { ok: false, kind: "bad_output", detail: "no terminal event", checkedAt: Date.now() };
    } finally { clearTimeout(timer); }
  }
}
