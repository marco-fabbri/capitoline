import type { Config } from "./config.js";
import type { Logger } from "./log.js";
import type { CatalogChange } from "./providers/adapter.js";
import type { AvailabilityEvent } from "./core/core.js";

/**
 * How much a message asks of whoever receives it. `critical`: nothing works
 * for that provider until a person acts (a lost login). `warning`: it is held
 * back for a while and comes back by itself (a quota used up, a refusal with
 * no reset, a weekly quota running low). `info`: nothing is held back (a new
 * CLI version, a catalog that changed).
 */
export type NotifyLevel = "critical" | "warning" | "info";
/**
 * A message's level, and whether it closes a problem announced before ("signed
 * in again", "available again"). A closing message keeps the level of what it
 * closes, so the two are seen as a pair, and is sent at the endpoint's normal
 * priority: the level says what it is about, the priority how loudly the phone
 * rings, and good news is not an alarm.
 */
export interface NotifyOptions { level?: NotifyLevel; recovery?: boolean }

/**
 * Sends one message and resolves to whether it was delivered. Never throws,
 * and nothing that serves a request waits on it: a notification is a side
 * effect. A caller that records "announced" awaits it, and records only on true.
 */
export type Notify = (message: string, opts?: NotifyOptions) => Promise<boolean>;

// What an ntfy topic reads (docs/deploy.md §7.2): `Priority` sets how the
// phone signals it, and `Tags`, only with `icons: true`, puts an emoji before
// the title. `X-Capitoline-Level` carries the level itself, for any other
// endpoint that wants to route on it.
const PRIORITY: Record<NotifyLevel, string> = { critical: "urgent", warning: "high", info: "default" };
const TAG: Record<NotifyLevel, string> = { critical: "rotating_light", warning: "warning", info: "information_source" };

const TIMEOUT_MS = 10_000;
// Two more tries after the first, a little apart: a send that fails on the
// network or on the endpoint's side is usually a moment's trouble (a host with
// no IPv6 route to an endpoint that has an IPv6 address loses one now and
// then). A refusal of the message itself (another 4xx) is not tried again.
const RETRY_DELAYS_MS = [5_000, 30_000];

/**
 * The optional notification of `server.notify`: one plain-text POST per
 * message, prefixed with the installation's `name` when it has one, with a
 * `Title` header, the message's level in `Priority` and `X-Capitoline-Level`
 * (and `Tags`, with `icons: true`), and, when `token_env` names a variable that is
 * set, `Authorization: Bearer <token>`. That is exactly what an ntfy topic
 * takes (docs/deploy.md §7.2), and any other endpoint that accepts a text POST
 * works the same way. Undefined when nothing is configured, so the caller has
 * nothing to check but that.
 *
 * The URL is never logged: on a public ntfy server the topic name is the
 * secret.
 */
export function createNotifier(cfg: Config["server"]["notify"], log: Logger, env: NodeJS.ProcessEnv = process.env, retryDelaysMs: number[] = RETRY_DELAYS_MS): Notify | undefined {
  if (!cfg) return undefined;
  const token = cfg.token_env === undefined ? undefined : env[cfg.token_env];
  if (cfg.token_env !== undefined && !token) log.warn({ token_env: cfg.token_env }, "notify: the token variable is not set; sending without a token");
  return async (message, opts = {}) => {
    const level = opts.level ?? "info";
    const headers: Record<string, string> = {
      "content-type": "text/plain; charset=utf-8", title: "Capitoline",
      priority: opts.recovery ? PRIORITY.info : PRIORITY[level],
      "x-capitoline-level": level,
      ...(cfg.icons ? { tags: opts.recovery ? "white_check_mark" : TAG[level] } : {}),
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const body = cfg.name ? `${cfg.name}: ${message}` : message;
    for (let attempt = 0; ; attempt++) {
      let retry: boolean;
      try {
        const r = await fetch(cfg.url, { method: "POST", headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (r.ok) return true;
        retry = r.status === 429 || r.status >= 500;
        log.warn({ status: r.status, attempt: attempt + 1 }, "notify: the endpoint refused the message");
      } catch (e) {
        retry = true;
        log.warn({ err: e instanceof Error ? e.message : String(e), attempt: attempt + 1 }, "notify: sending failed");
      }
      if (!retry || attempt >= retryDelaysMs.length) return false;
      await new Promise((r) => setTimeout(r, retryDelaysMs[attempt]).unref());
    }
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

// What a scope is called here: the gateway names of that kind whose CLI id it
// is (an effort suffix included, as Antigravity's ids carry one), else the id
// itself. The kind matters: Antigravity draws with the same CLI model its text
// names answer with, and an image quota pauses only the image model, so a
// notice naming the text models too would report a pause that is not there.
function scopeName(cfg: Config, provider: string, scope: string | null): string {
  if (scope === null) return provider;
  const kind = scope.slice(0, scope.indexOf(":"));
  const cliId = scope.slice(scope.indexOf(":") + 1);
  const models = cfg.providers[provider]?.models ?? {};
  const names = Object.entries(models)
    .filter(([, m]) => (m.kind ?? "text") === kind && (cliId === m.cli_model || cliId.startsWith(`${m.cli_model}-`)))
    .map(([n]) => n);
  return names.length > 0 ? names.join(", ") : cliId;
}

const when = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const span = (ms: number): string => {
  const h = Math.floor(ms / 3600_000), d = Math.floor(h / 24);
  return d > 0 ? `${d}d ${h % 24}h` : `${h}h ${Math.floor((ms % 3600_000) / 60_000)}m`;
};

/** The level of an availability notice, and whether it closes one sent before. */
export function availabilityLevel(e: AvailabilityEvent): NotifyOptions {
  switch (e.kind) {
    case "signed_out": return { level: "critical" };
    case "signed_in": return { level: "critical", recovery: true };
    case "paused": case "refusing": case "quota_low": return { level: "warning" };
    case "resumed": return { level: "warning", recovery: true };
  }
}

/** One line for a quota pause starting or ending, or a provider signing out or back in. */
export function describeAvailability(cfg: Config, e: AvailabilityEvent): string {
  switch (e.kind) {
    case "paused": return `${scopeName(cfg, e.provider, e.scope)} paused until ${when(e.until)}: ${e.scope === null ? "the subscription's" : "its"} quota is used up.`;
    case "resumed": return `${scopeName(cfg, e.provider, e.scope)} available again, after ${span(e.pausedMs)}.`;
    case "refusing": return `${scopeName(cfg, e.provider, e.scope)} has been refused for ${span(e.refusedMs)}, and the provider gives no reset time.${e.weeklyResetAt !== undefined ? ` The subscription's weekly window resets ${when(e.weeklyResetAt)}, which may be when it returns.` : ""}`;
    case "signed_out": return `${e.provider} is signed out: log in again as runner (docs/deploy.md §6), then restart the service.`;
    case "signed_in": return `${e.provider} is signed in again.`;
    case "quota_low": return `${e.provider}: ${Math.round(e.remaining * 100)}% of the weekly quota of ${e.group} is left${e.resetsAt !== null ? `, and it refills ${when(e.resetsAt)}` : ""}.`;
  }
}
