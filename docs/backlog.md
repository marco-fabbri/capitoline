# Backlog

Open points from independent code review of the phase 1 implementation (minor
findings only; each was checked against the current code and dropped if
already fixed or superseded), plus phase 2 and beyond. Findings that were
duplicated across tasks are merged into one line. Runner (`src/runner/runner.ts`)
had two review findings and both are already fixed in the current code
(attachment name validation, eager line buffering); the Runner section below is
not one of them but a later observation from the host, still to be confirmed.

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

- Observation to confirm on the host: watch `/var/lib/capitoline/sandboxes` while the service is up. The one empty `run-…` directory seen on the Mac now has an explanation and a fix (a grandchild inheriting stdout kept `close` from firing, so the run never settled: `src/runner/runner.ts` bounds that wait since A6), and the startup sweep removes whatever an earlier process left behind — which is exactly why the remaining symptom is a `run-…` directory appearing there *between* two restarts. That means a run that hung rather than one that was killed, and it is the only thing left that would show a second leak path. Nothing else in the repository looks at that directory while the gateway is running.

## MCP

- `src/mcp/server.ts`: the progress notification can send the same `progress` value twice (at the last `n % 20 === 0` mark and again at completion), which violates the MCP spec's "must increase" rule — use a counter that always advances.
- `src/mcp/server.ts`: a provider error's `detail` is discarded on the MCP path (`throw new CapitolineError(ev.kind, ev.kind)` and `log.warn` without it), unlike the HTTP path which logs it — log and drop only the kind from the thrown error, same as `app.ts`.
- `src/mcp/server.ts`: `app.all("/mcp", handler)` also answers GET with an endless SSE stream in stateless mode, which can hang `server.close()` on shutdown — reject GET (and other non-POST verbs) with 405.
- `src/mcp/server.ts`: the `ask_model` tool has no `attachments` parameter, so images can't be sent over MCP even though the HTTP path supports them — add the parameter or record the gap as a deliberate phase 1 deferral.

## Tests

- `test/adapter.test.ts`: does not exist, so `effortValue`, `modelSpecs` and `jsonLines` in `src/providers/adapter.ts` have zero direct test coverage — add it with the null-effort-table, effort-fallback and malformed-JSON-line cases.
- `test/claude.test.ts`: the `system_prompt_flag: null` branch of `buildCommand` (used by the Antigravity adapter too) is never exercised — add a case with `system_prompt_flag: null` asserting the `"System instructions:\n..."` stdin fallback.
- `test/claude.test.ts`: `buildCommand` is only tested with a single user message, so the real multi-turn case (`"User: ... / Assistant: ..."` markers) is never exercised through the adapter — add a 3-message case.
- `test/codex.test.ts`: three behaviors are uncovered — no `developer_instructions` flag when there's no system message, the `type: "error"` fallback branch, and the `system_prompt_flag: null` stdin path — add the three cases.
- `test/antigravity.test.ts`: no test asserts that `cfg.args` is the prefix of the built command, so dropping `--input-format stream-json`/`--sandbox`/`-p=` from the adapter would leave every existing test green — assert `c.args.slice(0, cfg.args.length)` and the total arg count.
- `test/antigravity.test.ts`: the error-mapping test never asserts the resulting `kind`, unlike the Claude/Codex equivalents, so `rate_limited`/`auth_expired` classification for Antigravity is unverified — assert `kind` on the existing fixture and add synthetic rate-limit/auth cases.
- `test/e2e.test.ts`: "streams through the fake claude" only checks the text ends with `data: [DONE]`, so an empty stream would pass identically — parse the SSE lines and assert the concatenated delta, first/last chunk shape and non-zero usage.
- `test/e2e.config.yaml`: is a hand-copied duplicate of `config/capitoline.yaml` with nothing checking they stay aligned beyond the intended diffs (port, runner user, sandbox root, db path, binaries, timeouts) — add a test that loads both and asserts they differ only in those keys.
- `test/runner.test.ts`: every case uses `user: null`, so the production `sudo -n -H -u <user> --` branch of `src/runner/runner.ts` (argv shape, reduced env) is never exercised by any test — add a case with a fake `sudo` script on `PATH` asserting argv and env.
- `test/e2e.test.ts`: `beforeAll` has no explicit timeout, so it can exceed vitest's default 10s hook timeout under load and fail with an opaque "hook timed out" instead of a readable error — pass an explicit timeout (e.g. 30s).
- `test/mcp.test.ts`: no test exercises the `ask_model` progress notifications, so the "must increase" bug above would go unnoticed — add a 45-event script and assert strictly increasing `progress` values.
- `test/mcp.test.ts`: the last test mutates the shared `provider.script` and never restores it, so a test appended afterward would silently run against the rate-limited script — capture and restore the original script (or reset it within the same test).
- `test/mcp.test.ts`: nothing asserts that CLI `detail` (potential stderr) stays out of the MCP tool-error response — script a detail that looks like stderr and assert it's absent from the returned text.
- `test/mcp.test.ts`: nothing pins that `/mcp` is mounted behind the Access middleware, so a refactor that reorders them would pass every existing test while leaving MCP unauthenticated — add a test with a denying `access` middleware asserting 401 on `/mcp` and 200 on `/health`.

## Phase 2 and beyond

- **Cloudflare MCP Server Portals (beta)**: register `/mcp` in a portal (Zero Trust → Access controls → MCP Portals) to get OAuth login, per-tool policies and invocation logs instead of the raw service token in Claude Code's config. To verify: whether the portal forwards progress notifications (the council needs them) and how it coexists with the Access service-token policy already on the hostname (a second hostname for the portal may be needed).


**OpenAI-compatible API adapter.** For self-hosted inference only — a company inference platform, Ollama, vLLM. No pay-per-use public APIs, by the owner's rule. This adapter also enables a stateless Kubernetes/NKP deployment and lets a company inference platform register Capitoline as a backend (Agent Gateway / Unified Endpoints) and as an MCP server (the platform 2.8).

**Council.** A virtual model named `capitoline`, using the strategy from karpathy/llm-council: independent answers from each provider, anonymous peer ranking, then judge synthesis. Exposed as the MCP tool `ask_council`.

**Council variant: a chain of roles, not a panel.** A second strategy, under its own model name (`capitoline-critique` or similar), where the members do different jobs instead of the same one: one drafts, one attacks the draft, one rewrites from both. It answers a different question than the panel does — "how do I improve this answer" rather than "which answer is best" — and it deliberately gives up the anonymous ranking, which only works while the members are symmetric and their answers comparable. Worth measuring against the panel on the same prompts before deciding which one becomes the default; the panel ships first because the ranking is the part with published calibration behind it. Roles stay decoupled from models, as the member list already is.

**Antigravity text rate limits.** The same "reports success but the error is in the text" pattern, now confirmed and handled for image generation, may also occur for text output — verify this and, if confirmed, call `detectQuotaExhausted` (`src/providers/errors.ts`, already written for the image path) from the text path of `CliProvider.execute()` too.

**Real error fixtures.** Capture real fixtures (expired token, exhausted window) for all three CLIs, recorded when the conditions actually occur rather than synthesized. One is now in: `test/fixtures/antigravity/image-429.jsonl`, the image quota refusal captured on 2026-09-21. Still synthetic: every expired-token case, and the text-side window for all three.

**Two-container pod shape.** Gateway and runner as separate containers in one pod, communicating over a local socket, as the clean alternative to running sudo inside a single container.

## Shipped

**Antigravity image generation — done (2026-09-21).** `POST /v1/images/generations` and the MCP tool `generate_image`, served by models declared `kind: image`. The silent 429 (the run reports SUCCESS and hides the refusal in a tool step) is detected from the tool event's raw JSON by `detectQuotaExhausted`, and the absolute reset instant the provider returns becomes the provider pause — never an assumed five hours, because the longer of the two windows resets in days. The image itself never reaches the sandbox: it is collected out of the CLI's own home by `scripts/capitoline-collect-image` through sudo and gated on `image.min_bytes` as a second line of defence against a truncated or placeholder file. Findings in `docs/spike-2026-09.md` §8, install steps in `docs/deploy.md` §7.1, both fixtures real. Left as it is by design: `size` is accepted and ignored, since the CLI's tool has no size parameter. Image quota state done (2026-09-21): `UsageStore.imageWindow` counts the successful generations of the 5-hour window, `image.quota_per_window` supplies the limit, and `/health` exposes `imageQuota` (`/v1/models` shows `used` and `limit` for the image models still available). Only the short window is countable locally, and only as a lower bound; the longer one stays known only from the reset instant a refusal carries, reported by `/health` and by the MCP `list_models` tool.
