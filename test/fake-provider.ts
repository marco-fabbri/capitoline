import type { HealthStatus, ModelKind, ModelSpec, Provider } from "../src/providers/adapter.js";
import type { ImageRequest, InternalRequest, ProviderEvent } from "../src/core/types.js";

export type Script = ProviderEvent[] | ((req: InternalRequest) => ProviderEvent[]);
export type FakeModel = string | { name: string; kind: ModelKind };

export class FakeProvider implements Provider {
  calls: InternalRequest[] = [];
  imageCalls: ImageRequest[] = [];
  imageScript: ProviderEvent[] = [];
  healthResult: HealthStatus = { ok: true, checkedAt: 0 };
  /** How many times the probe actually ran: 0 is how a skipped check is observed. */
  healthCalls = 0;
  /** The model the probe runs, as a CLI provider reads it from health_model. */
  healthModel?: string;
  delayMs = 0;
  // Present only when the fake declares an image model, like a real provider
  // whose adapter cannot generate images: Core's "provider without generateImage"
  // branch needs a fake that lacks the method.
  generateImage?: (req: ImageRequest, m: ModelSpec, signal?: AbortSignal) => AsyncIterable<ProviderEvent>;
  constructor(readonly id: string, private modelList: FakeModel[], public script: Script, readonly concurrencyLimit = 1) {
    if (modelList.some((m) => typeof m !== "string" && m.kind === "image")) {
      this.generateImage = (req, _m, signal) => { this.imageCalls.push(req); return this.play(this.imageScript, signal); };
    }
  }
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
  private async *play(events: ProviderEvent[], signal?: AbortSignal): AsyncIterable<ProviderEvent> {
    for (const ev of events) {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      if (signal?.aborted) return;
      yield ev;
    }
  }
  async health(): Promise<HealthStatus> { this.healthCalls++; return { ...this.healthResult, checkedAt: Date.now() }; }
}
