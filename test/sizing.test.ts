import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { availableMemoryMb, sizing } from "../src/sizing.js";

// Design §4.1. The host's own memory is never read here: the limits and the
// total are handed in, as hostMemoryMb() would read them on the host.
const MB = 2 ** 20;

describe("sizing", () => {
  const cfg = loadConfig("config/capitoline.yaml");

  it("adds every provider's slots at their measured peak to what the idle host uses", () => {
    const s = sizing(cfg, 8192);
    // 150 + 10 × 250 (claude) + 10 × 150 (codex) + 10 × 250 (antigravity):
    // the worked example of §4.1, recomputed from the shipped file.
    expect(s.providers).toEqual({ claude: 2500, codex: 1500, antigravity: 2500 });
    expect(s.requiredMb).toBe(6650);
    expect(s.fits).toBe(true);
  });

  it("says when the configuration does not fit, as on a 4 GB host at ten runs per CLI", () => {
    expect(sizing(cfg, 4096)).toMatchObject({ requiredMb: 6650, availableMb: 4096, fits: false });
  });

  it("counts the CLIs alone when the idle host's share is not declared", () => {
    const undeclared = { ...cfg, server: { ...cfg.server, memory_mb: 0 } };
    expect(sizing(undeclared, 8192).requiredMb).toBe(6500);
  });
});

describe("the memory the process can use", () => {
  it("is the machine's total when no cgroup sets a limit", () => {
    expect(availableMemoryMb([], 4096 * MB)).toBe(4096);
    // "max" is how cgroup v2 writes "no limit at this level".
    expect(availableMemoryMb(["max\n", "max\n"], 4096 * MB)).toBe(4096);
  });

  it("is the smallest limit on the way to the root, when one is lower than the total", () => {
    expect(availableMemoryMb(["max\n", `${2048 * MB}\n`, `${3072 * MB}\n`], 8192 * MB)).toBe(2048);
  });

  it("is never more than the machine has, whatever a cgroup allows", () => {
    expect(availableMemoryMb([`${16384 * MB}\n`], 8192 * MB)).toBe(8192);
  });
});
