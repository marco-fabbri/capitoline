import type { HealthStatus, ModelSpec, Provider } from "../src/providers/adapter.js";
import type { InternalRequest, ProviderEvent } from "../src/core/types.js";

export type Script = ProviderEvent[] | ((req: InternalRequest) => ProviderEvent[]);

export class FakeProvider implements Provider {
  calls: InternalRequest[] = [];
  healthResult: HealthStatus = { ok: true, checkedAt: 0 };
  delayMs = 0;
  constructor(readonly id: string, private modelNames: string[], public script: Script, readonly concurrencyLimit = 1) {}
  models(): ModelSpec[] { return this.modelNames.map((name) => ({ name, provider: this.id, cliModel: name, effortSuffix: false })); }
  async *execute(req: InternalRequest, _m: ModelSpec, signal?: AbortSignal): AsyncIterable<ProviderEvent> {
    this.calls.push(req);
    const events = typeof this.script === "function" ? this.script(req) : this.script;
    for (const ev of events) {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      if (signal?.aborted) return;
      yield ev;
    }
  }
  async health(): Promise<HealthStatus> { return { ...this.healthResult, checkedAt: Date.now() }; }
}
