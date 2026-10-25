import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";

// scripts/smoke.sh against a stub that answers the image requests in a given
// order. What is checked is the verdict of an image series, which decides
// whether scripts/update-cli.sh keeps an update or puts the old version back:
// an image that fails just before the quota refuses the next one is "not
// verified" (exit 3), not a regression (exit 1). On 2026-10-05 an update was
// rolled back for exactly that: the first image hung to its timeout against a
// quota about to end, and only the second was refused for it.
const have = (bin: string) => spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0;

type Shot = "ok" | "failed" | "quota";
let server: Server | undefined;
afterEach(() => { server?.close(); server = undefined; });

// What the stub serves as text models, which of them refuse, and which the
// caller names as the ones that decide the verdict (SMOKE_REQUIRED).
interface Text { served?: string[]; failing?: string[]; required?: string }

async function smoke(shots: Shot[], count: number, strict = false, text: Text = {}): Promise<{ status: number | null; stdout: string }> {
  const queue = [...shots];
  server = createServer((req, res) => {
    const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      if (req.url === "/health") return json(200, { models: [...(text.served ?? ["claude-haiku"]).map((name) => ({ name, kind: "text" })), { name: "antigravity-image", kind: "image" }] });
      if (req.url === "/v1/chat/completions") {
        const model = (JSON.parse(body) as { model: string }).model;
        if (text.failing?.includes(model)) return json(404, { error: { message: `model "${model}" unavailable: rate_limited`, code: "model_unavailable" } });
        return json(200, { choices: [{ message: { content: "ok" } }], usage: { total_tokens: 3 } });
      }
      const shot = queue.shift() ?? "failed";
      if (shot === "ok") return json(200, { capitoline: { bytes: 900_000, mime: "image/jpeg", width: 1376, height: 768 } });
      if (shot === "quota") return json(429, { error: { message: "provider rate limit reached", code: "rate_limited" } });
      return json(502, { error: { message: "the provider process failed", code: "cli_crashed" } });
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  // Not spawnSync: the stub runs in this process and would never answer.
  return new Promise((resolve) => {
    const child = spawn("bash", ["scripts/smoke.sh", `http://127.0.0.1:${port}`], {
      env: { ...process.env, CF_ACCESS_CLIENT_ID: "", CF_ACCESS_CLIENT_SECRET: "", CAPITOLINE_API_KEY: "", SMOKE_IMAGE: "1", SMOKE_IMAGE_STRICT: strict ? "1" : "0", SMOKE_IMAGE_COUNT: String(count), SMOKE_IMAGE_MODEL: "antigravity-image", SMOKE_REQUIRED: text.required ?? "" },
    });
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.on("close", (status) => resolve({ status, stdout }));
  });
}

describe.skipIf(!have("jq") || !have("curl"))("scripts/smoke.sh, the verdict of an image series", () => {
  it("passes when every image comes out", async () => {
    const r = await smoke(["ok", "ok", "ok"], 3);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout.match(/^antigravity-image\s+200/gm)).toHaveLength(3);
  });
  it("passes when the quota ends the series after images that came out", async () => {
    const r = await smoke(["ok", "quota"], 3);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/image quota exhausted, not a regression/);
  });
  it("says not verified, with its own exit code, when an image fails and the quota then refuses the next", async () => {
    const r = await smoke(["failed", "quota"], 3);
    expect(r.status, r.stdout).toBe(3);
    expect(r.stdout).toMatch(/not verified: the image quota ran out during the check/);
  });
  // The update script must know an image was really drawn: refused at once, nothing was.
  it("says not verified to a strict caller when the quota refuses before any image, and stays a pass by hand", async () => {
    const strict = await smoke(["quota"], 3, true);
    expect(strict.status, strict.stdout).toBe(3);
    expect(strict.stdout).toMatch(/not verified: the quota refused before any image was drawn/);
    expect((await smoke(["quota"], 3)).status).toBe(0);
    // One image drawn before the quota ends the series is a drawn image.
    expect((await smoke(["ok", "quota"], 3, true)).status).toBe(0);
  });
  it("fails when an image fails and no quota refusal explains it", async () => {
    expect((await smoke(["ok", "failed", "ok"], 3)).status).toBe(1);
    expect((await smoke(["failed"], 1)).status).toBe(1);
  });
});

// The text models: by hand every provider counts; scripts/update-cli.sh names
// the health model of the CLI it updated, so a provider whose weekly limit is
// used up does not hold back the update of another CLI for days.
describe.skipIf(!have("jq") || !have("curl"))("scripts/smoke.sh, which text models decide the verdict", () => {
  const served = ["claude-haiku", "codex-gpt-6-luna", "antigravity-gemini-flash"];
  it("fails on any provider's refusal when no model is named", async () => {
    const r = await smoke(["ok"], 1, false, { served, failing: ["codex-gpt-6-luna"] });
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).not.toMatch(/not counted/);
  });
  it("counts only the named model, and still calls and prints the others", async () => {
    const r = await smoke(["ok"], 1, false, { served, failing: ["codex-gpt-6-luna"], required: "claude-haiku" });
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/^claude-haiku\s+200/m);
    expect(r.stdout).toMatch(/^codex-gpt-6-luna\s+404 .*rate_limited \[not counted: not the model being checked\]$/m);
    expect(r.stdout).toMatch(/^antigravity-gemini-flash\s+200/m);
  });
  it("fails when the named model refuses", async () => {
    const r = await smoke(["ok"], 1, false, { served, failing: ["codex-gpt-6-luna"], required: "codex-gpt-6-luna" });
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).not.toMatch(/not counted/);
  });
  it("fails when the named model is not served, rather than passing an update nothing checked", async () => {
    const r = await smoke(["ok"], 1, false, { served: ["claude-haiku"], required: "antigravity-gemini-flash" });
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toMatch(/^antigravity-gemini-flash\s+not served by this gateway, and it is the model to check$/m);
    expect(r.stdout).toMatch(/^codex-gpt-6-luna\s+skipped \(not served by this gateway\)$/m);
  });
  it("tries a named model that no health_model names", async () => {
    const r = await smoke(["ok"], 1, false, { served: [...served, "claude-sonnet"], required: "claude-sonnet" });
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/^claude-sonnet\s+200/m);
  });
});
