import { describe, it, expect } from "vitest";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { createNotifier, describeAvailability, describeCatalogChange } from "../src/notify.js";

const cfg = loadConfig("config/capitoline.yaml");
const log = createLogger("t");

/** A local endpoint that records one POST, as an ntfy topic would receive it. */
async function endpoint(status = 200): Promise<{ url: string; received: Promise<{ headers: IncomingHttpHeaders; body: string }>; close: () => void }> {
  let resolve!: (v: { headers: IncomingHttpHeaders; body: string }) => void;
  const received = new Promise<{ headers: IncomingHttpHeaders; body: string }>((r) => { resolve = r; });
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString("utf8"); });
    req.on("end", () => { res.statusCode = status; res.end(); resolve({ headers: req.headers, body }); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/capitoline-test`, received, close: () => server.close() };
}

describe("notifications", () => {
  it("is nothing at all when server.notify is not configured", () => {
    expect(createNotifier(undefined, log)).toBeUndefined();
  });
  it("sends one plain-text POST with a title, and the bearer token read from the environment", async () => {
    const e = await endpoint();
    try {
      const notify = createNotifier({ url: e.url, token_env: "TEST_NOTIFY_TOKEN" }, log, { TEST_NOTIFY_TOKEN: "tk_secret" })!;
      notify("codex models changed. new: codex-gpt-7-nova.");
      const got = await e.received;
      expect(got.body).toBe("codex models changed. new: codex-gpt-7-nova.");
      expect(got.headers.title).toBe("Capitoline");
      expect(got.headers["content-type"]).toMatch(/^text\/plain/);
      expect(got.headers.authorization).toBe("Bearer tk_secret");
    } finally { e.close(); }
  });
  it("starts the message with the installation's name, when it has one", async () => {
    const e = await endpoint();
    try {
      createNotifier({ url: e.url, name: "Casa è qui" }, log, {})!("codex 0.159.2 is available");
      const got = await e.received;
      expect(got.body).toBe("Casa è qui: codex 0.159.2 is available");
      expect(got.headers.title).toBe("Capitoline");
    } finally { e.close(); }
  });
  it("sends without a token when none is configured or the variable is unset", async () => {
    const e = await endpoint();
    try {
      createNotifier({ url: e.url, token_env: "TEST_NOTIFY_TOKEN" }, log, {})!("x");
      expect((await e.received).headers.authorization).toBeUndefined();
    } finally { e.close(); }
  });
  it("never throws, whether the endpoint refuses the message or cannot be reached", async () => {
    const e = await endpoint(403);
    try {
      expect(() => createNotifier({ url: e.url }, log)!("x")).not.toThrow();
      await e.received;
    } finally { e.close(); }
    expect(() => createNotifier({ url: "http://127.0.0.1:1/nothing-here" }, log)!("x")).not.toThrow();
  });
  it("says what changed and, for a model taken away, where the configuration still uses it", () => {
    expect(describeCatalogChange(cfg, "codex", { added: ["codex-gpt-7-nova"], removed: ["codex-gpt-6-luna", "codex-gpt-5.6-terra", "codex-image"] }))
      .toBe("codex models changed. new: codex-gpt-7-nova; no longer served: codex-gpt-6-luna (used by health_model, council capitoline, council capitoline-fast), codex-gpt-5.6-terra (used by council capitoline, council capitoline-fast), codex-image (used by image model).");
    expect(describeCatalogChange(cfg, "antigravity", { added: [], removed: ["antigravity-gemini-3.6-flash-low"] }))
      .toBe("antigravity models changed. no longer served: antigravity-gemini-3.6-flash-low.");
  });
});

describe("the availability messages", () => {
  const at = Date.UTC(2026, 9, 3, 18, 49);
  it("says what paused, until when, and whose quota", () => {
    expect(describeAvailability(cfg, { kind: "paused", provider: "claude", scope: null, until: at }))
      .toBe("claude paused until 2026-10-03 18:49 UTC: the subscription's quota is used up.");
    expect(describeAvailability(cfg, { kind: "paused", provider: "codex", scope: "text:gpt-6.1-sol", until: at }))
      .toBe("codex-gpt-6.1-sol paused until 2026-10-03 18:49 UTC: its quota is used up.");
  });
  it("says what came back and after how long, and names an id no model declares as itself", () => {
    expect(describeAvailability(cfg, { kind: "resumed", provider: "codex", scope: "text:gpt-6.1-sol", pausedMs: 5 * 3600_000 + 12 * 60_000 }))
      .toBe("codex-gpt-6.1-sol available again, after 5h 12m.");
    expect(describeAvailability(cfg, { kind: "resumed", provider: "codex", scope: "text:gpt-9", pausedMs: 3 * 86_400_000 + 2 * 3600_000 }))
      .toBe("gpt-9 available again, after 3d 2h.");
  });
  it("says what to do when a provider signs out", () => {
    expect(describeAvailability(cfg, { kind: "signed_out", provider: "codex" })).toMatch(/^codex is signed out: log in again as runner/);
    expect(describeAvailability(cfg, { kind: "signed_in", provider: "codex" })).toBe("codex is signed in again.");
  });
});
