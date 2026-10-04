import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { ModelKind } from "../config.js";
import { CapitolineError, type ErrorKind, type RateLimitWindow } from "../core/types.js";
import type { ListedModel } from "../providers/adapter.js";

export interface CallRecord {
  provider: string; model: string; inputTokens: number; outputTokens: number; durationMs: number;
  /** The part of inputTokens read from the provider's cache; 0 when the CLI did not say, and for every row written before it was kept. */
  cachedInputTokens?: number;
  /** What the CLI said the call cost at API prices; null when it said nothing. */
  costUsd?: number | null;
  outcome: "ok" | ErrorKind | "aborted"; source: "http" | "mcp" | "health"; ts?: number;
  /** What the model produces; defaults to text (health probes and every pre-image row). */
  kind?: ModelKind;
  /** Who asked, as the Access identity names them; null when nothing identified them. */
  caller?: string | null;
  /**
   * The council deliberation this call belongs to, null for a request a client
   * made directly. One question is nine calls under six different models
   * (spec 12.7), and this is what sums them back into one question instead of
   * a guess over a time window.
   */
  deliberation?: string | null;
  /** The council that deliberated (`capitoline`, `capitoline-fast`), beside its id: which one a question was put to. */
  council?: string | null;
  /**
   * The dated id of the model that actually answered — `claude-opus-5-5-…`
   * for a row whose `model` is `claude-opus`. Null when the CLI said nothing,
   * which is the honest value for every Codex and Antigravity row and for
   * every row written before 2026-09-23: only Claude's names are aliases that
   * move, so only Claude reports this.
   */
  cliModelId?: string | null;
}
export interface Totals { calls: number; inputTokens: number; outputTokens: number }
/** What one caller spent in a window. `caller` is null for the calls nothing identified. */
export interface CallerUsage { caller: string | null; calls: number; inputTokens: number; outputTokens: number }
export interface UsageDayRow { day: string; caller: string | null; provider: string; model: string; outcome: string; calls: number; inputTokens: number; outputTokens: number }
/** What a caller spent on a model since some instant: the rows a cost is worked out from (src/usage/costs.ts). */
export interface SpendRow {
  caller: string | null; provider: string; model: string; kind: string; calls: number; ok: number; inputTokens: number; cachedInputTokens: number; outputTokens: number;
  /** The calls whose cost the CLI reported itself, and the sum of what it reported. */
  reportedCalls: number; reportedCost: number;
  /** The first and the last of these calls. */
  firstAt: number; lastAt: number;
  /** The others, which only a price list can cost. */
  unreported: { ok: number; inputTokens: number; cachedInputTokens: number; outputTokens: number };
}
export interface DeliberationSummary { id: string; council: string | null; startedAt: number; endedAt: number; calls: number; ok: number; inputTokens: number; outputTokens: number; caller: string | null }
export interface DeliberationCall { ts: number; provider: string; model: string; cliModelId: string | null; outcome: string; durationMs: number; inputTokens: number; outputTokens: number }
/**
 * Which real model served a gateway name, and when. More than one row for the
 * same `model` is the thing worth seeing: the name did not change and the
 * model under it did — `claude-opus` was Opus 5 until 2026-09-22 and Opus 5.5
 * after it, with nothing in the configuration touched.
 */
export interface ModelIdentity { model: string; cliModelId: string; calls: number; firstAt: number; lastAt: number }
export type WindowName = "five_hour" | "seven_day";
/** Image generations counted in a rolling window: `windowStartedAt` is null while the window is empty. */
export interface ImageWindow { used: number; windowStartedAt: number | null }
/** A pause held across restarts. `model` is null for a pause that covers the whole provider. */
export interface PauseRow { provider: string; model: string | null; until: number; strikes: number; announcedAt: number | null }
/** A key as the admin API lists it: never the hash, never the key. */
export interface ApiKeyInfo { name: string; createdAt: number; createdBy: string | null; revokedAt: number | null; lastUsedAt: number | null }
/** Lower case, digits and dashes, 2-64 characters: a name that is also safe in a header, a log line and a URL. */
export const KEY_NAME = /^[a-z0-9][a-z0-9-]{1,63}$/;
/** An OAuth token as stored, without the token: its hash is the row's key. */
export interface OAuthTokenRow { kind: "access" | "refresh"; keyName: string; clientId: string; resource: string | null; scopes: string[]; expiresAt: number }
const hashKey = (key: string): string => createHash("sha256").update(key).digest("hex");

/** The five-hour window: the provider's short image quota and the budget windows share it. */
export const H5 = 5 * 3600_000;

export class UsageStore {
  private readonly db: DatabaseSync;
  // Every request writes a row and reads the budget windows, so the SQL is
  // compiled once here instead of on every call. They are prepared after the
  // schema is settled (the `kind` migration below), because a statement naming
  // a column the table does not have yet fails to compile.
  private readonly stmts: {
    record: StatementSync; imageWindow: StatementSync; totals: StatementSync; setWindow: StatementSync; windows: StatementSync;
    callers: StatementSync; setPause: StatementSync; clearPause: StatementSync; prunePauses: StatementSync; pauses: StatementSync; announcePause: StatementSync; expiredAnnounced: StatementSync;
    deliberation: StatementSync; identities: StatementSync;
    insertKey: StatementSync; keyByHash: StatementSync; touchKey: StatementSync; revokeKey: StatementSync; keys: StatementSync; liveKeys: StatementSync;
    liveKey: StatementSync; saveOAuthClient: StatementSync; oauthClient: StatementSync; insertOAuthToken: StatementSync; oauthToken: StatementSync;
    deleteOAuthToken: StatementSync; deleteOAuthTokensOfKey: StatementSync; pruneOAuthTokens: StatementSync;
    nameCaller: StatementSync; callerNames: StatementSync;
    saveCatalog: StatementSync; catalogs: StatementSync;
    announced: StatementSync; setAnnounced: StatementSync;
    usageByDay: StatementSync; spend: StatementSync; deliberations: StatementSync; deliberationCalls: StatementSync;
  };
  private closed = false;
  constructor(path: string) {
    // A fresh deployment points db_path at a directory that does not exist yet
    // (/var/lib/capitoline/usage.sqlite): sqlite would only say "unable to open
    // database file". `:memory:` and an empty path are sqlite's own names for a
    // database with no file, and have no parent directory to create.
    if (path !== ":memory:" && path !== "") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
        outcome TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text', caller TEXT, deliberation TEXT);
      CREATE INDEX IF NOT EXISTS calls_provider_ts ON calls(provider, ts);
      -- The per-caller breakdown filters on ts alone, which the composite
      -- index above cannot serve: without this one it is a full scan of a
      -- table nothing ever prunes. IF NOT EXISTS also upgrades the deployed
      -- database in place.
      CREATE INDEX IF NOT EXISTS calls_ts ON calls(ts);
      CREATE TABLE IF NOT EXISTS rate_windows (
        provider TEXT NOT NULL, window TEXT NOT NULL, utilization REAL NOT NULL, resets_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, PRIMARY KEY (provider, window));
      -- The pauses a rate limit installs, so a refusal that reopens in days is
      -- known again after a restart instead of being rediscovered by a real
      -- call. The model column is null for a pause covering the whole
      -- provider; IF NOT EXISTS is also what upgrades the deployed database.
      CREATE TABLE IF NOT EXISTS pauses (
        provider TEXT NOT NULL, model TEXT, until INTEGER NOT NULL, strikes INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, PRIMARY KEY (provider, model));
      -- One row per scope, enforced rather than merely respected. The PRIMARY
      -- KEY above cannot do it: sqlite admits NULLs inside the primary key of
      -- a rowid table and holds two of them distinct, so nothing would stop a
      -- second provider-wide row from being inserted, and the restore would
      -- then pick whichever came first. Folding the NULL to '' gives the
      -- scope a value the index can compare, and gives setPause() a conflict
      -- target so one atomic upsert replaces the delete-then-insert pair.
      CREATE UNIQUE INDEX IF NOT EXISTS pauses_scope ON pauses(provider, ifnull(model, ''));
      -- The gateway's own identity (design §4, "two identities"): a key it
      -- issued, kept as the sha256 of the key and never the key, which is
      -- shown once at creation. A revoked key stays, so the usage rows that
      -- carry its name keep their meaning; revoked_at is what refuses it.
      CREATE TABLE IF NOT EXISTS api_keys (
        name TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, created_by TEXT,
        revoked_at INTEGER, last_used_at INTEGER);
      -- What to call a caller Cloudflare identifies by a client id: the
      -- runtime half of server.access.callers, written by the admin API, read
      -- by /v1/usage at presentation time exactly as the configured map is.
      CREATE TABLE IF NOT EXISTS callers (id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at INTEGER NOT NULL);
      -- OAuth for the MCP clients that cannot hold a key (src/server/oauth.ts).
      -- The clients that registered themselves (RFC 7591), as the metadata the
      -- registration returned, so a restart does not make them register again.
      CREATE TABLE IF NOT EXISTS oauth_clients (client_id TEXT PRIMARY KEY, metadata TEXT NOT NULL, created_at INTEGER NOT NULL);
      -- The tokens issued to them, as the sha256 of the token and never the
      -- token, each bound to the gateway key whose owner signed in: the key is
      -- the identity, the token only stands in for it, and dies with it.
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        hash TEXT PRIMARY KEY, kind TEXT NOT NULL, key_name TEXT NOT NULL, client_id TEXT NOT NULL,
        resource TEXT, scopes TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS oauth_tokens_key ON oauth_tokens(key_name);
      -- The last listing each provider's CLI gave of its models (the daily
      -- catalog, docs/deploy.md §7.2), as the JSON the adapter read. Restored
      -- at startup, so a restart neither drops the discovered models until the
      -- next listing nor reports every one of them as new.
      CREATE TABLE IF NOT EXISTS catalog (provider TEXT PRIMARY KEY, listing TEXT NOT NULL, checked_at INTEGER NOT NULL);
      -- The last CLI version announced as available, per provider, so the
      -- daily check announces each new version once and a restart not at all.
      CREATE TABLE IF NOT EXISTS versions (provider TEXT PRIMARY KEY, announced TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `);
    // A database written before image models existed has no `kind` column, and
    // CREATE TABLE IF NOT EXISTS leaves it alone: add it here, with the same
    // default, so an upgrade keeps its history instead of losing it.
    const columns = new Set((this.db.prepare(`PRAGMA table_info(calls)`).all() as { name: string }[]).map((c) => c.name));
    if (!columns.has("kind")) this.db.exec(`ALTER TABLE calls ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'`);
    // The same for the caller of a call, added after the deployed database was
    // written. Nullable and with no default: "nobody said who" is a real
    // state — the rows written before attribution existed, the health probes,
    // and every call served with Access verification disabled — and NULL is
    // its name, distinct from any string a token could carry.
    if (!columns.has("caller")) this.db.exec(`ALTER TABLE calls ADD COLUMN caller TEXT`);
    // And the same for the deliberation a call belonged to, added with the
    // council. Nullable for the same reason: every row written before the
    // council existed, and every direct request after it, belongs to no
    // deliberation, and NULL is that state's name.
    if (!columns.has("deliberation")) this.db.exec(`ALTER TABLE calls ADD COLUMN deliberation TEXT`);
    // And the council's name, added 2026-10-04: the id says which calls are one
    // question, not which council it was put to. NULL for the rows before.
    if (!columns.has("council")) this.db.exec(`ALTER TABLE calls ADD COLUMN council TEXT`);
    // Inside input_tokens, not beside it: 0 for the rows written before.
    if (!columns.has("cost_usd")) this.db.exec(`ALTER TABLE calls ADD COLUMN cost_usd REAL`);
    if (!columns.has("cached_input_tokens")) this.db.exec(`ALTER TABLE calls ADD COLUMN cached_input_tokens INTEGER NOT NULL DEFAULT 0`);
    // And the dated model id, added 2026-09-23 when `opus` moved from Opus 5
    // to Opus 5.5 with nothing in the history saying which one any measurement
    // had used. Nullable with no default, for the same reason `caller` is:
    // "the CLI said nothing" is a real state, and it is what every Codex row,
    // every Antigravity row and every row older than this column will hold.
    if (!columns.has("cli_model_id")) this.db.exec(`ALTER TABLE calls ADD COLUMN cli_model_id TEXT`);
    // When a pause's start was announced (server.notify), added 2026-09-30:
    // what lets a restart announce the end of a pause it did not see start,
    // and not announce the start twice. NULL for a pause nobody was told of.
    const pauseColumns = new Set((this.db.prepare(`PRAGMA table_info(pauses)`).all() as { name: string }[]).map((c) => c.name));
    if (!pauseColumns.has("announced_at")) this.db.exec(`ALTER TABLE pauses ADD COLUMN announced_at INTEGER`);

    this.stmts = {
      record: this.db.prepare(`INSERT INTO calls (ts, provider, model, input_tokens, output_tokens, duration_ms, outcome, source, kind, caller, deliberation, cli_model_id, council, cached_input_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      imageWindow: this.db.prepare(`SELECT COUNT(*) AS used, MIN(ts) AS started FROM calls WHERE provider = ? AND kind = 'image' AND outcome = 'ok' AND ts > ?`),
      totals: this.db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o FROM calls WHERE provider = ? AND ts > ?`),
      setWindow: this.db.prepare(`INSERT INTO rate_windows (provider, window, utilization, resets_at, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(provider, window) DO UPDATE SET utilization = excluded.utilization, resets_at = excluded.resets_at, updated_at = excluded.updated_at`),
      windows: this.db.prepare(`SELECT window, utilization, resets_at, updated_at FROM rate_windows WHERE provider = ?`),
      // The gateway's own health probes are excluded: they are not a caller,
      // and they outnumber the real traffic (45 of the first 56 calls on the
      // host), so they would bury the breakdown under one huge null row.
      callers: this.db.prepare(`SELECT caller, COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o
        FROM calls WHERE ts > ? AND source <> 'health' GROUP BY caller ORDER BY calls DESC, caller`),
      // The admin views (/v1/admin/usage, /deliberations): days in UTC, the
      // gateway's own probes left out as everywhere else.
      usageByDay: this.db.prepare(`SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS day, caller, provider, model, outcome,
        COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o
        FROM calls WHERE ts > ? AND source <> 'health' GROUP BY day, caller, provider, model, outcome ORDER BY day DESC, calls DESC`),
      spend: this.db.prepare(`SELECT caller, provider, model, kind, COUNT(*) AS calls, SUM(outcome = 'ok') AS ok,
        COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(cached_input_tokens),0) AS c, COALESCE(SUM(output_tokens),0) AS o,
        COUNT(cost_usd) AS rn, COALESCE(SUM(cost_usd),0) AS rc, MIN(ts) AS first, MAX(ts) AS last,
        COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN outcome = 'ok' END),0) AS uok, COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN input_tokens END),0) AS ui,
        COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN cached_input_tokens END),0) AS uc, COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN output_tokens END),0) AS uo
        FROM calls WHERE ts > ? AND source <> 'health' GROUP BY caller, provider, model, kind ORDER BY provider, model, caller`),
      deliberations: this.db.prepare(`SELECT deliberation AS id, MIN(ts) AS started, MAX(ts) AS ended, COUNT(*) AS calls,
        SUM(outcome = 'ok') AS ok, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o, MAX(caller) AS caller, MAX(council) AS council
        FROM calls WHERE deliberation IS NOT NULL GROUP BY deliberation ORDER BY started DESC LIMIT ?`),
      deliberationCalls: this.db.prepare(`SELECT ts, provider, model, cli_model_id, outcome, duration_ms, input_tokens, output_tokens
        FROM calls WHERE deliberation = ? ORDER BY ts, id`),
      // One statement, so the row is never absent between two of them: a
      // delete followed by an insert is two transactions in WAL, and a SIGKILL
      // in the gap (systemd Restart=always, an OOM kill) would lose a five-day
      // pause — the very state this table exists to keep. The conflict target
      // is the expression the unique index above builds, not (provider,
      // model), because ON CONFLICT(provider, model) never fires for a
      // provider-wide pause: its model is NULL and no two NULLs conflict.
      // `model IS ?` in the delete below for the same reason: `IS` is the one
      // comparison that matches a NULL, so it serves both scopes.
      setPause: this.db.prepare(`INSERT INTO pauses (provider, model, until, strikes, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(provider, ifnull(model, '')) DO UPDATE SET until = excluded.until, strikes = excluded.strikes, updated_at = excluded.updated_at`),
      clearPause: this.db.prepare(`DELETE FROM pauses WHERE provider = ? AND model IS ?`),
      prunePauses: this.db.prepare(`DELETE FROM pauses WHERE until <= ?`),
      pauses: this.db.prepare(`SELECT provider, model, until, strikes, announced_at FROM pauses WHERE until > ? ORDER BY provider, model`),
      announcePause: this.db.prepare(`UPDATE pauses SET announced_at = ? WHERE provider = ? AND model IS ?`),
      expiredAnnounced: this.db.prepare(`SELECT provider, model, until, strikes, announced_at FROM pauses WHERE until <= ? AND announced_at IS NOT NULL ORDER BY provider, model`),
      // No index and no time bound: an identifier is asked about right after
      // the deliberation that minted it, one question at a time, and an index
      // on a column that is NULL for almost every row would cost every insert
      // for a read nothing does in a loop.
      deliberation: this.db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o FROM calls WHERE deliberation = ?`),
      // Rows the CLI identified, only: a null would say "Codex, as always"
      // and add a line to every listing for it. `calls_ts` covers the bound.
      identities: this.db.prepare(`SELECT model, cli_model_id AS id, COUNT(*) AS calls, MIN(ts) AS first_at, MAX(ts) AS last_at
        FROM calls WHERE ts > ? AND cli_model_id IS NOT NULL GROUP BY model, cli_model_id ORDER BY model, last_at`),
      insertKey: this.db.prepare(`INSERT INTO api_keys (name, hash, created_at, created_by) VALUES (?, ?, ?, ?)`),
      keyByHash: this.db.prepare(`SELECT name, revoked_at FROM api_keys WHERE hash = ?`),
      touchKey: this.db.prepare(`UPDATE api_keys SET last_used_at = ? WHERE name = ?`),
      revokeKey: this.db.prepare(`UPDATE api_keys SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL`),
      keys: this.db.prepare(`SELECT name, created_at, created_by, revoked_at, last_used_at FROM api_keys ORDER BY created_at, name`),
      liveKeys: this.db.prepare(`SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL`),
      liveKey: this.db.prepare(`SELECT 1 AS live FROM api_keys WHERE name = ? AND revoked_at IS NULL`),
      saveOAuthClient: this.db.prepare(`INSERT INTO oauth_clients (client_id, metadata, created_at) VALUES (?, ?, ?)`),
      oauthClient: this.db.prepare(`SELECT metadata FROM oauth_clients WHERE client_id = ?`),
      insertOAuthToken: this.db.prepare(`INSERT INTO oauth_tokens (hash, kind, key_name, client_id, resource, scopes, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
      oauthToken: this.db.prepare(`SELECT kind, key_name, client_id, resource, scopes, expires_at FROM oauth_tokens WHERE hash = ?`),
      deleteOAuthToken: this.db.prepare(`DELETE FROM oauth_tokens WHERE hash = ?`),
      deleteOAuthTokensOfKey: this.db.prepare(`DELETE FROM oauth_tokens WHERE key_name = ?`),
      pruneOAuthTokens: this.db.prepare(`DELETE FROM oauth_tokens WHERE expires_at <= ?`),
      nameCaller: this.db.prepare(`INSERT INTO callers (id, name, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`),
      callerNames: this.db.prepare(`SELECT id, name FROM callers ORDER BY id`),
      saveCatalog: this.db.prepare(`INSERT INTO catalog (provider, listing, checked_at) VALUES (?, ?, ?) ON CONFLICT(provider) DO UPDATE SET listing = excluded.listing, checked_at = excluded.checked_at`),
      catalogs: this.db.prepare(`SELECT provider, listing, checked_at FROM catalog ORDER BY provider`),
      announced: this.db.prepare(`SELECT announced FROM versions WHERE provider = ?`),
      setAnnounced: this.db.prepare(`INSERT INTO versions (provider, announced, updated_at) VALUES (?, ?, ?) ON CONFLICT(provider) DO UPDATE SET announced = excluded.announced, updated_at = excluded.updated_at`),
    };
  }
  record(c: CallRecord): void {
    this.stmts.record.run(c.ts ?? Date.now(), c.provider, c.model, c.inputTokens, c.outputTokens, c.durationMs, c.outcome, c.source, c.kind ?? "text", c.caller ?? null, c.deliberation ?? null, c.cliModelId ?? null, c.council ?? null, c.cachedInputTokens ?? 0, c.costUsd ?? null);
  }

  // What one deliberation spent, across every model that served it: the other
  // half of spec 12.7, and the only reading the identifier exists for.
  deliberationTotals(id: string): Totals {
    const row = this.stmts.deliberation.get(id) as { calls: number; i: number; o: number };
    return { calls: Number(row.calls), inputTokens: Number(row.i), outputTokens: Number(row.o) };
  }

  // Who spent the window, busiest first. One row per distinct caller, with the
  // unidentified calls gathered under null — sqlite groups NULLs together,
  // which is exactly the reading wanted: "not attributed" is one bucket.
  callers(sinceMs: number, now = Date.now()): CallerUsage[] {
    const rows = this.stmts.callers.all(now - sinceMs) as { caller: string | null; calls: number; i: number; o: number }[];
    return rows.map((r) => ({ caller: r.caller, calls: Number(r.calls), inputTokens: Number(r.i), outputTokens: Number(r.o) }));
  }

  /** Calls per UTC day, caller, model and outcome since `sinceMs` ago, newest day first. */
  usageByDay(sinceMs: number, now = Date.now()): UsageDayRow[] {
    const rows = this.stmts.usageByDay.all(now - sinceMs) as { day: string; caller: string | null; provider: string; model: string; outcome: string; calls: number; i: number; o: number }[];
    return rows.map((r) => ({ day: r.day, caller: r.caller, provider: r.provider, model: r.model, outcome: r.outcome, calls: Number(r.calls), inputTokens: Number(r.i), outputTokens: Number(r.o) }));
  }

  /** Calls and tokens per caller and model since `sinceMs` ago, the gateway's own probes left out. */
  spend(sinceMs: number, now = Date.now()): SpendRow[] {
    const rows = this.stmts.spend.all(now - sinceMs) as { caller: string | null; provider: string; model: string; kind: string; calls: number; ok: number; i: number; c: number; o: number; rn: number; rc: number; first: number; last: number; uok: number; ui: number; uc: number; uo: number }[];
    return rows.map((r) => ({ caller: r.caller, provider: r.provider, model: r.model, kind: r.kind, calls: Number(r.calls), ok: Number(r.ok), inputTokens: Number(r.i), cachedInputTokens: Number(r.c), outputTokens: Number(r.o),
      reportedCalls: Number(r.rn), reportedCost: Number(r.rc), firstAt: Number(r.first), lastAt: Number(r.last), unreported: { ok: Number(r.uok), inputTokens: Number(r.ui), cachedInputTokens: Number(r.uc), outputTokens: Number(r.uo) } }));
  }

  /** The latest deliberations by id, newest first, each summed over its calls. */
  deliberations(limit: number): DeliberationSummary[] {
    const rows = this.stmts.deliberations.all(limit) as { id: string; started: number; ended: number; calls: number; ok: number; i: number; o: number; caller: string | null; council: string | null }[];
    return rows.map((r) => ({ id: r.id, council: r.council, startedAt: Number(r.started), endedAt: Number(r.ended), calls: Number(r.calls), ok: Number(r.ok), inputTokens: Number(r.i), outputTokens: Number(r.o), caller: r.caller }));
  }

  /** One deliberation's calls, in order. Empty for an id nothing was recorded under. */
  deliberationCalls(id: string): DeliberationCall[] {
    const rows = this.stmts.deliberationCalls.all(id) as { ts: number; provider: string; model: string; cli_model_id: string | null; outcome: string; duration_ms: number; input_tokens: number; output_tokens: number }[];
    return rows.map((r) => ({ ts: Number(r.ts), provider: r.provider, model: r.model, cliModelId: r.cli_model_id, outcome: r.outcome, durationMs: Number(r.duration_ms), inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens) }));
  }

  /**
   * Which real models served each gateway name in the window, oldest last seen
   * first within a name. Rows the CLI did not identify are left out rather than
   * gathered under a null: only Claude's names are aliases that move, so a null
   * row would say "Codex, as always" for every Codex model in the table.
   */
  modelIdentities(sinceMs: number, now = Date.now()): ModelIdentity[] {
    const rows = this.stmts.identities.all(now - sinceMs) as { model: string; id: string; calls: number; first_at: number; last_at: number }[];
    return rows.map((r) => ({ model: r.model, cliModelId: r.id, calls: Number(r.calls), firstAt: Number(r.first_at), lastAt: Number(r.last_at) }));
  }

  // The image quota is counted in generations, not tokens, and only a
  // generation that produced an image spends it: a 429 or a crash costs
  // nothing. The window is rolling, so it "opens" at the oldest call still
  // inside it — that is what a client needs to know when the next one frees up.
  // The count is a lower bound, never an exact reading: it sees the successful
  // runs of the images endpoint only, while a text run that invokes the CLI's
  // own generate_image tool (recorded with kind text) and a generation the
  // client abandons after the image event (recorded aborted) spend quota
  // without being counted.
  imageWindow(provider: string, windowMs = H5, now = Date.now()): ImageWindow {
    const row = this.stmts.imageWindow.get(provider, now - windowMs) as { used: number; started: number | null };
    return { used: Number(row.used), windowStartedAt: row.started === null ? null : Number(row.started) };
  }
  totals(provider: string, sinceMs: number, now = Date.now()): Totals {
    const row = this.stmts.totals.get(provider, now - sinceMs) as { calls: number; i: number; o: number };
    return { calls: Number(row.calls), inputTokens: Number(row.i), outputTokens: Number(row.o) };
  }
  setWindow(provider: string, window: WindowName, w: RateLimitWindow, now = Date.now()): void {
    this.stmts.setWindow.run(provider, window, w.utilization, w.resetsAt, now);
  }
  windows(provider: string): Partial<Record<WindowName, RateLimitWindow & { updatedAt: number }>> {
    const rows = this.stmts.windows.all(provider) as
      { window: WindowName; utilization: number; resets_at: number; updated_at: number }[];
    const out: Partial<Record<WindowName, RateLimitWindow & { updatedAt: number }>> = {};
    for (const r of rows) out[r.window] = { utilization: r.utilization, resetsAt: r.resets_at, updatedAt: r.updated_at };
    return out;
  }
  // The pause a rate limit installed, provider-wide (model null) or for one
  // model. It replaces whatever stood for that scope: the caller has already
  // decided the pause only grows, so what arrives here is the state to keep.
  setPause(provider: string, model: string | null, until: number, strikes: number, now = Date.now()): void {
    this.stmts.setPause.run(provider, model, until, strikes, now);
  }
  clearPause(provider: string, model: string | null): void {
    this.stmts.clearPause.run(provider, model);
  }
  /** The pauses still standing at `now`. A read, and only a read. */
  pauses(now = Date.now()): PauseRow[] {
    return this.pauseRows(this.stmts.pauses.all(now));
  }
  /** The pauses that ended before `now` after their start was announced: read before prunePauses() drops them. */
  expiredAnnouncedPauses(now = Date.now()): PauseRow[] {
    return this.pauseRows(this.stmts.expiredAnnounced.all(now));
  }
  /** Records that a pause's start was announced, or, with null, that the pause standing now was not. */
  markPauseAnnounced(provider: string, model: string | null, at: number | null): void {
    this.stmts.announcePause.run(at, provider, model);
  }
  private pauseRows(all: unknown[]): PauseRow[] {
    const rows = all as { provider: string; model: string | null; until: number; strikes: number; announced_at: number | null }[];
    return rows.map((r) => ({ provider: r.provider, model: r.model, until: Number(r.until), strikes: Number(r.strikes), announcedAt: r.announced_at === null ? null : Number(r.announced_at) }));
  }
  /**
   * Drops the rows that expired before `now` and says how many went, so the
   * caller can log it. Kept out of pauses(): a reader that deletes destroys a
   * five-day pause silently when the clock it is given is wrong (a restored
   * VM snapshot, an RTC off, an NTP step before time-sync.target), and the
   * only trace of the collection would be the row's absence.
   */
  prunePauses(now = Date.now()): number {
    return Number(this.stmts.prunePauses.run(now).changes);
  }

  // SIGTERM followed by SIGINT closes the store twice, and node:sqlite throws
  // on the second close: the flag keeps a clean shutdown clean.
  // ---- The gateway's own identity: keys it issued, and names for callers.

  /**
   * A new key, returned in the clear exactly once. `cap_` and 32 random
   * bytes; what is stored is the sha256 of the whole string, so a database
   * read back from a backup yields nothing a client could send.
   */
  createKey(name: string, createdBy: string | null, now = Date.now()): { name: string; key: string; createdAt: number } {
    if (!KEY_NAME.test(name)) throw new CapitolineError("bad_request", `key name "${name}" must match ${KEY_NAME}`);
    const key = `cap_${randomBytes(32).toString("base64url")}`;
    try {
      this.stmts.insertKey.run(name, hashKey(key), now, createdBy);
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw new CapitolineError("bad_request", `key "${name}" already exists`);
      throw e;
    }
    return { name, key, createdAt: now };
  }

  /** The key's name when it is one of ours and not revoked; null otherwise. Touches last_used_at. */
  authenticateKey(key: string, now = Date.now()): { name: string } | null {
    if (!key.startsWith("cap_")) return null;
    const row = this.stmts.keyByHash.get(hashKey(key)) as { name: string; revoked_at: number | null } | undefined;
    if (!row || row.revoked_at !== null) return null;
    this.stmts.touchKey.run(now, row.name);
    return { name: row.name };
  }

  /** Whether any live key exists: with none and no Access the gateway is open (design §4). */
  hasKeys(): boolean {
    return Number((this.stmts.liveKeys.get() as { n: number }).n) > 0;
  }

  listKeys(): ApiKeyInfo[] {
    const rows = this.stmts.keys.all() as { name: string; created_at: number; created_by: string | null; revoked_at: number | null; last_used_at: number | null }[];
    return rows.map((r) => ({ name: r.name, createdAt: Number(r.created_at), createdBy: r.created_by, revokedAt: r.revoked_at === null ? null : Number(r.revoked_at), lastUsedAt: r.last_used_at === null ? null : Number(r.last_used_at) }));
  }

  /** True when the key existed and was live; a second revoke, or an unknown name, is false. */
  revokeKey(name: string, now = Date.now()): boolean {
    const revoked = Number(this.stmts.revokeKey.run(now, name).changes) > 0;
    // What OAuth issued on this key's authority goes with it: the check on
    // every use (isLiveKey) would refuse the tokens anyway, and this leaves
    // nothing behind that a later key of the same name could inherit.
    if (revoked) this.stmts.deleteOAuthTokensOfKey.run(name);
    return revoked;
  }

  /** True while a key of that name exists and is not revoked. */
  isLiveKey(name: string): boolean {
    return this.stmts.liveKey.get(name) !== undefined;
  }

  // ---- OAuth: registered clients and issued tokens (src/server/oauth.ts).
  saveOAuthClient(clientId: string, metadata: string, now = Date.now()): void {
    this.stmts.saveOAuthClient.run(clientId, metadata, now);
  }
  oauthClient(clientId: string): string | null {
    const r = this.stmts.oauthClient.get(clientId) as { metadata: string } | undefined;
    return r?.metadata ?? null;
  }
  /** Stores a token by its hash; the token itself is never kept. Expired ones are dropped on the way. */
  saveOAuthToken(token: string, t: OAuthTokenRow, now = Date.now()): void {
    this.stmts.pruneOAuthTokens.run(now);
    this.stmts.insertOAuthToken.run(hashKey(token), t.kind, t.keyName, t.clientId, t.resource, t.scopes.join(" "), t.expiresAt, now);
  }
  oauthToken(token: string): OAuthTokenRow | null {
    const r = this.stmts.oauthToken.get(hashKey(token)) as { kind: string; key_name: string; client_id: string; resource: string | null; scopes: string; expires_at: number } | undefined;
    if (!r) return null;
    return { kind: r.kind as OAuthTokenRow["kind"], keyName: r.key_name, clientId: r.client_id, resource: r.resource, scopes: r.scopes === "" ? [] : r.scopes.split(" "), expiresAt: Number(r.expires_at) };
  }
  /** True when the token existed. */
  deleteOAuthToken(token: string): boolean {
    return Number(this.stmts.deleteOAuthToken.run(hashKey(token)).changes) > 0;
  }

  nameCaller(id: string, name: string, now = Date.now()): void {
    this.stmts.nameCaller.run(id, name, now);
  }

  callerNames(): Record<string, string> {
    return Object.fromEntries((this.stmts.callerNames.all() as { id: string; name: string }[]).map((r) => [r.id, r.name]));
  }

  saveCatalog(provider: string, listing: ListedModel[], now = Date.now()): void {
    this.stmts.saveCatalog.run(provider, JSON.stringify(listing), now);
  }

  /** The stored listings. A row that no longer parses is skipped: the next listing replaces it. */
  catalogs(): { provider: string; listing: ListedModel[]; checkedAt: number }[] {
    const rows = this.stmts.catalogs.all() as { provider: string; listing: string; checked_at: number }[];
    return rows.flatMap((r) => {
      try {
        const listing = JSON.parse(r.listing) as unknown;
        return Array.isArray(listing) ? [{ provider: r.provider, listing: listing as ListedModel[], checkedAt: Number(r.checked_at) }] : [];
      } catch { return []; }
    });
  }

  announcedVersion(provider: string): string | null {
    const row = this.stmts.announced.get(provider) as { announced: string } | undefined;
    return row?.announced ?? null;
  }

  setAnnouncedVersion(provider: string, version: string, now = Date.now()): void {
    this.stmts.setAnnounced.run(provider, version, now);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
