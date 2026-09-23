import type { Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { loadConfigWithOverlay } from "./config.js";
import { Core } from "./core/core.js";
import { Council } from "./council/council.js";
import { createLogger, type Logger } from "./log.js";
import { createMcpHandler } from "./mcp/server.js";
import { buildProviders } from "./providers/index.js";
import type { Provider } from "./providers/adapter.js";
import { createRunner } from "./runner/runner.js";
import { hostMemoryMb, sizing } from "./sizing.js";
import { createAccessMiddleware } from "./server/access.js";
import { createApp } from "./server/app.js";
import { UsageStore } from "./usage/store.js";

/** How long close() waits for in-flight responses before destroying their connections. */
export const SHUTDOWN_GRACE_MS = 5000;

export interface StartOverrides {
  /** Listening port, overriding server.port (0 = any free port). */
  port?: number;
  /** Providers in place of the ones built from the configuration. Tests only: it is the seam that lets a fake be observed without spawning a CLI. */
  providers?: Provider[];
  /** Grace before an in-flight connection is destroyed during close(); defaults to SHUTDOWN_GRACE_MS. */
  shutdownGraceMs?: number;
  /**
   * Host overlay merged over the configuration file, defaulting to
   * `CAPITOLINE_OVERLAY`. The default is read here rather than at the call
   * site below so that the deployed path — the environment variable the
   * systemd unit sets — is the one the tests exercise.
   */
  overlayPath?: string;
  /** Destination for the startup log. Tests only: the one seam that lets the `configuration loaded` line be read back. */
  logDest?: Parameters<typeof createLogger>[1];
}

/**
 * Binds the port, rejecting instead of hanging on an error.
 *
 * Without an error path an EADDRINUSE leaves the promise pending forever and
 * surfaces as an uncaught exception with no mention of the port. Both paths are
 * covered because express hands a listen error to the callback as well (it
 * registers one on "error" too); whichever settles the promise first wins.
 * Once it has settled the startup listener is swapped for one that logs: a
 * later "error" (EMFILE on accept, for one) would otherwise reject an
 * already-settled promise, i.e. disappear without a trace.
 */
function listen(app: ReturnType<typeof createApp>, port: number, log: Logger): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const fail = (e: Error) => reject(new Error(`cannot listen on 127.0.0.1:${port}: ${e.message}`, { cause: e }));
    const s = app.listen(port, "127.0.0.1", (e?: Error) => {
      if (e) return fail(e);
      s.off("error", fail);
      s.on("error", (err: unknown) => log.error({ err }, "http server error"));
      resolve(s);
    });
    s.once("error", fail);
  });
}

export async function start(configPath: string, overrides: StartOverrides = {}) {
  const log = createLogger("capitoline", overrides.logDest);
  // `|| undefined`, not `??`: an environment variable set to nothing is not
  // unset. `Environment=CAPITOLINE_OVERLAY=` in a unit, or an empty export in a
  // shell, is how one turns the overlay off, and the empty string would
  // otherwise be read as a path and fail with an ENOENT naming no file.
  const overlayPath = overrides.overlayPath ?? (process.env.CAPITOLINE_OVERLAY || undefined);
  const { config: cfg, overlayKeys } = loadConfigWithOverlay(configPath, overlayPath);
  // Which files the configuration came from, and which keys the host's overlay
  // set — the keys only. `server.access.audience` is not a secret, but a log
  // line that prints the overlay's values is a habit this one does not start.
  log.info({ config: configPath, overlay: overlayPath ?? null, overlayKeys }, "configuration loaded");
  // Whether every slot of every provider busy at once fits in this host's
  // memory (design §4.1). Figures, not values from the overlay: the same
  // arithmetic an operator would do with the configuration in hand.
  const size = sizing(cfg, hostMemoryMb());
  if (size.fits) log.info({ requiredMb: size.requiredMb, availableMb: size.availableMb }, "sizing: the configured concurrency fits in memory");
  else log.warn({ requiredMb: size.requiredMb, availableMb: size.availableMb, providers: size.providers }, "sizing: the configured concurrency does not fit in memory; with every slot busy the kernel would kill CLI processes (design §4.1)");
  // Named and always built, even when providers are injected: it is the one
  // instance that knows sandbox_root, and the startup sweep of stale run-*
  // directories hangs off it. Constructing it touches nothing.
  const runner = createRunner({ sandboxRoot: cfg.runner.sandbox_root, user: cfg.runner.user, killGraceMs: cfg.runner.kill_grace_s * 1000, log: log.child({ mod: "runner" }) });
  const providers = overrides.providers ?? buildProviders(cfg, runner, log);
  // Deliberately not logged, although knowing which database is open would
  // help: the startup line prints which files were loaded and never what is
  // in them (see the overlay log above, and the test that pins it). The
  // signal is there already and costs no value — `overlayKeys` carries
  // `usage.db_path` exactly when the overlay set it, so a service that
  // started without the overlay says so by that key's absence, which is the
  // case a split history would come from.
  const usage = new UsageStore(cfg.usage.db_path);
  const budgets = Object.fromEntries(Object.entries(cfg.providers).map(([id, p]) => [id, { window5h: p.budget.window_5h_tokens, window7d: p.budget.window_7d_tokens }]));
  const imageQuotas = Object.fromEntries(Object.entries(cfg.providers).flatMap(([id, p]) => (p.image.quota_per_window === undefined ? [] : [[id, p.image.quota_per_window] as const])));
  const core = new Core(providers, usage, { maxWaitMs: cfg.server.queue.max_wait_s * 1000, budgets, imageQuotas, log: log.child({ mod: "core" }) });

  // One Council per configured council, registered as a virtual model: a client
  // asks for `capitoline` in `model` exactly as it asks for `claude-opus`, and
  // Core routes it here instead of to a provider. The council is handed the
  // core itself — every member call goes back through Core.execute(), so the
  // queue, the pauses, the health state and the usage rows apply to a member
  // exactly as to a direct request (design §12, plan constraints).
  for (const [name, councilCfg] of Object.entries(cfg.council)) {
    const council = new Council(name, councilCfg, core, log.child({ mod: "council", council: name }));
    core.registerVirtual(name, (question, ctx) => council.deliberate(question, ctx), (models) => council.seatable(models));
    log.info({ council: name, seats: councilCfg.seats.map((s) => s.family), judge: councilCfg.judge.family }, "council registered");
  }

  const access = cfg.server.access.team_domain
    ? createAccessMiddleware({ teamDomain: cfg.server.access.team_domain, audience: cfg.server.access.audience }, log.child({ mod: "access" }))
    : undefined;
  if (!access) log.warn("Cloudflare Access verification is disabled (server.access.team_domain is empty)");

  // The port is bound first and the requests are gated, never the other way
  // round: a real health check spawns the CLI with a deadline of a minute, and
  // one sick CLI (a keyring still locked after a reboot, a CLI mid-update) must
  // not keep 127.0.0.1 refusing connections for that long — the tunnel would
  // answer connection-refused for all three providers instead of serving the
  // two healthy ones. Until the first round of checks lands every model still
  // reports available, so the app answers 503 + Retry-After to everything but
  // /health (see createApp).
  let ready = false;
  const app = createApp(core, { log: log.child({ mod: "http" }), access, mcp: createMcpHandler(core, log.child({ mod: "mcp" })), ready: () => ready, callerNames: cfg.server.access.callers });
  const port = overrides.port ?? cfg.server.port;

  // One owner for the sqlite handle: whatever fails between here and the end of
  // the first health check, the store is closed and nothing is left listening.
  let server: Server;
  try {
    server = await listen(app, port, log);
  } catch (e) { usage.close(); throw e; }
  const actualPort = (server.address() as { port: number }).port;
  log.info({ port: actualPort, providers: providers.map((p) => p.id) }, "listening");
  try {
    // Before the first check, after the port is up: the run-* directories of a
    // previous process are removed once. Not before listen(), because the port
    // must come up regardless of how slow the disk is; inside this try, because
    // whatever fails here must still leave nothing listening and no open store.
    // The threshold is the longest a run of this configuration can take: the
    // longest timeout any model may run for, plus twice kill_grace_s — once for
    // SIGTERM → SIGKILL, once for the stdio pipes to reach EOF afterwards. It
    // bounds the runs this gateway starts, not a directory an orphaned CLI of
    // an earlier instance may still be writing into.
    const longestTimeoutS = Math.max(...Object.values(cfg.providers).flatMap((p) => [p.timeout_s, ...Object.values(p.models).map((m) => m.timeout_s ?? p.timeout_s)]));
    await runner.sweep((longestTimeoutS + 2 * cfg.runner.kill_grace_s) * 1000);

    // Before the first check, so a model a previous process saw refused is not
    // probed and offered again while its pause still stands. Inside this try,
    // like the sweep: a store that fails to answer must leave nothing listening
    // and no open database behind.
    core.restorePauses();

    await core.checkHealth();
    ready = true;
  } catch (e) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    usage.close();
    throw e;
  }

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
    // A check started before stopHealth() writes its row when it lands, and
    // node:sqlite throws on a closed database. Bounded by the same grace: a
    // probe can hang for as long as the CLI deadline and a shutdown has to stay
    // predictable for systemd (the losing case is one lost health row).
    await Promise.race([core.idle(), delay(graceMs, undefined, { ref: false })]);
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
