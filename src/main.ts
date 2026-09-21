import { loadConfig } from "./config.js";
import { Core } from "./core/core.js";
import { createLogger } from "./log.js";
import { createMcpHandler } from "./mcp/server.js";
import { buildProviders } from "./providers/index.js";
import { createRunner } from "./runner/runner.js";
import { createAccessMiddleware } from "./server/access.js";
import { createApp } from "./server/app.js";
import { UsageStore } from "./usage/store.js";

export async function start(configPath: string, overrides: { port?: number } = {}) {
  const log = createLogger("capitoline");
  const cfg = loadConfig(configPath);
  const runner = createRunner({ sandboxRoot: cfg.runner.sandbox_root, user: cfg.runner.user, killGraceMs: cfg.runner.kill_grace_s * 1000, log: log.child({ mod: "runner" }) });
  const providers = buildProviders(cfg, runner, log);
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
  const server = await new Promise<import("node:http").Server>((resolve) => { const s = app.listen(port, "127.0.0.1", () => resolve(s)); });
  const actualPort = (server.address() as { port: number }).port;
  log.info({ port: actualPort, providers: providers.map((p) => p.id) }, "listening");

  await core.checkHealth();
  const stopHealth = core.startHealthLoop(60 * 60 * 1000);

  const close = async () => {
    stopHealth();
    await new Promise<void>((r) => server.close(() => r()));
    usage.close();
  };
  return { close, port: actualPort };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const app = await start(process.env.CAPITOLINE_CONFIG ?? "config/capitoline.yaml");
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { void app.close().then(() => process.exit(0)); });
}
