import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { Core } from "./core/core.js";
import { createLogger } from "./log.js";
import { createMcpHandler } from "./mcp/server.js";
import { buildProviders } from "./providers/index.js";
import type { Provider } from "./providers/adapter.js";
import { createRunner } from "./runner/runner.js";
import { createAccessMiddleware } from "./server/access.js";
import { createApp } from "./server/app.js";
import { UsageStore } from "./usage/store.js";

/** How long close() waits for in-flight responses before destroying their connections. */
const SHUTDOWN_GRACE_MS = 5000;

export interface StartOverrides {
  /** Listening port, overriding server.port (0 = any free port). */
  port?: number;
  /** Providers in place of the ones built from the configuration. Tests only: it is the seam that lets a fake be observed without spawning a CLI. */
  providers?: Provider[];
  /** Grace before an in-flight connection is destroyed during close(); defaults to SHUTDOWN_GRACE_MS. */
  shutdownGraceMs?: number;
}

export async function start(configPath: string, overrides: StartOverrides = {}) {
  const log = createLogger("capitoline");
  const cfg = loadConfig(configPath);
  const providers = overrides.providers ?? buildProviders(cfg, createRunner({ sandboxRoot: cfg.runner.sandbox_root, user: cfg.runner.user, killGraceMs: cfg.runner.kill_grace_s * 1000, log: log.child({ mod: "runner" }) }), log);
  const usage = new UsageStore(cfg.usage.db_path);
  const budgets = Object.fromEntries(Object.entries(cfg.providers).map(([id, p]) => [id, { window5h: p.budget.window_5h_tokens, window7d: p.budget.window_7d_tokens }]));
  const imageQuotas = Object.fromEntries(Object.entries(cfg.providers).flatMap(([id, p]) => (p.image.quota_per_window === undefined ? [] : [[id, p.image.quota_per_window] as const])));
  const core = new Core(providers, usage, { maxWaitMs: cfg.server.queue.max_wait_s * 1000, budgets, imageQuotas, log: log.child({ mod: "core" }) });

  const access = cfg.server.access.team_domain
    ? createAccessMiddleware({ teamDomain: cfg.server.access.team_domain, audience: cfg.server.access.audience }, log.child({ mod: "access" }))
    : undefined;
  if (!access) log.warn("Cloudflare Access verification is disabled (server.access.team_domain is empty)");

  const app = createApp(core, { log: log.child({ mod: "http" }), access, mcp: createMcpHandler(core, log.child({ mod: "mcp" })) });
  const port = overrides.port ?? cfg.server.port;

  // Before the port exists, not after: while the first check is in flight every
  // model reports available, and a request arriving in that window would be
  // routed to a CLI nobody has verified (502 instead of 404/503).
  await core.checkHealth();

  // Without an error path an EADDRINUSE leaves this promise pending forever and
  // surfaces as an uncaught exception with no mention of the port. Both paths
  // are covered because express hands a listen error to the callback as well
  // (it registers it on "error" too); whichever settles the promise first wins.
  const server = await new Promise<Server>((resolve, reject) => {
    const fail = (e: Error) => reject(new Error(`cannot listen on 127.0.0.1:${port}: ${e.message}`, { cause: e }));
    const s = app.listen(port, "127.0.0.1", (e?: Error) => (e ? fail(e) : resolve(s)));
    s.once("error", fail);
  }).catch((e: unknown) => { usage.close(); throw e; });
  const actualPort = (server.address() as { port: number }).port;
  log.info({ port: actualPort, providers: providers.map((p) => p.id) }, "listening");

  const stopHealth = core.startHealthLoop(60 * 60 * 1000);

  const graceMs = overrides.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
  // Memoized, so a second signal (or a second caller) awaits the same shutdown
  // instead of closing an already-closed store, which node:sqlite rejects.
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= (async () => {
    stopHealth();
    // Idle keep-alive sockets go at once; the ones carrying a response get the
    // grace, after which they are destroyed too — an SSE stream with
    // timeout_s: 600 must not hold the shutdown open until SIGKILL.
    server.closeIdleConnections();
    const forced = setTimeout(() => server.closeAllConnections(), graceMs);
    forced.unref();
    await new Promise<void>((r) => server.close(() => r()));
    clearTimeout(forced);
    usage.close();
  })());
  return { close, port: actualPort };
}

// pathToFileURL, not string concatenation: a path holding "#" or "?" would be
// parsed as a fragment or a query, the comparison would fail and the service
// would exit 0 without ever starting.
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const app = await start(process.env.CAPITOLINE_CONFIG ?? "config/capitoline.yaml");
  let shuttingDown = false;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      if (shuttingDown) return;   // a second signal must not start a second shutdown
      shuttingDown = true;
      app.close().then(() => process.exit(0), (e: unknown) => { console.error(e); process.exit(1); });
    });
  }
}
