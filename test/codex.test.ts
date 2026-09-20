import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { codexAdapter } from "../src/providers/codex.js";
import { loadConfig } from "../src/config.js";
import { modelSpecs } from "../src/providers/adapter.js";
import type { ProviderEvent } from "../src/core/types.js";

const cfg = loadConfig("config/capitoline.yaml").providers.codex;
const astra = modelSpecs("codex", cfg).find((m) => m.name === "codex-gpt-6-astra")!;
async function* linesOf(path: string) { for (const l of readFileSync(path, "utf8").split("\n")) yield l; }
async function events(src: AsyncIterable<string>) { const out: ProviderEvent[] = []; for await (const e of codexAdapter.parse(src)) out.push(e); return out; }

describe("codex adapter", () => {
  it("builds the command with model, effort override, developer instructions and stdin prompt", () => {
    const c = codexAdapter.buildCommand(cfg, astra, {
      model: "codex-gpt-6-astra", stream: false, effort: "low",
      messages: [{ role: "system", text: 'Say "hi"\nthen stop' }, { role: "user", text: "q" }],
    });
    expect(c.args.slice(0, cfg.args.length)).toEqual(cfg.args);
    expect(c.args[c.args.indexOf("-m") + 1]).toBe("gpt-6-astra");
    expect(c.args).toContain('model_reasoning_effort="low"');
    expect(c.args).toContain('developer_instructions="Say \\"hi\\"\\nthen stop"');
    expect(c.args.at(-1)).toBe("-");
    expect(c.stdin).toBe("q");
  });
  it("parses exec --json output into one text event and done with usage", async () => {
    const ev = await events(linesOf("test/fixtures/codex/exec-json-locked.jsonl"));
    expect(ev).toEqual([{ type: "text", delta: "OK" }, { type: "done", usage: { input: 10566, output: 5 } }]);
  });
  it("maps turn.failed to a typed error", async () => {
    async function* l() { yield JSON.stringify({ type: "turn.failed", error: { message: "429 Too Many Requests" } }); }
    expect(await events(l())).toEqual([{ type: "error", kind: "rate_limited", detail: "429 Too Many Requests" }]);
  });
});
