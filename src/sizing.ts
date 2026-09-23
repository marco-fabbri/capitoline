import { readFileSync } from "node:fs";
import { totalmem } from "node:os";
import type { Config } from "./config.js";

// Whether the configured concurrency fits in the memory this host has
// (design §4.1). Every request is a whole CLI process, so the worst case is
// every provider running `concurrency` of them at once, each at the peak one
// run was measured at (`memory_mb`, per provider), on top of what the host
// uses with no CLI running (`server.memory_mb`). Past that the kernel kills
// processes, and a client sees a CLI that crashed.
//
// A warning at startup, never a refusal: the worst case is every slot of
// every provider busy at the same moment, which an operator may reasonably
// decide will not happen. What must not happen is not knowing.

export interface Sizing {
  /** MB the configuration can use at once: base + Σ concurrency × memory_mb. */
  requiredMb: number;
  /** MB the process can actually use. */
  availableMb: number;
  fits: boolean;
  /** Per provider: concurrency × memory_mb, so the log says where the memory goes. */
  providers: Record<string, number>;
}

export function sizing(cfg: Config, availableMb: number): Sizing {
  const providers = Object.fromEntries(Object.entries(cfg.providers).map(([id, p]) => [id, p.concurrency * p.memory_mb]));
  const requiredMb = cfg.server.memory_mb + Object.values(providers).reduce((a, b) => a + b, 0);
  return { requiredMb, availableMb, fits: requiredMb <= availableMb, providers };
}

/**
 * The memory limit that applies to this process, in MB: the smallest cgroup v2
 * `memory.max` on the way from this process's cgroup up to the root — a
 * systemd unit's MemoryMax, a container runtime's limit — or, when none is
 * set, the machine's total, which inside an LXC container is the container's
 * own allowance. A level with no limit reads "max".
 */
export function availableMemoryMb(cgroupLimits: string[], totalBytes: number): number {
  let mb = Math.floor(totalBytes / 2 ** 20);
  for (const raw of cgroupLimits) {
    const limit = raw.trim();
    if (/^\d+$/.test(limit)) mb = Math.min(mb, Math.floor(Number(limit) / 2 ** 20));
  }
  return mb;
}

/** The same, read from this host. Kept apart so the tests never read the real host. */
export function hostMemoryMb(): number {
  const limits: string[] = [];
  try {
    // cgroup v2 has one line, "0::<path>". Outside cgroup v2 there is no
    // memory.max to read and the machine's total is the answer.
    const line = readFileSync("/proc/self/cgroup", "utf8").split("\n").find((l) => l.startsWith("0::"));
    let dir = line ? line.slice(3).trim() : "";
    for (;;) {
      try {
        limits.push(readFileSync(`/sys/fs/cgroup${dir === "/" ? "" : dir}/memory.max`, "utf8"));
      } catch {
        // No memory controller at this level: nothing to add.
      }
      if (!dir || dir === "/") break;
      dir = dir.slice(0, dir.lastIndexOf("/")) || "/";
    }
  } catch {
    // Not Linux, or no /proc: the machine's total.
  }
  return availableMemoryMb(limits, totalmem());
}
