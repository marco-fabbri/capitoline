import type { Config } from "../config.js";
import type { Logger } from "../log.js";
import type { Runner } from "../runner/runner.js";
import type { Adapter, Provider } from "./adapter.js";
import { antigravityAdapter } from "./antigravity.js";
import { claudeAdapter } from "./claude.js";
import { CliProvider } from "./cli-provider.js";
import { codexAdapter } from "./codex.js";

export const ADAPTERS: Record<string, Adapter> = { claude: claudeAdapter, codex: codexAdapter, antigravity: antigravityAdapter };

export function buildProviders(cfg: Config, runner: Runner, log: Logger): Provider[] {
  return Object.entries(cfg.providers).map(([id, pc]) => {
    const adapter = ADAPTERS[id];
    if (!adapter) throw new Error(`no adapter for provider "${id}" (known: ${Object.keys(ADAPTERS).join(", ")})`);
    return new CliProvider(id, pc, adapter, runner, log.child({ provider: id }));
  });
}
