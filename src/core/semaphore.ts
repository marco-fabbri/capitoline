import { CapitolineError } from "./types.js";

export class Semaphore {
  private activeCount = 0;
  private queue: { resolve: (release: () => void) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
  constructor(private readonly limit: number) {}
  get active() { return this.activeCount; }
  get waiting() { return this.queue.length; }

  acquire(maxWaitMs: number): Promise<() => void> {
    if (this.activeCount < this.limit) { this.activeCount++; return Promise.resolve(this.release.bind(this)); }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: setTimeout(() => {
        this.queue = this.queue.filter((e) => e !== entry);
        reject(new CapitolineError("queue_full", `provider busy, waited ${maxWaitMs} ms`, Math.ceil(maxWaitMs / 1000)));
      }, maxWaitMs) };
      this.queue.push(entry);
    });
  }
  private release() {
    const next = this.queue.shift();
    if (next) { clearTimeout(next.timer); next.resolve(this.release.bind(this)); }
    else this.activeCount--;
  }
}
