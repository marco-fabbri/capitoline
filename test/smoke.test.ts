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

async function smoke(shots: Shot[], count: number): Promise<{ status: number | null; stdout: string }> {
  const queue = [...shots];
  server = createServer((req, res) => {
    const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    req.resume();
    req.on("end", () => {
      if (req.url === "/health") return json(200, { models: [{ name: "claude-haiku", kind: "text" }, { name: "antigravity-image", kind: "image" }] });
      if (req.url === "/v1/chat/completions") return json(200, { choices: [{ message: { content: "ok" } }], usage: { total_tokens: 3 } });
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
      env: { ...process.env, CF_ACCESS_CLIENT_ID: "", CF_ACCESS_CLIENT_SECRET: "", CAPITOLINE_API_KEY: "", SMOKE_IMAGE: "1", SMOKE_IMAGE_COUNT: String(count), SMOKE_IMAGE_MODEL: "antigravity-image" },
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
  it("fails when an image fails and no quota refusal explains it", async () => {
    expect((await smoke(["ok", "failed", "ok"], 3)).status).toBe(1);
    expect((await smoke(["failed"], 1)).status).toBe(1);
  });
});
