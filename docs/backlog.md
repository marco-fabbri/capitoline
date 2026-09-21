# Backlog

Open points from independent code review of the phase 1 implementation (minor
findings only; each was checked against the current code and dropped if
already fixed or superseded), plus phase 2 and beyond. Findings that were
duplicated across tasks are merged into one line. Runner (`src/runner/runner.ts`)
had two review findings and both are already fixed in the current code
(attachment name validation, eager line buffering), so it has no section below.

## Config

- `package.json` / `.nvmrc`: `engines: { "node": ">=24" }` is open-ended while dev runs Node 26 and production (Debian 13 LXC) targets Node 24, so a class of version drift is invisible until deploy — add `.nvmrc` pinned to the deployment major and tighten `engines` to `>=24 <25`.
- `src/log.ts`: `process.env.LOG_LEVEL` is passed to pino unvalidated, so a typo in the systemd environment file crashes the process at startup instead of degrading — validate against the known pino levels and fall back to `"info"`.
- `src/config.ts`: the `health_model` check uses the `in` operator, so an inherited `Object.prototype` key (e.g. `toString`) passes validation instead of being rejected — use `Object.hasOwn(p.models, p.health_model)`.
- `src/config.ts`: none of the zod object schemas are `.strict()`, so a typo in a YAML key (e.g. `runner.usr` instead of `runner.user`) is silently dropped instead of rejected, which can silently disable the sudo privilege separation — add `.strict()` to `ModelSchema`, `ProviderSchema` and the other nested objects.
- `src/config.ts`: `providers` accepts an empty map, so the gateway can start with zero providers and serve 404 to everything with no error pointing at the cause — add a `superRefine` issue when `Object.keys(cfg.providers).length === 0`.
- `src/config.ts`: nothing cross-checks that a model's `efforts` are all keys of its provider's `effort` table, so a mismatched entry silently drops the `--effort`/suffix at runtime instead of failing at config load — add that cross-check to the `superRefine`.
- `src/config.ts`: the reserved-name check only blocks `"capitoline"` or `"capitoline-*"`, narrower than the intended `capitoline*` reservation, so e.g. `capitolineX` is accepted and could collide with the phase 2 council namespace — change the condition to `name.startsWith("capitoline")`.

## Core

- `src/core/prompt.ts`: `nearestEffort` has no guard on its inputs — an empty `allowed` array returns `undefined` despite the `Effort` return type, and an unknown `wanted` value silently resolves to the lowest allowed level — throw on both cases instead of returning a bad value.
- `src/core/prompt.ts`: `flatten()` uses an `as "user" | "assistant"` cast to route around `Message.role` including `"system"`, so a system message that reaches it renders as the literal text `"undefined: ..."` instead of failing — replace the cast with an explicit check that throws when a system message is found.
- `src/core/types.ts`: `RateLimitWindow.resetsAt` lost the unit annotation from the plan (`// resetsAt: unix seconds`), which matters because `UsageStore` stores it next to an `updatedAt` that is milliseconds — restore the comment.

## Providers

- `src/providers/claude.ts`, `src/providers/codex.ts`, `src/providers/antigravity.ts`: the CLI flag/key names (`--model`/`--effort`, `-m`/`-c model_reasoning_effort`, `--model`) are hardcoded in the adapters instead of coming from `config/capitoline.yaml`, breaking the "code never hardcodes a CLI flag" rule — add optional `model_flag`/`effort_flag`/`effort_key` fields to `ProviderSchema` and read them in each adapter.
- `src/providers/adapter.ts`: `effortValue()` picks the nearest effort from `model.efforts` before checking it exists in the provider's `effort` table, so a mismatched entry returns `null` and silently drops the effort instead of falling back — intersect the candidate list with the table before calling `nearestEffort`.
- `src/providers/adapter.ts`: `nearestEffort`'s tie-break favors the higher level, so a model offering only `low`/`high` runs `high` by default when no effort is requested, with real latency/quota impact and no comment recording it's intentional — document it above `effortValue` or change the tie-break to favor the lower level.
- `src/providers/claude.ts`: the `rate_limit_event` branch always emits a `rate_limit` event even when both windows are unparseable, which lets `Core.onRateLimit` silently clear a previously-set `windowOverBudget` — skip emission when both `fiveHour` and `sevenDay` are `undefined`.
- `src/providers/codex.ts`: the JSON→TOML escaping comment is wrong for unpaired surrogates (client-controlled input can produce one), which TOML rejects as invalid — strip/replace unpaired surrogates before `JSON.stringify` and fix the comment.
- `src/providers/codex.ts`: `(o.error ?? o) as { message?: string }` assumes `error` is always an object; if Codex ever emits a string `error` (e.g. for a 429), the real message is discarded and it's misclassified as `cli_crashed` (502) instead of `rate_limited` (429) — handle the string case explicitly.
- `src/providers/antigravity.ts`: usage accounting only sums `input_tokens`/`output_tokens`, ignoring `cache_read_tokens`/`thinking_tokens` that Claude's adapter does include, so budget windows understate real consumption for this provider once caching kicks in — align the formula with `claude.ts` or document the difference.

## Runner

- `src/runner/runner.ts` — observed once on the Mac with the real `claude` CLI: after a streaming request the client closed early, one empty `run-…` directory remained under `sandbox_root`; not reproducible with the fake CLIs, whose abort path cleans up. Fix: reproduce with the real CLI at `LOG_LEVEL=debug`, and add a startup sweep removing stale `run-*` directories older than the provider timeout.

## Usage

- `src/usage/store.ts`: every `record()`/`totals()`/`setWindow()`/`windows()` call recompiles its SQL with `db.prepare()`, paying compilation cost on every HTTP/MCP request — prepare the four statements once in the constructor and reuse them.
- `src/usage/store.ts`: `close()` is not idempotent (`node:sqlite` throws on a second call), so a process that receives both SIGTERM and SIGINT can turn a clean shutdown into an unhandled rejection — guard it with a `closed` flag.
- `src/usage/store.ts`: the constructor opens `db_path` without ensuring its parent directory exists, so a fresh deployment with a nested path (e.g. `/var/lib/capitoline/usage.sqlite`) fails at startup with an opaque `unable to open database file` — `mkdirSync(dirname(path), { recursive: true })` before opening.

## Server

- `src/main.ts`: `close()` calls `server.close()` without closing open connections, so an in-flight SSE stream (production `timeout_s: 600`) keeps the shutdown hanging until systemd sends SIGKILL — call `closeIdleConnections()`/`closeAllConnections()` with a bounded grace period.
- `src/main.ts`: the SIGTERM/SIGINT handler is not idempotent and doesn't handle rejection, so a second signal calls `close()` on an already-closed server/store and can exit uncleanly — add a `closing` guard and `.catch()`.
- `src/main.ts`: the `app.listen()` promise only resolves on `"listening"` with no `"error"` listener, so an `EADDRINUSE` in production surfaces as an uncaught exception with no diagnostic message — listen for `"error"` and reject.
- `src/main.ts`: entrypoint detection builds the file URL manually (`` `file://${process.argv[1]}` ``) instead of `pathToFileURL`, so a path containing `#` or `?` is misparsed and the service silently doesn't start (exit 0) — use `pathToFileURL(process.argv[1])`.
- `src/main.ts`: the server starts listening before `await core.checkHealth()` completes, so in that window every model looks available and a request can be routed to a broken CLI (502 instead of 404/503) — run the first health check before creating the listener.

## MCP

- `src/mcp/server.ts`: the progress notification can send the same `progress` value twice (at the last `n % 20 === 0` mark and again at completion), which violates the MCP spec's "must increase" rule — use a counter that always advances.
- `src/mcp/server.ts`: a provider error's `detail` is discarded on the MCP path (`throw new CapitolineError(ev.kind, ev.kind)` and `log.warn` without it), unlike the HTTP path which logs it — log and drop only the kind from the thrown error, same as `app.ts`.
- `src/mcp/server.ts`: `app.all("/mcp", handler)` also answers GET with an endless SSE stream in stateless mode, which can hang `server.close()` on shutdown — reject GET (and other non-POST verbs) with 405.
- `src/mcp/server.ts`: the `ask_model` tool has no `attachments` parameter, so images can't be sent over MCP even though the HTTP path supports them — add the parameter or record the gap as a deliberate phase 1 deferral.

## Docs/deploy

- `docs/deploy.md` (§ backup cron): the backup command `tar czf` runs against the live `usage.sqlite` while WAL mode is on, so a restore can silently miss committed data still in the `-wal` sidecar — take a consistent snapshot first (`sqlite3 ... ".backup"` or `VACUUM INTO`) and tar that.

## Tests

- `test/scaffold.test.ts`: the only assertion (`level).toBeDefined()`) would still pass if `createLogger` dropped the name binding or the `LOG_LEVEL` override entirely — assert `bindings().name`, the default level and the `LOG_LEVEL`-overridden level explicitly.
- `test/adapter.test.ts`: does not exist, so `effortValue`, `modelSpecs` and `jsonLines` in `src/providers/adapter.ts` have zero direct test coverage — add it with the null-effort-table, effort-fallback and malformed-JSON-line cases.
- `test/claude.test.ts`: the `system_prompt_flag: null` branch of `buildCommand` (used by the Antigravity adapter too) is never exercised — add a case with `system_prompt_flag: null` asserting the `"System instructions:\n..."` stdin fallback.
- `test/claude.test.ts`: `buildCommand` is only tested with a single user message, so the real multi-turn case (`"User: ... / Assistant: ..."` markers) is never exercised through the adapter — add a 3-message case.
- `test/codex.test.ts`: three behaviors are uncovered — no `developer_instructions` flag when there's no system message, the `type: "error"` fallback branch, and the `system_prompt_flag: null` stdin path — add the three cases.
- `test/antigravity.test.ts`: no test asserts that `cfg.args` is the prefix of the built command, so dropping `--input-format stream-json`/`--sandbox`/`-p=` from the adapter would leave every existing test green — assert `c.args.slice(0, cfg.args.length)` and the total arg count.
- `test/antigravity.test.ts`: the error-mapping test never asserts the resulting `kind`, unlike the Claude/Codex equivalents, so `rate_limited`/`auth_expired` classification for Antigravity is unverified — assert `kind` on the existing fixture and add synthetic rate-limit/auth cases.
- `test/usage.test.ts`: both tests use `":memory:"`, so the file-backed path, the WAL pragma and four of the eight recorded columns (`model`, `duration_ms`, `outcome`, `source`) are never exercised — add a file-backed test that reopens the DB with a second connection and reads the row back.
- `test/e2e.test.ts`: "streams through the fake claude" only checks the text ends with `data: [DONE]`, so an empty stream would pass identically — parse the SSE lines and assert the concatenated delta, first/last chunk shape and non-zero usage.
- `test/e2e.config.yaml`: is a hand-copied duplicate of `config/capitoline.yaml` with nothing checking they stay aligned beyond the intended diffs (port, runner user, sandbox root, db path, binaries, timeouts) — add a test that loads both and asserts they differ only in those keys.
- `test/runner.test.ts`: every case uses `user: null`, so the production `sudo -n -H -u <user> --` branch of `src/runner/runner.ts` (argv shape, reduced env) is never exercised by any test — add a case with a fake `sudo` script on `PATH` asserting argv and env.
- `test/e2e.config.yaml`: `sandbox_root: /tmp/capitoline-e2e` is a fixed, predictable path in a world-writable directory and is never cleaned up after the suite — move it under the repo's own tmp dir or add an `afterAll` cleanup.
- `test/e2e.test.ts`: `beforeAll` has no explicit timeout, so it can exceed vitest's default 10s hook timeout under load and fail with an opaque "hook timed out" instead of a readable error — pass an explicit timeout (e.g. 30s).
- `test/mcp.test.ts`: no test exercises the `ask_model` progress notifications, so the "must increase" bug above would go unnoticed — add a 45-event script and assert strictly increasing `progress` values.
- `test/mcp.test.ts`: the last test mutates the shared `provider.script` and never restores it, so a test appended afterward would silently run against the rate-limited script — capture and restore the original script (or reset it within the same test).
- `test/mcp.test.ts`: nothing asserts that CLI `detail` (potential stderr) stays out of the MCP tool-error response — script a detail that looks like stderr and assert it's absent from the returned text.
- `test/mcp.test.ts`: nothing pins that `/mcp` is mounted behind the Access middleware, so a refactor that reorders them would pass every existing test while leaving MCP unauthenticated — add a test with a denying `access` middleware asserting 401 on `/mcp` and 200 on `/health`.

## Phase 2 and beyond

- **Cloudflare MCP Server Portals (beta)**: register `/mcp` in a portal (Zero Trust → Access controls → MCP Portals) to get OAuth login, per-tool policies and invocation logs instead of the raw service token in Claude Code's config. To verify: whether the portal forwards progress notifications (the council needs them) and how it coexists with the Access service-token policy already on the hostname (a second hostname for the portal may be needed).


**OpenAI-compatible API adapter.** For self-hosted inference only — a company inference platform, Ollama, vLLM. No pay-per-use public APIs, by the owner's rule. This adapter also enables a stateless Kubernetes/NKP deployment and lets a company inference platform register Capitoline as a backend (Agent Gateway / Unified Endpoints) and as an MCP server (the platform 2.8).

**Council.** A virtual model named `capitoline`, using the strategy from karpathy/llm-council: independent answers from each provider, anonymous peer ranking, then judge synthesis. Exposed as the MCP tool `ask_council`.

**Antigravity image generation.** `agy` exposes a `generate_image` tool (model `gemini-3.1-flash-image`). Measured quota: 12 images per 5-hour window from the first generation; the 13th gets HTTP 429 `RESOURCE_EXHAUSTED` and the window stays closed until the reset; each image takes roughly 35-45 s. In `-p` mode, `agy` does not fail on that 429: it reports SUCCESS, writes a near-empty PNG (2-65 KB versus 1.8-2.4 MB for a real image) and puts the error only in the text output. Needed: detect the rate limit from the tool's raw JSON (`"code": 429`, `"status": "RESOURCE_EXHAUSTED"`, `"reason": "QUOTA_EXHAUSTED"`, a message like "You have exhausted your capacity on this model. Your quota will reset after 4h14m59s."), parse the countdown into an absolute pause time, and check output size (500 KB threshold, ideally a near-monochrome check too). Candidate endpoint: `/v1/images/generations`.

**Antigravity text rate limits.** The same "reports success but the error is in the text" pattern seen for image generation may also occur for text output — verify this and extend `classifyError` accordingly if confirmed.

**Real error fixtures.** Capture real fixtures (expired token, exhausted window) for all three CLIs, recorded when the conditions actually occur rather than synthesized.

**Two-container pod shape.** Gateway and runner as separate containers in one pod, communicating over a local socket, as the clean alternative to running sudo inside a single container.
