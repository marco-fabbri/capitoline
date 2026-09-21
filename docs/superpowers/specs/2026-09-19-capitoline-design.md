# Capitoline — Phase 1 design

Date: 2026-09-19
Status: approved section by section in conversation; amended 2026-09-20 with spike results (see `docs/spike-2026-09.md`)

## 1. Purpose

Capitoline is a self-hosted personal AI gateway. It exposes an OpenAI-compatible HTTP API and an MCP server, and behind them it runs the official Claude Code, Codex and Antigravity (`agy`, Google's successor to Gemini CLI) CLIs, authenticated with the owner's personal subscriptions (Claude Max, ChatGPT Pro, Google AI Pro). Personal apps (for example FoodBrain) and Claude Code itself talk to a single private endpoint instead of integrating three providers.

Phase 1 (this document): gateway to single models.
Phase 2 (only sketched here): council, i.e. deliberation between several models with a judge.

### Out of scope for phase 1

- Council (phase 2).
- Multi-turn conversations with persistent CLI sessions. The OpenAI protocol sends the whole history on every request and the gateway flattens it into the prompt: "free" memory for short chats, no CLI-side sessions.
- `/v1/responses`, `tools`/function calling, `n > 1`, `logprobs`.
- Providers through paid APIs, Ollama, vLLM. The Provider abstraction allows them; no adapter until there is a use.
- Automatic blocking when subscription budgets are exceeded (see §7.1).

## 2. Names

- **Capitoline**: the project, the systemd service, the repository.
- **`capitoline`**, **`capitoline-fast`**, **`capitoline-fast-2`**: the virtual council models (phase 2). Convention `<strategy>[-variant][-version]`. The unnumbered name is the latest stable version; a version number appears when the behavior of a name already in use changes.
- **`capitoline`**: also the name of the proprietary field added to responses (council member details and rankings, warnings).
- Single models keep descriptive names, prefixed by provider: `claude-opus`, `claude-sonnet`, `claude-haiku`, `codex-gpt-6-astra`, `codex-gpt-5.5`, `agy-gemini-pro`, `agy-gemini-flash`, `agy-claude-opus`. The list lives in `config/capitoline.yaml`. Note that Antigravity also serves Claude and GPT-OSS models under the Google subscription.
- Internal modules have descriptive names (`server`, `mcp`, `core`, `providers`, `runner`, `usage`, `council`). No lore names in code.
- Public host: `api.example.com` (a single subdomain level: Cloudflare's free certificate covers `*.example.com` but not two levels).

## 3. Constraints and accepted risks

### 3.1 Provider terms of service

The CLIs are used **as processes**, through their official non-interactive commands. The gateway does not read, copy or reuse the CLIs' OAuth tokens. This is an architectural constraint, not just a policy: the adapters have no access to the credential files (see §9, separate users).

Verified 2026-09-20 (sources in `docs/spike-2026-09.md` §1):

- Anthropic: OAuth tokens from Pro/Max may be used only in Claude.ai and Claude Code; `claude -p` is Claude Code. The June 2026 plan to bill `claude -p` from a separate credit pool was paused: it still draws from the subscription limits.
- OpenAI: ChatGPT Plus/Pro include Codex CLI. Docs recommend API keys for CI and treat `auth.json` as a password, but do not forbid ChatGPT-login automation.
- Google: AI Pro gives `agy` a 5-hour quota with a weekly cap. Headless use is documented only with a paid API key; subscription auth uses the OS keyring, which is the main deployment risk (§9).

Mitigations: personal volumes, usage counter (§7.1), Provider abstraction that allows replacing a CLI adapter with an API-key one without touching the rest.

No multiple accounts of the same provider. Account pools violate explicit clauses (sharing, circumventing limits, resale) and lead to bans.

### 3.2 The CLIs are agents

Claude Code, Codex and Antigravity can read files, run commands, browse the web and write to disk. In the gateway they are **always** launched through the runner (§8.4): tools disabled, empty temporary directory per request, unprivileged Linux user, timeout, termination if the client disconnects. Adapters never call `spawn` directly.

### 3.3 The CLIs change

Flags, model names and output formats change almost monthly. Everything that depends on them lives in the configuration file, not in code. CLIs are updated by hand, followed by the smoke test (§10). Never auto-updated.

## 4. Hosting

Capitoline targets **any Debian or Ubuntu host**: a VM on Nutanix AHV, a Proxmox LXC, a bare-metal box. The runbook is written for the distribution, not for a hypervisor; the owner's first deployment is an unprivileged LXC on Proxmox.

- **Host**: Debian 13 or Ubuntu 24.04, 2 vCPU, 4 GB RAM, 20 GB disk. If it is a container, unprivileged, because the processes receive input from the internet.
- **Two natures, two deployment shapes.** With the subscription CLIs (this spec) the deployment needs persistence: refreshed credentials on disk, a keyring for Antigravity, two Linux users. That is a host, or a single-replica StatefulSet with a persistent volume, one container with both users (`allowPrivilegeEscalation` on, because sudo is one), `cloudflared` as a sidecar. With self-hosted API providers only (an OpenAI-compatible adapter for the platform, Ollama, vLLM; phase 2 backlog) the process is stateless and runs anywhere, including Kubernetes/NKP next to the platform. Heroku-style ephemeral platforms fit only the second shape. Pay-per-use public APIs are excluded by the owner's rule.
- **Cloudflare Tunnel** (`cloudflared` as a service in the LXC) to `localhost:8080`. No inbound ports open. The tunnel creates the DNS record `api.example.com` in the zone already on Cloudflare.
- **Cloudflare Access**, free Zero Trust plan. Two policies: email login for the owner (browser), service token for apps and for Claude Code.
- **The gateway verifies the Access JWT** on every request (`Cf-Access-Jwt-Assertion`), before the body is read. Anyone reaching port 8080 from inside the Proxmox network without going through Cloudflare is rejected. The one deliberate exemption is `GET /health`, which is unauthenticated so that local monitoring on 127.0.0.1 works without a service token; it only reports cached state, never reaches a CLI and names no caller. The per-caller usage breakdown is `GET /v1/usage`, behind Access, because on a host that also runs the `runner` user "anyone who can reach 127.0.0.1:8080" is not the owner alone. On the corporate Proxmox the network is not the owner's: twenty lines of verification are worth the guarantee.
- Alternatives evaluated and discarded: Cloudflare Workers (no processes or filesystem), Cloudflare Containers (ephemeral, paid plan, refreshed tokens lost on restart), Oracle Cloud Always Free (valid as plan B), Fly/Railway/Render (free tiers gone or sleeping).
- Note for reuse by a company: same Tunnel + Access scheme on separate account and zone. Cloudflare's "subdomain setup" (a subdomain as its own zone) is Enterprise only; two-level hosts need Advanced Certificate Manager (10 $/month) or a single-level host.

## 5. System structure

A single Node process in TypeScript. No microservices: on a single machine they would add network and failure points. Layer separation lives in folders, with one-way dependencies downward.

```
capitoline/
  config/
    capitoline.yaml       providers, models, effort, limits, budgets
  src/
    server/               OpenAI-compatible HTTP: /v1/models, /v1/chat/completions, /health
    mcp/                  MCP over streamable HTTP: /mcp
    core/                 neutral internal request, provider registry, router, health state, queue
    council/              phase 2
    providers/            Provider interface + claude.ts, codex.ts, gemini.ts
    runner/               the only place that launches processes: sandbox, user, timeout, cleanup
    usage/                SQLite: tokens, calls, 5h/7d windows, budgets
  test/
    fixtures/             real recorded CLI outputs
    fake-cli/             executable fake CLI for integration tests
  docs/
```

Rules:

- `server` and `mcp` translate their protocol into calls to `core` and back. They do not know what a CLI is.
- `core` receives a **neutral internal request** (messages with roles, model, effort, binary attachments) and routes it. It is a library with no transport dependencies: a third transport plugs in without refactoring.
- `providers` know neither the OpenAI protocol nor MCP.
- `runner` is the only module that executes processes.
- `usage` uses SQLite (not JSON files): costs nothing extra and usage can be queried.

## 6. API

### 6.1 OpenAI-compatible HTTP

Declared subset. Rule for edge cases: **reject explicitly what cannot be honored; ignore with a warning only style parameters**.

`GET /v1/models`: list of models **available right now** (declared in configuration and verified by `health`, §6.4). Standard field `owned_by` = provider name for singles, `capitoline` for councils.

`POST /v1/chat/completions`:

| Field | Handling |
|---|---|
| `model` | required; unknown or unavailable → 404 |
| `messages` | `system` → CLI system-prompt flag; `user`/`assistant` flattened into the prompt with role markers; image parts (`image_url` base64) → temporary files, paths passed to the CLI |
| `reasoning_effort` | `low`/`medium`/`high`, translated per provider by the table in configuration; unsupported level → approximated to the nearest, never rejected |
| `stream` | SSE; provider without streaming → a single final chunk |
| `temperature`, `top_p`, `max_tokens` | accepted and ignored; header `X-Capitoline-Ignored: temperature,top_p` |
| `response_format` JSON | per-provider support according to spike results; unsupported → 400 |
| `tools`, `tool_choice`, `n > 1`, `logprobs` | 400 with a message naming the field |

Response: standard format with `usage` (tokens from the CLI when available) plus the proprietary `capitoline` field (warnings; in phase 2 council details). OpenAI clients ignore unknown fields.

`GET /health`: process and provider state, without consuming subscription (reads the `health` cache). The one unauthenticated route (§4), so it carries nothing that names a caller.

`GET /v1/usage`: the last 24 hours grouped by caller — the email of a user token or the name of a service token — busiest first, the gateway's own health probes excluded. Authenticated like the rest of `/v1`: it is the one report that names people.

### 6.2 MCP

Same process, `/mcp` endpoint, streamable HTTP transport. Claude Code registers it as an HTTP server with the Access service token headers. Discarded: a local stdio server on the Mac, a second program to install that gives nothing more.

Phase 1 tools:

- `list_models`: available models with health state.
- `ask_model(model, prompt, effort?, attachments?)`: text and tokens consumed.

`ask_council` arrives with phase 2. `compare_answers` and `review_answer` are not exposed: they are council cases.

Non-obvious obligations:

- **Progress notifications** during execution, because a call to Opus with high effort exceeds Claude Code's default tool timeout. The installation docs explain how to raise the timeout on the Claude Code side.
- **Recursion** (Claude Code → gateway → Claude Code): allowed, visible in `usage`, documented as double consumption.

### 6.3 Neutral internal request

```
InternalRequest {
  model: string
  messages: { role: "system" | "user" | "assistant", text: string }[]
  effort?: "low" | "medium" | "high"
  attachments?: { mime: string, bytes: Buffer }[]
  stream: boolean
}
```

### 6.4 Available models: declared plus verified

Spike result: Claude answers `/model` in `-p` mode with its alias list, and `agy models` prints a list; Codex has no list command. Discovery is therefore possible for two of three, but the declared list stays the source of truth for phase 1 (it also carries the public name and effort mapping). Therefore:

- the configuration file declares the models per provider (source of truth);
- each provider's `health()` verifies at startup and hourly, with a minimal request on the cheapest model, that the provider responds;
- a failing model/provider is marked unavailable and disappears from `/v1/models` until the next check;
- the `health` cache is invalidated immediately if a real request fails with `auth_expired`;
- `/v1/models` reads the cache, never the CLI.

## 7. Request flow (direct case)

1. Cloudflare: Access verifies token/login, the tunnel delivers to the server.
2. `server`: verifies the Access JWT; validates the body; immediate 400 on fields that cannot be honored; builds the internal request (attachments decoded).
3. `core`: looks the model up in the registry (404 if absent/unavailable); finds the provider; checks `concurrencyLimit`; if saturated, queues with a configurable maximum wait, then 503 + `Retry-After`.
4. `providers/<x>`: builds the command (system prompt in the dedicated flag, flattened messages, effort from the table, attachment paths).
5. `runner`: empty temporary directory, execution as `runner` with tools disabled and timeout; termination if the client disconnects; directory cleanup always, even on error.
6. `providers/<x>`: reads the CLI's JSON output as a stream of events; extracts text and tokens; normalizes errors into the five kinds (§8.2).
7. `usage`: records provider, model, tokens, duration, outcome.
8. `server`: OpenAI response (or SSE chunks), errors mapped to HTTP (§8.3).

### 7.1 Queue, limits, budgets

Three lines of defense against subscription rate limits (5-hour and weekly windows, opaque):

1. **Concurrency per provider**: in-memory queue, initial limits Claude 2, Codex 1, Antigravity 1. Configurable maximum wait, then 503. Queued requests are lost on restart: the client gets a connection error and retries.
2. **Real or indicative budget per window.** Claude Code reports the real subscription windows in every `stream-json` run (`rate_limit_event` with 5-hour and 7-day utilization and reset times); `usage` stores the latest values and exposes them. For Codex and Antigravity the windows are opaque, so configuration holds an indicative token budget. When a window is exhausted or a budget exceeded the gateway **does not block**: it marks the provider "over budget" in `/v1/models`, `/health` and the logs. No automatic blocking: blocking on a wrong estimate would deny a paid service.
3. **Pause on real rate limit**: on `rate_limited` the provider is paused with backoff from 1 to 30 minutes; queued requests get 429 immediately; when the pause ends the first request acts as a probe.

## 8. Providers and runner

### 8.1 Interface

```
interface Provider {
  id: "claude" | "codex" | "antigravity"
  models(): ModelSpec[]                       // from configuration
  concurrencyLimit: number                    // from configuration
  execute(req: InternalRequest, sandbox: Sandbox): AsyncIterable<ProviderEvent>
  health(): Promise<HealthStatus>
}

ProviderEvent =
  | { type: "text", delta: string }
  | { type: "done", usage?: { input: number, output: number } }
  | { type: "error", kind: ErrorKind, detail: string }
```

`execute` always returns a stream of events, even for providers without streaming (a single `text` event then `done`): a single code path in the server.

Differences between adapters are confined to three points: command construction, output parsing, error recognition.

### 8.2 Typed errors

`auth_expired`, `rate_limited`, `timeout`, `cli_crashed`, `bad_output`. Each adapter maps its CLI's messages onto these five. `server`, `mcp` and `council` reason only about these.

### 8.3 Error → HTTP map

| Error | HTTP | Side effect |
|---|---|---|
| `auth_expired` | 503 | model unavailable, health cache invalidated |
| `rate_limited` | 429 + `Retry-After` | provider paused |
| `timeout` | 504 | process killed, sandbox cleaned |
| `cli_crashed` | 502 | stderr in logs, never in the response |
| `bad_output` | 502 | raw output in logs |
| unknown/unavailable model | 404 | |
| queue full / wait expired | 503 + `Retry-After` | |
| field that cannot be honored | 400 | message naming the field |
| Access JWT missing/invalid | 401 | |

CLI stderr never goes to the client: it may contain paths, users, machine configuration.

### 8.4 Runner (sandbox)

For each execution:

- a new, empty temporary directory as working directory (the CLIs read context from the cwd: it must be empty);
- attachments written inside it, paths passed to the CLI;
- execution as user `runner` through `sudo` limited to the CLI binaries only;
- CLI tools disabled with each CLI's flags, verified in the spike: Claude `--tools "" --strict-mcp-config --disable-slash-commands --setting-sources ""`; Codex `-s read-only -c features.shell_tool=false -c web_search="disabled" --ignore-user-config --ephemeral`; Antigravity has no flag, so the `runner` user's `settings.json` sets `toolPermission: "strict"`, `enableTerminalSandbox: true`, `allowNonWorkspaceAccess: false`, which makes any tool call stall until our timeout kills it;
- prompt written to stdin for all three (Codex `exec -`; Antigravity `--input-format stream-json` with a `{"event":"user","message":{...}}` line); stdin is always either written or closed, because Codex blocks reading a non-TTY stdin;
- the runner's own timeout is the only reliable one: Antigravity's `--print-timeout` does not fire on a stalled tool call;
- per-request timeout from configuration; on expiry SIGTERM then SIGKILL;
- process termination if the client disconnects;
- directory removal in `finally`, always; the wait for the stdio pipes to reach EOF is bounded by one `kill_grace_s` after the process's own exit, because a helper the CLI spawned can inherit stdout and hold the pipes open after the CLI is killed, which would otherwise postpone the removal — and the completion of the request — for ever;
- at startup, a sweep of `sandbox_root` removes the `run-*` directories older than the longest `timeout_s` plus twice `kill_grace_s`, i.e. the ones a previous process was killed before removing.

### 8.5 Configuration (shape)

```yaml
server:
  port: 8080
  access:
    team_domain: <team>.cloudflareaccess.com
    audience: <aud of the Access app>
providers:
  <id>:
    binary: <executable>
    concurrency: <n>
    timeout_s: <s>
    budget: { window_5h_tokens: 0, window_7d_tokens: 0 }   # 0 = not declared
    health_model: <public model name used by health()>
    models:
      <public name>: { cli_model: <alias passed to the CLI>, effort_suffix?: bool, efforts?: [..] }
    effort: { low: <v>, medium: <v>, high: <v> }
    model_flag: <flag>                     # required;  <flag> <cli_model>
    effort_flag: <flag> | null             # required; null = the CLI has no effort flag
    effort_key: <key> | null               # required; set = <flag> <key>="<value>" (Codex)
    args: [<fixed sandbox and output flags>]
    system_prompt_flag: <flag> | null      # null = prepended to the prompt with a role marker
    prompt_via: stdin
```

The real file with verified values for the three CLIs is `config/capitoline.yaml`. Antigravity encodes effort in the model id (`gemini-3.8-flash-low`), hence `effort_suffix`. The three flag keys have no default: a deployed file that predates them fails validation naming the missing key, rather than inheriting a default and building a command line nobody verified.

## 9. Deployment on the host

**Separate Linux users:**

- `capitoline`: owns code, configuration, SQLite database, systemd service. It is the user of the exposed process.
- `runner`: runs the CLIs. Owns the credentials of the three subscriptions, in files readable only by it. `sudoers` lets `capitoline` run only the CLI binaries as `runner`.

Effect: a bug in the web server does not expose the tokens, because they belong to another user; and it is `sudoers`, not code, that limits what the runner can launch.

**CLI authentication**, once, by hand, as `runner`:

- Claude: long-lived token from `claude setup-token`, in a service environment variable (not in the configuration file, not in the repo).
- Codex: device login, code confirmed from the Mac.
- Antigravity: over SSH the CLI prints a URL; sign in on the Mac, paste the code back. Credentials go to the Linux Secret Service keyring, which a headless host lacks by default: run `gnome-keyring-daemon` headless for `runner`, persisted across reboots. No API-key fallback: the owner's rule is no pay-per-use API for any provider. Settled during deployment; see `docs/spike-2026-09.md` §2.

**Service**: systemd, `Restart=always`, logs to journald. Node LTS from NodeSource. CLIs installed globally with npm, updated by hand followed by the smoke test.

**Cloudflare**: `cloudflared` as a service; tunnel to `localhost:8080`; Access with email + service token policies; JWT verification in the gateway.

**Backup**: daily, of `config/capitoline.yaml` and the SQLite database, to the Mac or a bucket. CLI credentials are **not** backed up: if lost, log in again; a token backup is one more risk.

**Network**: no inbound ports. Outbound only, to Cloudflare and the providers.

## 10. Tests

- **Unit, without CLIs**: adapters tested with real recorded outputs in `test/fixtures` (command built for every model/effort combination, output parsing, recognition of the five errors from real messages); server tested with an in-memory fake provider (valid/invalid requests, error map, SSE).
- **Integration, with an executable fake CLI** (`test/fake-cli`): same flags, output in the right format, simulates slowness, crash, rate limit, corrupted output. Covers runner, sandbox, timeout, termination on client disconnect, cleanup, queue, provider pause, JWT verification.
- **Smoke test, with real CLIs**: one call per provider with the cheapest model. By hand, after every CLI update, never on every commit. Catches the flag and format changes fixtures cannot see. Mandatory step in the update procedure in the README.
- **Not tested**: the quality of model answers.

Fixtures age: the smoke test is the countermeasure.

## 11. Initial spike

Done 2026-09-20 on the Mac for items 1 and 3 to 9; results in `docs/spike-2026-09.md` and `config/capitoline.yaml`, raw outputs in `test/fixtures/`. Item 2 and the open items listed in that document need the LXC. Original checklist:

1. **Terms of service** provider by provider: what they say today about headless subscription use and automation. Outcome: proceed / proceed with limits / replace adapter.
2. **Headless login** of the three CLIs as user `runner`: actual procedure, where credentials end up, file permissions.
3. **Real flags** for: non-interactive mode, model, effort, system prompt, JSON/event output, tool disabling, image attachments. Version of each CLI noted.
4. **Model list**: is there a command? Do `/model` or `/models` respond in headless mode?
5. **Streaming** in headless mode for each CLI.
6. **Structured output** (`response_format`) for each CLI.
7. **Real error messages** for expired token and rate limit, captured as fixtures.
8. **Use of cwd**: confirm that with an empty directory the CLI reads nothing external.
9. **Reference**: reading of `0xDarkMatter/conclave` (Go, MIT) for how it invokes the same CLIs, without forking.

Items 3 to 8 can be done on the Mac, where the CLIs are already authenticated; only item 2 needs the LXC.

## 12. Phase 2 sketch (not part of this spec)

Council as virtual model `capitoline`, initial strategy from karpathy/llm-council: independent answers in parallel → anonymous peer review with ranking (labels `Response A/B/C`, JSON output instead of regex) → synthesis by a configurable judge. Members and judge in configuration; failed member → council continues and declares it in the `capitoline` field. Same per-provider queue. MCP tool `ask_council`. Variants (`-fast`, revision stage) only after measuring consumption and quality of the first.

## 13. Decisions taken and alternatives discarded

| Decision | Discarded alternative | Why |
|---|---|---|
| CLIs as processes | reuse of OAuth tokens | forbidden by Anthropic, actively blocked |
| Debian/Ubuntu host + Tunnel | Cloudflare Workers/Containers | no processes / ephemeral |
| OpenAI-compatible API, subset | custom API | loses Open WebUI, SDKs, LiteLLM |
| No multi-turn sessions | mapping CLI sessions | not needed by the council; fragile |
| Build from scratch, reading Conclave | fork of Conclave | it is a Go TUI without HTTP; single-stage council |
| MCP over HTTP in the same process | local stdio server | second program without benefits |
| Declared + verified models | dynamic discovery | only two of three CLIs expose a list; config also carries names and effort mapping |
| Indicative budget without blocking | automatic blocking | opaque limits, blocking on a wrong estimate |
| Descriptive names in code | lore names for every module | friction for readers |
| `api.example.com` | `api.capitoline.example.com` | two levels = 10 $/month certificate |
| SQLite for usage | JSON files | queryable |
| Separate `runner` user | single user | the exposed process cannot read tokens |
