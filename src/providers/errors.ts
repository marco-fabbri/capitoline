import type { ErrorKind } from "../core/types.js";

// Patterns come from the CLIs' known messages. Real captures from an expired
// token or an exhausted window (spike open item 3) must be added to the tests
// when they happen; until then these are the documented strings.
const AUTH = /login expired|not logged in|unauthori[sz]ed|\b401\b|invalid.*token|expired.*token|authentication (failed|required)|please run \/login|codex login/i;
const RATE = /rate.?limit|\b429\b|too many requests|usage limit|quota|resets? at|capacity/i;

export function classifyError(text: string): ErrorKind {
  if (AUTH.test(text)) return "auth_expired";
  if (RATE.test(text)) return "rate_limited";
  return "cli_crashed";
}

// A refusal the CLI attributes to the model that was asked for rather than to
// the subscription behind it. Real capture on the host, 2026-09-21: "You've
// reached your Fable limit. Switch to another model, or manage usage credits
// at claude.ai/settings/usage?from=cc_cli_limit_message, to continue." — sent
// while the same subscription still answered on Opus and Sonnet.
//
// Two markers, both taken from wordings the CLIs actually use: the advice to
// change model, which says in so many words that the others still work, and a
// limit named after something that is not the plan itself (model names run to
// three tokens: "Claude Opus", "Opus 4.5").
//
// The subscription-wide wordings are a **veto on the whole answer**, not an
// exception carved out of one marker. That sentence is a single CLI template
// with the limit's name filled in, so an exhausted subscription produces
// "You've reached your usage limit. Switch to another model, …" — the same
// advice to change model, about a subscription that has nothing left. Reading
// that as model-scoped would pause the one model asked for and leave every
// other model of the provider starting a real CLI run (up to the timeout)
// before being paused in its turn, which is the hammering the model-scoped
// pause exists to avoid.
const PLAN_SCOPED = /\b(?:reached|hit) your (?:usage|plan|account|subscription|weekly|daily|monthly|five|5)\b|\busage limit reached\b/i;
const MODEL_SCOPED = /\bswitch to (?:another|a different) model\b|\breached your [\w.-]+(?: [\w.-]+){0,2} limit\b/i;

export function isModelScoped(text: string): boolean {
  return !PLAN_SCOPED.test(text) && MODEL_SCOPED.test(text);
}

// Antigravity's image quota exhaustion is silent: the run ends SUCCESS, and the
// only trace is the tool step in ERROR carrying a 429 body, or prose from the
// agent. The captured shape (test/fixtures/antigravity/image-429.jsonl):
//   tool_info.error.message = "failed to generate content: 429 Too Many Requests, body: {...}"
// with error.code 429, error.status RESOURCE_EXHAUSTED and details[] holding
// ErrorInfo.metadata { model, quotaResetDelay, quotaResetTimeStamp } and
// RetryInfo.retryDelay. There are two rolling windows (hours and days), so the
// wait is always taken from the message, never assumed.
export interface QuotaHit {
  // Seconds to wait, rounded up; absent when the text gives no reset.
  retryAfterS?: number;
  // The reset instant in ms since the epoch, when the text carries one.
  resetAt?: number;
  // The exhausted model as the backend names it (e.g. gemini-3.1-flash-image).
  model?: string;
  // What triggered the hit, for logs.
  matched: string;
}

// Failure context is required: the bare noun "quota" also appears in
// legitimate prompts the agent echoes ("the fishing quota chart").
const PROSE_MARKER = /\b429\b|too many requests|RESOURCE_EXHAUSTED|QUOTA_EXHAUSTED|quota\s+(?:\w+\s+)?(?:exhaust|exceed|limit|reset)|exhausted your (?:capacity|quota)|rate.?limit/i;
// "quota will reset after 4h14m59s", "resets in 2h", "reset in 1h 5m 3s".
const PROSE_RESET = /reset(?:s)?\s+(?:after|in)\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i;
// "122h50m8.592940533s" or "442208.592940533s" (google.rpc duration strings).
const DURATION = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/;
const LOOSE_MARKERS: RegExp[] = [/"code"\s*:\s*"?429\b/, /RESOURCE_EXHAUSTED/, /QUOTA_EXHAUSTED/];
const JSON_STRING_FIELD = (key: string) => new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`);
// The model named inside the quota metadata, not any "model" field of the text.
const METADATA_MODEL = /"metadata"\s*:\s*\{[^}]*"model"\s*:\s*"([^"]+)"/;
const MODEL_WORD = /\b(gemini-[a-z0-9][a-z0-9.-]*[a-z0-9])\b/i;
// Keys under which an event carries what the backend said; everything else
// in a structured event (notably tool_info.parameters.Prompt) is text chosen
// by the API client and must never produce a hit.
const ERROR_KEYS = new Set(["error", "message", "detail", "details"]);

export function detectQuotaExhausted(text: string, now: number = Date.now()): QuotaHit | null {
  const event = tryParse(text.trim());
  if (event !== undefined) {
    // A structured event (the adapter's raw step_update, or a bare body):
    // only its error channel is read, and the prose pass never runs on it;
    // the agent's prose reaches the caller separately as text events.
    const channel = [...errorStrings(event)];
    return fromBodies([event, ...channel.map(bodyAfterMarker)], now) ?? fromLooseMarkers(channel.join("\n"), now);
  }
  return fromBodies([bodyAfterMarker(text)], now) ?? fromLooseMarkers(text, now) ?? fromProse(text);
}

// (1) The JSON body the backend returned, in the tool error message ("...,
// body: {...}") or given bare.
function fromBodies(candidates: Iterable<unknown>, now: number): QuotaHit | null {
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const hit = readBody(candidate, now);
    if (hit) return hit;
  }
  return null;
}

function bodyAfterMarker(s: string): unknown {
  const at = s.indexOf("body:");
  if (at < 0) return undefined;
  const open = s.indexOf("{", at);
  if (open < 0) return undefined;
  return tryParse(balancedObject(s, open));
}

// The substring from the `{` at `start` to its matching `}`, skipping braces
// inside string literals; to the end of the text when unbalanced (JSON.parse
// then fails and the loose markers take over).
function balancedObject(s: string, start: number): string {
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return s.slice(start, i + 1);
  }
  return s.slice(start);
}

function tryParse(s: string): unknown {
  if (!s.startsWith("{")) return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
}

// The string values of `v` that sit under an error key (tool_info.error.message
// in the captured shape). `parameters` is skipped outright: those are the
// tool's arguments.
function* errorStrings(v: unknown, inError = false): Iterable<string> {
  if (typeof v === "string") {
    if (inError) yield v;
  } else if (Array.isArray(v)) {
    for (const x of v) yield* errorStrings(x, inError);
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (k === "parameters") continue;
      yield* errorStrings(x, inError || ERROR_KEYS.has(k));
    }
  }
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined);

function readBody(body: unknown, now: number): QuotaHit | null {
  const err = rec(rec(body)?.error);
  if (!err) return null;
  const code = typeof err.code === "string" ? Number(err.code) : err.code;
  const status = err.status;
  if (code !== 429 && status !== "RESOURCE_EXHAUSTED") return null;

  let model: string | undefined;
  let resetAt: number | undefined;
  let delayS: number | undefined;
  let retryS: number | undefined;
  for (const d of Array.isArray(err.details) ? err.details : []) {
    const detail = rec(d);
    const meta = rec(detail?.metadata);
    if (meta) {
      if (typeof meta.model === "string") model ??= meta.model;
      if (typeof meta.quotaResetTimeStamp === "string") resetAt ??= parseInstant(meta.quotaResetTimeStamp);
      if (typeof meta.quotaResetDelay === "string") delayS ??= parseDuration(meta.quotaResetDelay);
    }
    if (typeof detail?.retryDelay === "string") retryS ??= parseDuration(detail.retryDelay);
  }
  const matched: string[] = [];
  if (code !== undefined) matched.push(`error.code=${String(code)}`);
  if (status !== undefined) matched.push(`status=${String(status)}`);
  return compact({
    matched: matched.join(" "),
    model,
    resetAt,
    retryAfterS: boundedWait(delayS ?? retryS, resetAt, now),
  });
}

// (2) The markers of the body when its JSON did not parse (truncated, garbled).
// Whatever fields survive are read with plain regexps.
function fromLooseMarkers(text: string, now: number): QuotaHit | null {
  const marker = LOOSE_MARKERS.find((re) => re.test(text));
  if (!marker) return null;
  const resetAt = parseInstant(JSON_STRING_FIELD("quotaResetTimeStamp").exec(text)?.[1]);
  const delayS = parseDuration(JSON_STRING_FIELD("quotaResetDelay").exec(text)?.[1])
    ?? parseDuration(JSON_STRING_FIELD("retryDelay").exec(text)?.[1])
    ?? proseDelay(text);
  return compact({
    matched: marker.exec(text)![0],
    model: METADATA_MODEL.exec(text)?.[1] ?? MODEL_WORD.exec(text)?.[1],
    resetAt,
    retryAfterS: boundedWait(delayS, resetAt, now),
  });
}

// (3) The agent's prose about the failure, in whatever wording.
function fromProse(text: string): QuotaHit | null {
  const m = PROSE_MARKER.exec(text);
  if (!m) return null;
  return compact({ matched: m[0], model: MODEL_WORD.exec(text)?.[1], retryAfterS: proseDelay(text) });
}

function proseDelay(text: string): number | undefined {
  const m = PROSE_RESET.exec(text);
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

function parseDuration(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = DURATION.exec(s.trim());
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return undefined;
  // Rounded up: a fraction of a second early is still a wasted probe.
  return Math.ceil(Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0));
}

function parseInstant(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

function untilInstant(resetAt: number | undefined, now: number): number | undefined {
  return resetAt === undefined ? undefined : Math.max(0, Math.ceil((resetAt - now) / 1000));
}

// The delay is relative to the moment the backend answered, the instant is
// not: on a message read late (delayed, replayed) the instant is the reliable
// one, so it caps the delay and never lets a pause outlive a reset.
function boundedWait(delayS: number | undefined, resetAt: number | undefined, now: number): number | undefined {
  const untilReset = untilInstant(resetAt, now);
  if (untilReset === undefined) return delayS;
  return delayS === undefined ? untilReset : Math.min(delayS, untilReset);
}

// Drop undefined fields so callers can compare hits with toEqual/toMatchObject.
function compact(hit: QuotaHit): QuotaHit {
  return Object.fromEntries(Object.entries(hit).filter(([, v]) => v !== undefined)) as unknown as QuotaHit;
}
