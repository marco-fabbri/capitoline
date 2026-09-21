import type { HealthStatus, ModelKind, ModelSpec, Provider } from "../src/providers/adapter.js";
import type { ImageRequest, InternalRequest, ProviderEvent } from "../src/core/types.js";

export type Script = ProviderEvent[] | ((req: InternalRequest) => ProviderEvent[]);
export type FakeModel = string | { name: string; kind: ModelKind };

export class FakeProvider implements Provider {
  calls: InternalRequest[] = [];
  imageCalls: ImageRequest[] = [];
  imageScript: ProviderEvent[] = [];
  healthResult: HealthStatus = { ok: true, checkedAt: 0 };
  delayMs = 0;
  constructor(readonly id: string, private modelList: FakeModel[], public script: Script, readonly concurrencyLimit = 1) {}
  models(): ModelSpec[] {
    return this.modelList.map((m) => {
      const { name, kind } = typeof m === "string" ? { name: m, kind: "text" as const } : m;
      return { name, provider: this.id, cliModel: name, effortSuffix: false, kind };
    });
  }
  async *execute(req: InternalRequest, _m: ModelSpec, signal?: AbortSignal): AsyncIterable<ProviderEvent> {
    this.calls.push(req);
    const events = typeof this.script === "function" ? this.script(req) : this.script;
    yield* this.play(events, signal);
  }
  async *generateImage(req: ImageRequest, _m: ModelSpec, signal?: AbortSignal): AsyncIterable<ProviderEvent> {
    this.imageCalls.push(req);
    yield* this.play(this.imageScript, signal);
  }
  private async *play(events: ProviderEvent[], signal?: AbortSignal): AsyncIterable<ProviderEvent> {
    for (const ev of events) {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      if (signal?.aborted) return;
      yield ev;
    }
  }
  async health(): Promise<HealthStatus> { return { ...this.healthResult, checkedAt: Date.now() }; }
}
