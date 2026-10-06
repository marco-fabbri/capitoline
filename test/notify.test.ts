import { describe, it, expect } from "vitest";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { availabilityLevel, createNotifier, describeAvailability, describeCatalogChange } from "../src/notify.js";

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
  // A lost login and a new CLI version looked the same until the text was
  // read: the level travels as ntfy's priority and tags, and as a header of
  // its own for any other endpoint.
  it("sends the level, as an ntfy topic reads it and in a header of its own, info when none is given", async () => {
    const sent = async (opts?: Parameters<NonNullable<ReturnType<typeof createNotifier>>>[1], icons = true) => {
      const e = await endpoint();
      try { createNotifier({ url: e.url, icons }, log, {})!("x", opts); return (await e.received).headers; } finally { e.close(); }
    };
    expect(await sent({ level: "critical" })).toMatchObject({ priority: "urgent", tags: "rotating_light", "x-capitoline-level": "critical" });
    expect(await sent({ level: "warning" })).toMatchObject({ priority: "high", tags: "warning", "x-capitoline-level": "warning" });
    expect(await sent()).toMatchObject({ priority: "default", tags: "information_source", "x-capitoline-level": "info" });
    // Closing a problem: its level, a check mark, and no alarm.
    expect(await sent({ level: "critical", recovery: true })).toMatchObject({ priority: "default", tags: "white_check_mark", "x-capitoline-level": "critical" });
    // The icons are asked for: without the flag the level is still sent, with no emoji.
    const plain = await sent({ level: "critical" }, false);
    expect(plain).toMatchObject({ priority: "urgent", "x-capitoline-level": "critical" });
    expect(plain.tags).toBeUndefined();
    const e = await endpoint();
    try { createNotifier({ url: e.url }, log, {})!("x", { level: "warning" }); expect((await e.received).headers.tags).toBeUndefined(); } finally { e.close(); }
  });
  it("gives each availability notice its level, and a closing one the level of what it closes", () => {
    const at = Date.UTC(2026, 9, 6, 12);
    expect(availabilityLevel({ kind: "signed_out", provider: "claude" })).toEqual({ level: "critical" });
    expect(availabilityLevel({ kind: "signed_in", provider: "claude" })).toEqual({ level: "critical", recovery: true });
    expect(availabilityLevel({ kind: "paused", provider: "claude", scope: null, until: at })).toEqual({ level: "warning" });
    expect(availabilityLevel({ kind: "refusing", provider: "claude", scope: null, refusedMs: 3600_000 })).toEqual({ level: "warning" });
    expect(availabilityLevel({ kind: "quota_low", provider: "antigravity", group: "G", remaining: 0.1, resetsAt: null })).toEqual({ level: "warning" });
    expect(availabilityLevel({ kind: "resumed", provider: "claude", scope: null, pausedMs: 3600_000 })).toEqual({ level: "warning", recovery: true });
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
  it("tries again after a failure on the endpoint's side, and says whether the message got through", async () => {
    let calls = 0;
    const server = createServer((req, res) => { req.resume(); req.on("end", () => { calls++; res.statusCode = calls === 1 ? 503 : 200; res.end(); }); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/t`;
    try {
      expect(await createNotifier({ url }, log, {}, [0, 0])!("x")).toBe(true);
      expect(calls).toBe(2);
    } finally { server.close(); }
    expect(await createNotifier({ url: "http://127.0.0.1:1/nothing-here" }, log, {}, [0, 0])!("x")).toBe(false);
  });
  it("does not try again when the message itself is refused", async () => {
    let calls = 0;
    const server = createServer((req, res) => { req.resume(); req.on("end", () => { calls++; res.statusCode = 403; res.end(); }); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      expect(await createNotifier({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/t` }, log, {}, [0, 0])!("x")).toBe(false);
      expect(calls).toBe(1);
    } finally { server.close(); }
  });
  it("never throws, whether the endpoint refuses the message or cannot be reached", async () => {
    const e = await endpoint(403);
    try {
      expect(() => createNotifier({ url: e.url }, log)!("x")).not.toThrow();
      await e.received;
    } finally { e.close(); }
    expect(() => createNotifier({ url: "http://127.0.0.1:1/nothing-here" }, log, {}, [])!("x")).not.toThrow();
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
    expect(describeAvailability(cfg, { kind: "quota_low", provider: "antigravity", group: "Gemini Models", remaining: 0.236, resetsAt: null }))
      .toBe("antigravity: 24% of the weekly quota of Gemini Models is left.");
    expect(describeAvailability(cfg, { kind: "quota_low", provider: "antigravity", group: "Gemini Models", remaining: 0.05, resetsAt: at }))
      .toMatch(/^antigravity: 5% of the weekly quota of Gemini Models is left, and it refills /);
    expect(describeAvailability(cfg, { kind: "paused", provider: "claude", scope: null, until: at }))
      .toBe("claude paused until 2026-10-03 18:49 UTC: the subscription's quota is used up.");
    expect(describeAvailability(cfg, { kind: "paused", provider: "codex", scope: "text:gpt-6.1-sol", until: at }))
      .toBe("codex-gpt-6.1-sol paused until 2026-10-03 18:49 UTC: its quota is used up.");
  });
  it("names only the models of the paused kind, when text and images share a CLI model", () => {
    // 2026-10-01: Antigravity's image quota ran out and the notice named two text models too.
    expect(describeAvailability(cfg, { kind: "paused", provider: "antigravity", scope: "image:gemini-3.8-flash-low", until: at }))
      .toBe("antigravity-image paused until 2026-10-03 18:49 UTC: its quota is used up.");
    expect(describeAvailability(cfg, { kind: "paused", provider: "antigravity", scope: "text:gemini-3.8-flash-low", until: at }))
      .not.toContain("antigravity-image");
  });
  it("says what came back and after how long, and names an id no model declares as itself", () => {
    expect(describeAvailability(cfg, { kind: "resumed", provider: "codex", scope: "text:gpt-6.1-sol", pausedMs: 5 * 3600_000 + 12 * 60_000 }))
      .toBe("codex-gpt-6.1-sol available again, after 5h 12m.");
    expect(describeAvailability(cfg, { kind: "resumed", provider: "codex", scope: "text:gpt-9", pausedMs: 3 * 86_400_000 + 2 * 3600_000 }))
      .toBe("gpt-9 available again, after 3d 2h.");
  });
  it("says a model has been refused for a while with no reset given, and offers the weekly window's", () => {
    expect(describeAvailability(cfg, { kind: "refusing", provider: "codex", scope: "text:gpt-6.1-sol", refusedMs: 65 * 60_000 }))
      .toBe("codex-gpt-6.1-sol has been refused for 1h 5m, and the provider gives no reset time.");
    expect(describeAvailability(cfg, { kind: "refusing", provider: "codex", scope: null, refusedMs: 2 * 3600_000, weeklyResetAt: at }))
      .toBe("codex has been refused for 2h 0m, and the provider gives no reset time. The subscription's weekly window resets 2026-10-03 18:49 UTC, which may be when it returns.");
  });
  it("says what to do when a provider signs out", () => {
    expect(describeAvailability(cfg, { kind: "signed_out", provider: "codex" })).toMatch(/^codex is signed out: log in again as runner/);
    expect(describeAvailability(cfg, { kind: "signed_in", provider: "codex" })).toBe("codex is signed in again.");
  });
});
