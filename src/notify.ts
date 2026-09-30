import type { Config } from "./config.js";
import type { Logger } from "./log.js";
import type { CatalogChange } from "./providers/adapter.js";

/** Sends one message. Never throws and never waits: a notification is a side effect, not part of any request. */
export type Notify = (message: string) => void;

const TIMEOUT_MS = 10_000;

/**
 * The optional notification of `server.notify`: one plain-text POST per
 * message, prefixed with the installation's `name` when it has one, with a
 * `Title` header and, when `token_env` names a variable that is
 * set, `Authorization: Bearer <token>`. That is exactly what an ntfy topic
 * takes (docs/deploy.md §7.2), and any other endpoint that accepts a text POST
 * works the same way. Undefined when nothing is configured, so the caller has
 * nothing to check but that.
 *
 * The URL is never logged: on a public ntfy server the topic name is the
 * secret.
 */
export function createNotifier(cfg: Config["server"]["notify"], log: Logger, env: NodeJS.ProcessEnv = process.env): Notify | undefined {
  if (!cfg) return undefined;
  const token = cfg.token_env === undefined ? undefined : env[cfg.token_env];
  if (cfg.token_env !== undefined && !token) log.warn({ token_env: cfg.token_env }, "notify: the token variable is not set; sending without a token");
  return (message) => {
    const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8", title: "Capitoline" };
    if (token) headers.authorization = `Bearer ${token}`;
    fetch(cfg.url, { method: "POST", headers, body: cfg.name ? `${cfg.name}: ${message}` : message, signal: AbortSignal.timeout(TIMEOUT_MS) })
      .then((r) => { if (!r.ok) log.warn({ status: r.status }, "notify: the endpoint refused the message"); })
      .catch((e: unknown) => log.warn({ err: e instanceof Error ? e.message : String(e) }, "notify: sending failed"));
  };
}

/**
 * Where the configuration still names a model: the places a retirement
 * actually hurts, and the reason a notification is worth reading. A model
 * named nowhere can go quietly — it only leaves /v1/models.
 */
function usesOf(cfg: Config, provider: string, name: string): string[] {
  const uses: string[] = [];
  const p = cfg.providers[provider];
  if (p?.health_model === name) uses.push("health_model");
  if (p?.health_fallback.includes(name)) uses.push("health_fallback");
  if (p?.models[name]?.kind === "image") uses.push("image model");
  for (const [council, c] of Object.entries(cfg.council)) {
    if ([...c.seats, c.judge].some((s) => s.models.includes(name))) uses.push(`council ${council}`);
  }
  return uses;
}

/** One line a person can act on: what a listing added and what it took away, with where the configuration still uses the latter. */
export function describeCatalogChange(cfg: Config, provider: string, change: CatalogChange): string {
  const parts: string[] = [];
  if (change.added.length > 0) parts.push(`new: ${change.added.join(", ")}`);
  if (change.removed.length > 0) {
    parts.push(`no longer served: ${change.removed.map((name) => {
      const uses = usesOf(cfg, provider, name);
      return uses.length > 0 ? `${name} (used by ${uses.join(", ")})` : name;
    }).join(", ")}`);
  }
  return `${provider} models changed. ${parts.join("; ")}.`;
}
