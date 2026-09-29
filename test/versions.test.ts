import { describe, it, expect } from "vitest";
import { loadConfig, type ProviderConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";
import type { CaptureResult, Runner } from "../src/runner/runner.js";
import { UsageStore } from "../src/usage/store.js";
import { VersionWatch, compareVersions, latestVersion, parseVersion } from "../src/versions.js";

// No network and no CLI: the registry and the manifest answer from a stub, the
// installed version from a fake runner.
const shipped = loadConfig("config/capitoline.yaml");
const log = createLogger("t");

function fetchAnswering(versions: Record<string, string | Error>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const hit = Object.entries(versions).find(([k]) => url.includes(k));
    if (!hit) return new Response("not found", { status: 404 });
    if (hit[1] instanceof Error) throw hit[1];
    return new Response(JSON.stringify({ version: hit[1] }), { status: 200 });
  }) as typeof fetch;
}

function runnerSaying(stdout: Record<string, string>): Runner {
  return {
    run: () => { throw new Error("no CLI run expected"); },
    capture: async (spec): Promise<CaptureResult> => ({ exitCode: 0, stdout: Buffer.from(stdout[spec.binary] ?? ""), stderr: "", timedOut: false }),
    sweep: async () => [],
  } as Runner;
}

describe("reading versions", () => {
  it("takes the first x.y.z of what each CLI prints", () => {
    expect(parseVersion("2.1.284 (Claude Code)")).toBe("2.1.284");
    expect(parseVersion("codex-cli 0.159.0")).toBe("0.159.0");
    expect(parseVersion("1.2.13\n")).toBe("1.2.13");
    expect(parseVersion("no version here")).toBeNull();
  });
  it("compares numerically, not as text", () => {
    expect(compareVersions("0.159.0", "0.156.0")).toBeGreaterThan(0);
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("2.1.284", "2.1.284")).toBe(0);
  });
  it("reads the npm registry and the installer's manifest", async () => {
    const f = fetchAnswering({ "registry.npmjs.org/@openai%2Fcodex/latest": "0.159.0", "manifests/linux_amd64.json": "1.2.13" });
    expect(await latestVersion(shipped.providers.codex.version!.latest, f)).toBe("0.159.0");
    expect(await latestVersion(shipped.providers.antigravity.version!.latest, f)).toBe("1.2.13");
    await expect(latestVersion({ npm: "@nobody/nothing" }, f)).rejects.toThrow(/404/);
  });
});

describe("the version watch", () => {
  const providers = (): { id: string; cfg: ProviderConfig }[] =>
    Object.entries(shipped.providers).map(([id, cfg]) => ({ id, cfg: { ...cfg, binary: id } }));
  const installed = { claude: "2.1.284 (Claude Code)", codex: "codex-cli 0.156.0", antigravity: "1.2.13" };
  const latest = { "claude-code/latest": "2.1.284", "codex/latest": "0.159.0", "linux_amd64.json": "1.2.13" };

  it("says which CLI has a newer version, and announces it once, across a restart too", async () => {
    const store = new UsageStore(":memory:");
    const sent: string[] = [];
    const watch = new VersionWatch(providers(), runnerSaying(installed), store, log, (m) => sent.push(m), fetchAnswering(latest));
    await watch.check();
    expect(watch.states().codex).toMatchObject({ installed: "0.156.0", latest: "0.159.0", updateAvailable: true });
    expect(watch.states().claude).toMatchObject({ installed: "2.1.284", latest: "2.1.284", updateAvailable: false });
    expect(sent).toEqual(["codex 0.159.0 is available (installed 0.156.0). Update with: scripts/update-cli.sh codex"]);
    await watch.check();
    const restarted = new VersionWatch(providers(), runnerSaying(installed), store, log, (m) => sent.push(m), fetchAnswering(latest));
    await restarted.check();
    expect(sent).toHaveLength(1);
    // A newer one still is news again.
    const later = new VersionWatch(providers(), runnerSaying(installed), store, log, (m) => sent.push(m), fetchAnswering({ ...latest, "codex/latest": "0.160.0" }));
    await later.check();
    expect(sent.at(-1)).toMatch(/^codex 0\.160\.0 is available/);
  });

  it("records a source it cannot read and never throws", async () => {
    const watch = new VersionWatch(providers(), runnerSaying(installed), new UsageStore(":memory:"), log, undefined,
      fetchAnswering({ "codex/latest": new Error("network down") }));
    await expect(watch.check()).resolves.toBeUndefined();
    expect(watch.states().codex).toMatchObject({ installed: "0.156.0", latest: null, updateAvailable: false });
  });

  it("checks only the providers that declare a version source", async () => {
    const e2e = loadConfig("test/e2e.config.yaml");
    const watch = new VersionWatch(Object.entries(e2e.providers).map(([id, cfg]) => ({ id, cfg })), runnerSaying({}), new UsageStore(":memory:"), log, undefined, fetchAnswering({}));
    await watch.check();
    expect(watch.states()).toEqual({});
  });
});
