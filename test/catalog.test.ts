import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { Core } from "../src/core/core.js";
import { createLogger } from "../src/log.js";
import { antigravityAdapter } from "../src/providers/antigravity.js";
import { codexAdapter } from "../src/providers/codex.js";
import { CliProvider } from "../src/providers/cli-provider.js";
import type { CatalogChange, ListedModel } from "../src/providers/adapter.js";
import type { CaptureResult, Runner } from "../src/runner/runner.js";
import { seat } from "../src/council/seating.js";
import { UsageStore } from "../src/usage/store.js";

// The daily catalog (docs/deploy.md §7.2), against the shipped configuration
// and the real listings captured on the host on 2026-09-29.
const cfg = loadConfig("config/capitoline.yaml");
const CODEX_LISTING = readFileSync("test/fixtures/codex/debug-models.json", "utf8");
const AGY_LISTING = readFileSync("test/fixtures/antigravity/models.txt", "utf8");
const log = createLogger("t");

/** A runner whose listing command answers what the test says; nothing else may run. */
function runnerAnswering(answer: () => Partial<CaptureResult>): Runner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: () => { throw new Error("no CLI run expected in a catalog test"); },
    capture: async (spec) => { calls.push([spec.binary, ...spec.args]); return { exitCode: 0, stdout: Buffer.from(""), stderr: "", timedOut: false, ...answer() }; },
    sweep: async () => {},
  } as Runner & { calls: string[][] };
}

const codex = (answer: () => Partial<CaptureResult> = () => ({ stdout: Buffer.from(CODEX_LISTING) })) =>
  new CliProvider("codex", cfg.providers.codex, codexAdapter, runnerAnswering(answer), log);
const antigravity = (answer: () => Partial<CaptureResult> = () => ({ stdout: Buffer.from(AGY_LISTING) })) =>
  new CliProvider("antigravity", cfg.providers.antigravity, antigravityAdapter, runnerAnswering(answer), log);

const codexListed = (): ListedModel[] => codexAdapter.listModels!(CODEX_LISTING, cfg.providers.codex);
const agyListed = (): ListedModel[] => antigravityAdapter.listModels!(AGY_LISTING, cfg.providers.antigravity);

describe("reading the listings", () => {
  it("reads `codex debug models`: slugs, what the CLI hides, and the levels each serves", () => {
    const listed = codexListed();
    expect(listed.map((m) => m.id)).toEqual(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-reserve", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "codex-auto-review"]);
    expect(listed.filter((m) => m.hidden).map((m) => m.id)).toEqual(["gpt-reserve", "codex-auto-review"]);
    expect(listed.find((m) => m.id === "gpt-6-luna")!.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(listed.find((m) => m.id === "gpt-6-astra")!.efforts).toContain("ultra");
  });
  it("refuses a Codex output that is not a catalog, rather than reading it as an empty one", () => {
    expect(() => codexAdapter.listModels!("not json", cfg.providers.codex)).toThrow();
    expect(() => codexAdapter.listModels!(`{"models": null}`, cfg.providers.codex)).toThrow(/no models array/);
  });
  it("reads `agy models`, one id per tab-separated line, and skips anything else", () => {
    expect(agyListed()).toHaveLength(14);
    expect(antigravityAdapter.listModels!(`Fetching available models...\ngemini-9-flash-high\tGemini 9 Flash (High)\n\n`, cfg.providers.antigravity)).toEqual([{ id: "gemini-9-flash-high" }]);
  });
});

describe("the catalog of one provider", () => {
  it("changes nothing when the CLI lists exactly what is declared, minus what is excluded", () => {
    const p = codex();
    expect(p.applyListing(codexListed())).toEqual({ added: [], removed: [] });
    expect(p.catalogNames()).toEqual({ discovered: [], retired: [] });
    expect(antigravity().applyListing(agyListed())).toEqual({ added: [], removed: [] });
  });
  it("serves a new listed model under the door's prefix, with the levels the CLI gives it", () => {
    const p = codex();
    const change = p.applyListing([...codexListed(), { id: "gpt-7-nova", efforts: ["low", "high"] }, { id: "gpt-7-internal", hidden: true }]);
    expect(change).toEqual({ added: ["codex-gpt-7-nova"], removed: [] });
    expect(p.models().find((m) => m.name === "codex-gpt-7-nova")).toMatchObject({ cliModel: "gpt-7-nova", efforts: ["low", "high"], kind: "text", effortSuffix: false });
    // Hidden, and so never offered on its own; excluded, and so never added back.
    expect(p.models().map((m) => m.name)).not.toContain("codex-gpt-7-internal");
    expect(p.models().map((m) => m.name)).not.toContain("codex-gpt-5.5");
  });
  it("retires every declared model whose id is gone, and moves the health probe to its fallback", () => {
    const p = codex();
    expect(p.healthModel).toBe("codex-gpt-6-luna");
    const change = p.applyListing(codexListed().filter((m) => m.id !== "gpt-6-luna"));
    // codex-image runs its agent on gpt-6-luna, so it goes too.
    expect(change).toEqual({ added: [], removed: ["codex-gpt-6-luna", "codex-image"] });
    expect(p.isRetired(p.models().find((m) => m.name === "codex-gpt-6-luna")!)).toBe(true);
    expect(p.healthModel).toBe("codex-gpt-5.6-luna");
    expect(p.healthCliId).toBe("gpt-5.6-luna");
    // Listed again: back, and the probe returns to health_model.
    expect(p.applyListing(codexListed())).toEqual({ added: ["codex-gpt-6-luna", "codex-image"], removed: [] });
    expect(p.healthModel).toBe("codex-gpt-6-luna");
  });
  it("keeps a model whose effort is part of its id while any one of its levels is listed", () => {
    const p = antigravity();
    const withoutHigh = agyListed().filter((m) => m.id !== "gemini-3.8-flash-high");
    expect(p.applyListing(withoutHigh).removed).toEqual(["antigravity-gemini-flash-high"]);
    const withoutFlash = agyListed().filter((m) => !m.id.startsWith("gemini-3.8-flash"));
    expect(p.applyListing(withoutFlash).removed).toEqual(expect.arrayContaining(["antigravity-gemini-flash", "antigravity-gemini-flash-low", "antigravity-gemini-flash-medium", "antigravity-image"]));
    expect(p.healthModel).toBe("antigravity-gemini-3.7-flash");
  });
  it("a hidden model that is still listed is served, not retired", () => {
    const p = codex();
    p.applyListing(codexListed());
    expect(p.isRetired(p.models().find((m) => m.name === "codex-gpt-reserve")!)).toBe(false);
  });
  it("runs the CLI's own listing command and refuses a failed, empty or unreadable answer", async () => {
    const r = runnerAnswering(() => ({ stdout: Buffer.from(CODEX_LISTING) }));
    const p = new CliProvider("codex", cfg.providers.codex, codexAdapter, r, log);
    expect(await p.listModels()).toHaveLength(9);
    expect(r.calls).toEqual([["codex", "debug", "models"]]);
    await expect(codex(() => ({ exitCode: 1, stderr: "boom" })).listModels()).rejects.toThrow(/exited with 1/);
    await expect(codex(() => ({ timedOut: true })).listModels()).rejects.toThrow(/timed out/);
    await expect(antigravity(() => ({ stdout: Buffer.from("Fetching available models...\n") })).listModels()).rejects.toThrow(/empty/);
  });
});

describe("the catalog in Core", () => {
  function make(opts: { usage?: UsageStore; answer?: () => Partial<CaptureResult> } = {}) {
    const usage = opts.usage ?? new UsageStore(":memory:");
    const changes: [string, CatalogChange][] = [];
    const p = codex(opts.answer);
    const core = new Core([p], usage, { maxWaitMs: 200, budgets: {}, log, onCatalogChange: (id, c) => changes.push([id, c]) });
    return { core, usage, changes, p };
  }
  const withNova = () => ({ stdout: Buffer.from(JSON.stringify({ models: [...JSON.parse(CODEX_LISTING).models.filter((m: { slug: string }) => m.slug !== "gpt-6-luna"), { slug: "gpt-7-nova", visibility: "list", supported_reasoning_levels: [{ effort: "low" }] }] })) });

  it("serves what a listing adds, retires what it drops, and says so once", async () => {
    const { core, changes } = make({ answer: withNova });
    await core.checkCatalog();
    const byName = new Map(core.listModels().map((m) => [m.name, m]));
    expect(byName.get("codex-gpt-7-nova")).toMatchObject({ available: true, provider: "codex" });
    expect(byName.get("codex-gpt-6-luna")).toMatchObject({ available: false, reason: "retired" });
    expect(changes).toEqual([["codex", { added: ["codex-gpt-7-nova"], removed: ["codex-gpt-6-luna", "codex-image"] }]]);
    await expect((async () => { for await (const _ of core.execute({ model: "codex-gpt-6-luna", stream: false, messages: [{ role: "user", text: "q" }] }, { source: "http" })) { /* drain */ } })())
      .rejects.toMatchObject({ kind: "model_unavailable", message: expect.stringMatching(/retired/) });
    expect(core.providerStates()[0].catalog).toMatchObject({ ok: true, discovered: ["codex-gpt-7-nova"], retired: ["codex-gpt-6-luna", "codex-image"], healthModel: "codex-gpt-5.6-luna" });
    // A second, identical listing is no news.
    await core.checkCatalog();
    expect(changes).toHaveLength(1);
  });
  it("keeps the catalog as it was when a listing fails", async () => {
    let fail = false;
    const { core, changes } = make({ answer: () => (fail ? { exitCode: 1, stderr: "catalog fetch failed" } : withNova()) });
    await core.checkCatalog();
    fail = true;
    await core.checkCatalog();
    expect(changes).toHaveLength(1);
    expect(core.listModels().find((m) => m.name === "codex-gpt-7-nova")?.available).toBe(true);
    expect(core.providerStates()[0].catalog).toMatchObject({ ok: false, discovered: ["codex-gpt-7-nova"] });
  });
  it("restores the last catalog at startup without announcing it, and a restart is not news", async () => {
    const usage = new UsageStore(":memory:");
    await make({ usage, answer: withNova }).core.checkCatalog();
    const second = make({ usage, answer: withNova });
    second.core.restoreCatalog();
    expect(second.core.listModels().find((m) => m.name === "codex-gpt-7-nova")?.available).toBe(true);
    await second.core.checkCatalog();
    expect(second.changes).toEqual([]);
  });
  it("lets a council seat step past a retired model", async () => {
    const { core } = make({ answer: withNova });
    await core.checkCatalog();
    const seated = seat([{ family: "openai", models: ["codex-gpt-6-luna", "codex-gpt-6-sol"] }], core.listModels());
    expect(seated.members.map((m) => m.model)).toEqual(["codex-gpt-6-sol"]);
  });
  it("leaves a provider that lists nothing exactly as declared", () => {
    const claude = new CliProvider("claude", cfg.providers.claude, codexAdapter, runnerAnswering(() => ({})), log);
    expect(claude.discovers).toBe(false);
    const core = new Core([claude], new UsageStore(":memory:"), { maxWaitMs: 200, budgets: {}, log });
    expect(core.providerStates()[0].catalog).toBeNull();
  });
});
