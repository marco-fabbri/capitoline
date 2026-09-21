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
    // Caught at startup rather than on the first image request: an image model
    // on a text-only CLI, or without a collect command, is a configuration
    // mistake, not a runtime condition. The collect check duplicates the config
    // schema's refinement on purpose: providers can be built from a hand-made
    // config that never went through parseConfig.
    const hasImage = Object.values(pc.models).some((m) => m.kind === "image");
    if (hasImage && !adapter.buildImageCommand) throw new Error(`provider "${id}" has image models but its adapter cannot generate images`);
    if (hasImage && !pc.image.collect) throw new Error(`provider "${id}" has image models but no image.collect command`);
    return new CliProvider(id, pc, adapter, runner, log.child({ provider: id }));
  });
}
