import type { ProviderConfig } from "./config.js";
import type { Logger } from "./log.js";
import type { Notify } from "./notify.js";
import type { Runner } from "./runner/runner.js";

/**
 * Whether each CLI has a newer version than the one installed — announced,
 * never installed (docs/update-clis.md: the CLIs are agents, and a new version
 * can switch on a tool; `scripts/update-cli.sh` is what a person runs next).
 *
 * The installed version is the CLI's own `--version`, run as the runner user
 * like any other run. The latest is read where each CLI is published: the npm
 * registry for Claude Code and Codex, the official installer's manifest for
 * Antigravity. Both are configuration (`providers.<id>.version`), because both
 * are facts about the CLI.
 */
export interface VersionState {
  installed: string | null;
  latest: string | null;
  checkedAt: number | null;
  updateAvailable: boolean;
}

/** Where the announced version is remembered, so a restart does not announce it again. */
export interface VersionStore {
  announcedVersion(provider: string): string | null;
  setAnnouncedVersion(provider: string, version: string, now?: number): void;
}

const SEMVER = /\d+\.\d+\.\d+/;
const INSTALLED_TIMEOUT_MS = 30_000;
const LATEST_TIMEOUT_MS = 10_000;

/** The first x.y.z in a text, or null. */
export function parseVersion(text: string): string | null {
  return SEMVER.exec(text)?.[0] ?? null;
}

/** Numeric comparison of two x.y.z versions: negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

type LatestSource = NonNullable<ProviderConfig["version"]>["latest"];

/** The latest published version. Throws when the source cannot be read. */
export async function latestVersion(source: LatestSource, fetchImpl: typeof fetch = fetch): Promise<string> {
  const url = "npm" in source ? `https://registry.npmjs.org/${source.npm.replace("/", "%2F")}/latest` : source.manifest;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(LATEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const body = (await res.json()) as { version?: unknown };
  const v = typeof body.version === "string" ? parseVersion(body.version) : null;
  if (!v) throw new Error(`${url} carries no version`);
  return v;
}

export class VersionWatch {
  private readonly state = new Map<string, VersionState>();
  private running: Promise<void> = Promise.resolve();

  constructor(
    private readonly providers: { id: string; cfg: ProviderConfig }[],
    private readonly runner: Runner,
    private readonly store: VersionStore,
    private readonly log: Logger,
    private readonly notify?: Notify,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Per provider that declares `version`; the others are absent. */
  states(): Record<string, VersionState> {
    return Object.fromEntries(this.state);
  }

  /** Resolves when no check is in flight; a shutdown waits on it before the store closes. */
  idle(): Promise<void> {
    return this.running;
  }

  check(): Promise<void> {
    this.running = this.run().catch((err: unknown) => this.log.error({ err }, "version check failed"));
    return this.running;
  }

  private async run(): Promise<void> {
    await Promise.all(this.providers.filter((p) => p.cfg.version).map(async ({ id, cfg }) => {
      const v = cfg.version!;
      let installed: string | null = null, latest: string | null = null;
      try {
        const r = await this.runner.capture({ binary: cfg.binary, args: v.args, timeoutMs: INSTALLED_TIMEOUT_MS, maxBytes: 64 * 1024 });
        installed = r.exitCode === 0 ? parseVersion(r.stdout.toString("utf8")) : null;
        if (installed === null) this.log.warn({ provider: id, exitCode: r.exitCode }, "installed version not readable");
      } catch (e) {
        this.log.warn({ provider: id, err: e instanceof Error ? e.message : String(e) }, "installed version not readable");
      }
      try {
        latest = await latestVersion(v.latest, this.fetchImpl);
      } catch (e) {
        this.log.warn({ provider: id, err: e instanceof Error ? e.message : String(e) }, "latest version not readable");
      }
      const updateAvailable = installed !== null && latest !== null && compareVersions(latest, installed) > 0;
      this.state.set(id, { installed, latest, checkedAt: this.now(), updateAvailable });
      if (!updateAvailable) return;
      this.log.info({ provider: id, installed, latest }, "a newer CLI version is available");
      // Nothing is announced without a channel to announce on: a version found
      // before server.notify was configured is still news once it is.
      if (!this.notify) return;
      // Once per version: a restart, or the next day's check, is not news.
      if (this.store.announcedVersion(id) === latest) return;
      // Recorded only once delivered: a send that failed, retries included,
      // leaves the version to the next check instead of losing it.
      if (await this.notify(`${id} ${latest} is available (installed ${installed}). Update with: scripts/update-cli.sh ${id}`, { level: "info" })) {
        this.store.setAnnouncedVersion(id, latest!, this.now());
      }
    }));
  }

  startLoop(intervalMs: number): () => void {
    const timer = setInterval(() => { void this.check(); }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}
