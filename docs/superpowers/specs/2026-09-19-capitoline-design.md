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
- Providers through paid APIs or self-hosted inference servers. The Provider abstraction allows them; no adapter until there is a use.
- Automatic blocking when subscription budgets are exceeded (see §7.1).

## 2. Names

- **Capitoline**: the project, the systemd service, the repository.
- **`capitoline`**, **`capitoline-fast`**, **`capitoline-fast-2`**: the virtual council models (phase 2). Convention `<strategy>[-variant][-version]`. The unnumbered name is the latest stable version; a version number appears when the behavior of a name already in use changes.
- **`capitoline`**: also the name of the proprietary field added to responses (council member details and rankings, warnings).
- **A single model's name is `<door>-<model>`**, and each half carries one fact. The **door** is the CLI the request goes through, named after the product: `claude` (Claude Code), `codex`, `antigravity`. The **model** is what that door calls it: `opus`, `gpt-6-astra`, `gemini-pro`. So `antigravity-claude-opus` is Claude Opus reached through Antigravity, and `claude-opus` is the same lineage through Claude Code — two doors, two subscriptions, two quotas, and the prefix is the only thing that tells them apart. The list lives in `config/capitoline.yaml`.

  The door is **not** the model's maker. A prefix of `anthropic-` or `google-` would say nothing `claude-` and `gemini-` do not already say, and it would collapse the one distinction the name exists to draw: both Claude Opus entries would become `anthropic-claude-opus`.

  The door is **not** the binary either, although for two of the three they are the same word. `claude` and `codex` are both the product and the command; Antigravity's command is `agy`. The models were called `antigravity-*` on 2026-09-23, after being `agy-*` since the beginning: the exception was invisible while it only touched the one provider whose two names differ, and it cost three rounds of conversation to work out what the rule had ever been. The prefix now also matches the provider id `/health` and `/v1/usage` report, which is a consequence and not the reason.

  Antigravity serves Claude and GPT-OSS models as well as Gemini under the Google subscription, which is why its prefix cannot be `gemini-`.
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

Capitoline targets **any Debian or Ubuntu host**: a VM on Nutanix AHV, a Proxmox LXC, a bare-metal box. The runbook is written for the distribution, not for a hypervisor; the first deployment is an unprivileged LXC on Proxmox.

- **Host**: Debian 13 or Ubuntu 24.04, sized by §4.1 — 4 vCPU and 8 GB RAM for the shipped concurrency of ten runs per CLI — and 20 GB disk. If it is a container, unprivileged, because the processes receive input from the internet.
- **Persistence.** With the subscription CLIs (this spec) the deployment needs persistence: refreshed credentials on disk, a keyring for Antigravity, two Linux users. That is a host, or a single-replica StatefulSet with a persistent volume, one container with both users (`allowPrivilegeEscalation` on, because sudo is one), `cloudflared` as a sidecar. Heroku-style ephemeral platforms do not fit: the credentials must survive a restart. Pay-per-use public APIs are excluded by the owner's rule.
- **Cloudflare Tunnel** (`cloudflared` as a service in the LXC) to `localhost:8080`. No inbound ports open. The tunnel creates the DNS record `api.example.com` in the zone already on Cloudflare.
- **Cloudflare Access**, free Zero Trust plan. Two policies: email login for the owner (browser), service token for apps and for Claude Code.
- **Two identities, and the gateway verifies both before the body is read** (2026-09-27; until then the Access JWT was the only one). A key the gateway issued itself, `Authorization: Bearer cap_…`, stored as its sha256 in the usage database and managed through `/v1/admin/keys` by the callers named in `server.access.admins` (or `npm run keys` on the host, for the first one): the identity that needs no Cloudflare, and the one recommended to applications either way, since the header is the one every OpenAI client sends. And **the Access JWT** (`Cf-Access-Jwt-Assertion`) when a team domain is configured, whose service tokens are bound to a name by `server.access.callers` or at run time by `PUT /v1/admin/callers/<id>`. A request carrying one of our keys is judged on the key alone. With neither Access configured nor a key issued the gateway is open — a developer machine — and the first key closes it; the startup log says which state holds. Anyone reaching port 8080 from inside the Proxmox network without going through Cloudflare is rejected. The one deliberate exemption is `GET /health`, which is unauthenticated so that local monitoring on 127.0.0.1 works without a service token; it only reports cached state, never reaches a CLI and names no caller, and since 2026-09-30 it reports that state only to the host itself (the loopback, with no proxy header saying the request was forwarded) or to a caller with a key, and `{"ok":true}` to anyone else. **OAuth, for the MCP clients that cannot hold a key** (2026-09-30): Claude on the web signs in with OAuth only, so the gateway is its own authorization server (the MCP SDK's, `server.oauth.public_url`), and signing in is pasting one of its keys; the tokens are bound to that key's name, die with it, and are good for `/mcp` alone. The keys stay the identity, OAuth only stands in for one where it cannot be carried. The per-caller usage breakdown is `GET /v1/usage`, behind Access, because on a host that also runs the `runner` user "anyone who can reach 127.0.0.1:8080" is not the owner alone. On a network shared with others the network is not the owner's: twenty lines of verification are worth the guarantee.
- Alternatives evaluated and discarded: Cloudflare Workers (no processes or filesystem), Cloudflare Containers (ephemeral, paid plan, refreshed tokens lost on restart), Oracle Cloud Always Free (valid as plan B), Fly/Railway/Render (free tiers gone or sleeping).
- Note for reuse by a company: same Tunnel + Access scheme on a separate account and zone. Cloudflare's "subdomain setup" (a subdomain as its own zone) is Enterprise only; two-level hosts need Advanced Certificate Manager (10 $/month) or a single-level host.

### 4.1 Sizing a host

Every request is a whole CLI process run by the `runner` user, so what a host must hold is the number of runs that can be in flight at once times what one run costs. `providers.<id>.concurrency` caps the first per CLI; the second is measured. Concurrency is a question of the host's capacity and not of the subscriptions: runs in parallel spend the same quota as the same runs one after another, only sooner.

**What one run costs**, measured on the owner's host with `scripts/measure-cli-resources.py`, which sums each run's whole process tree (a CLI's helpers are part of its cost — Codex runs as a Node wrapper of about 36 MB around a native binary of about 78 MB). Two loads: light, on 2026-09-23 (one-line questions, ~800-word answers at high reasoning, one image), and the heaviest the gateway produces, on 2026-09-27 — fourteen council deliberations back to back, 93 CLI runs, the three CLIs answering and ranking in parallel. The peaks are the second load's, except Codex's, which was highest generating an image.

| CLI (version) | Peak memory, one run | CPU per run | Wall time per run | `memory_mb` |
|---|---|---|---|---|
| `claude` (2.1.280) | 191–214 MB | 1.1–2.1 s | 3–27 s | 250 |
| `codex` (0.156.0) | 112–118 MB; 147 MB generating an image | 0.3–0.5 s | 6–41 s | 150 |
| `agy` (1.2.9) | 214–256 MB | 0.5–5.3 s | 7–86 s | 300 |

With no CLI running the host uses about 140 MB: the gateway (~90 MB idle, 101 MB at its peak through the fourteen deliberations), `cloudflared` (~30 MB) and the runner's resident services — its systemd instance and the keyring Antigravity needs (~25 MB together). That is `server.memory_mb`, 150.

**Memory** is the constraint. The worst case is every slot busy at once:

`RAM ≥ server.memory_mb + Σ over providers (concurrency × memory_mb)`

With ten runs per CLI that is 150 + 10 × (250 + 150 + 300) = 7,150 MB, so the shipped configuration wants an **8 GB** host: the remainder is the kernel, the page cache the CLIs' binaries are read from, and room for a CLI update that grows. Swap is not headroom — a CLI paged out mid-answer is a timeout. Past the limit the kernel kills a process, and the client sees a CLI that crashed. The gateway does this arithmetic at startup (`src/sizing.ts`) against the memory it can actually use — the smallest cgroup `memory.max` above it, else the machine's total, which in an LXC container is the container's — and logs a warning when the configuration does not fit. A warning and not a refusal: every slot of every provider busy at the same moment is a worst case an operator may decide to accept, but not one to be surprised by.

**CPU** is not the constraint. A run spends most of its life waiting on the provider's servers: over its whole duration it uses between a hundredth and a tenth of a core. The cost is at start-up, when a Node CLI loads — a short `claude` run spends 1.1 s of CPU in 2.8 s — so thirty runs starting in the same second would queue on two cores for a few seconds, and 4 vCPU keep that out of the latency.

**Disk** does not grow with load. A run's sandbox directory stays under 1 MB and is removed after it; the CLIs' own session state in the runner's home grew by 0.3 MB over ten runs and by 4.8 MB over the 93 runs of the council load (Codex runs `--ephemeral`; the growth is Claude's and Antigravity's session logs, about 50 KB a run). What takes space is the CLIs themselves, about 1 GB in the runner's home.

**When to measure again**: after every CLI update (`docs/update-clis.md`), since a new version can grow, and whenever a provider is added. The figures and `memory_mb` are configuration because they change with the CLIs, not with the gateway.

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

`GET /v1/usage`: the last 24 hours grouped by caller — the email of a user token, the bound name of a service token, or a key's own name — busiest first, the gateway's own health probes excluded. Authenticated like the rest of `/v1`: it is the one report that names people.

`/v1/admin` (2026-09-27), for the callers named in `server.access.admins`, 403 for everyone else: `POST /keys {name}` issues a key and returns it once (201); `GET /keys` lists names, dates and last use, never a hash; `DELETE /keys/:name` revokes without deleting, so usage rows keep their name; `PUT /callers/:id {name}` and `GET /callers` bind and list the names of Cloudflare-identified callers. Nothing in the configuration file is written from here: keys and names are state, and the file stays the source of truth for everything else (§8.5).

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

1. **Concurrency per provider**: in-memory queue, ten runs per CLI, sized from the host's memory (§4.1) and not from the subscription. Configurable maximum wait, then 503. Queued requests are lost on restart: the client gets a connection error and retries.
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
    callers: { <client id>: <name> }       # what to call a service token in /v1/usage
    admins: [<caller name>]                # who may use /v1/admin; never a key itself
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
    system_prompt_flag_prefix: <flag> | null  # required; set = <prefix> <flag>="<text>" (Codex), null = <flag> <text>
    prompt_via: stdin
serve:                                     # optional; absent = everything declared
  providers: [<id>]                        # closed: a provider added later stays out
  councils: [<name>]
```

The real file with verified values for the three CLIs is `config/capitoline.yaml`. Antigravity encodes effort in the model id (`gemini-3.8-flash-low`), hence `effort_suffix`. The four flag keys have no default: a deployed file that predates them fails validation naming the missing key, rather than inheriting a default and building a command line nobody verified.

`serve`, which only a host's overlay sets, narrows what that host serves. It is applied when the configuration is loaded, before anything else reads it, so a provider left out is never built, probed or listed, and a council that stays is checked on the chains that remain (docs/deploy.md §7). The lists name what is in rather than what is out, so that a provider or a council the repository adds later does not appear on a host that chose a subset; a council that trimming leaves with fewer than two seats or no judge is refused, not dropped, because dropping it would answer a client's request for it with a 404 nobody decided.

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

## 12. Phase 2: the council

Design settled 2026-09-22. The council is a virtual model, `capitoline`, served by the same endpoints as every other: a client asks for it in `model` and receives an ordinary completion, or calls the MCP tool `ask_council`.

### 12.1 Three stages, nine calls

The strategy is karpathy/llm-council's, with the changes noted below:

1. **Independent answers.** Every seated member answers the same question, in parallel.
2. **Anonymous peer ranking.** Each member receives every answer labelled `Response A`, `B`, …, its own among them and named as its own, and ranks them all. The members are anonymous to each other, never to themselves: a model recognises its own prose anyway, and one that is not told which answer is its own rates it highly while believing it is impartial. The reply is JSON against a schema, not prose parsed by a regex.
3. **Synthesis.** A judge, seated separately, writes the final answer from the labelled answers and the aggregate ranking.

Four seats is the default: nine calls, one per answer, one per ranking, one for the synthesis. The members run in parallel only if every provider offers one concurrency slot per seat it serves: one seat per family buys independent judgment (§12.2), not a free queue, and a family is not a provider. The default seats put Google and open weights on the same Antigravity subscription, so that provider needs one slot per seat it serves. In the shipped file `providers.antigravity.concurrency` is `10`, sized from memory (§4.1); what the councils set is its floor, the largest council the provider sits in — two seats, in both shipped councils — and never the sum over the councils; with one slot, the second of those members would sit on that provider's queue until `server.queue.max_wait_s` and lose its seat, in both parallel stages.

### 12.2 Seats are families with a fallback chain

A seat declares a family and an ordered list of models, not a model. Two reasons, both learned the hard way:

- **Quotas run out.** On 2026-09-21 the Fable model was refused while the same subscription answered on Opus and Sonnet. A member list naming a model outright would have broken every deliberation that day.
- **A panel needs independent judgment.** Models of one family share their blind spots, so they fail the same way and rank each other's failures highly. Three Anthropic seats would give one lineage three votes out of four and spend one 5-hour window three times over.

Seating happens in two steps, and both are needed:

- **Before the call**, the seat takes the first model of its chain that the health and quota state reports available. Fable paused until Friday is skipped without spending a call to discover it.
- **After an unforeseen refusal**, the seat steps down the chain once and retries. The first refusal of any window is by definition not in the state yet, so without this a deliberation fails whenever a quota turns over mid-flight; with a single step it cannot cascade through the whole chain.

Default seats: Anthropic, OpenAI, Google, and open weights through `gpt-oss-120b` on Antigravity. Watch for one model reachable through two channels — `claude-opus` and `antigravity-claude-opus` are one opinion in two seats.

### 12.3 The judge

Seated apart from the members and blind, both by default and both configurable (`judge.allow_member`, `judge.blind`). karpathy/llm-council does the opposite on both counts: its chairman is also a member and sees everything at synthesis. Keeping the judge out costs no extra call — the synthesis is a call either way — but it means the best seated model never writes the final answer and that, with one seat per family, the judge is a second model of a family already seated; what it buys is that no synthesizer weighs its own answer. Measured on 2026-09-27 (`docs/measurements/2026-09-23-council/README.md`, addendum): on six questions with four correct members the chairman was as correct as the seat-apart judge and showed no self-preference, so the rule rests on a risk, not on a measured harm. Its worst case was then measured the same day (second addendum): the weakest rung of the Gemini ladder as chairman, wrong on three questions of six, ranked its own answer last each time and synthesized the peers' correct answer each time. Eighteen chairman syntheses, no harm; the rule keeps a certainty, not a likelihood, at the price of the best seated model never writing the final answer. Keeping the judge blind makes the deliberation blind end to end. The transparency is not lost, it moves: the response carries the un-blinded detail.

A judge that fails before writing a word steps down its own chain once: on a refusal, as a seat does, and also on a crash or an empty answer when the next model of the chain is on another provider — eight calls are spent by then, and a crash on another CLI does not repeat itself (2026-09-29). One that fails halfway through cannot step down: the client already has half an answer.

Not configurable: the anonymity of the ranking stage. It is the mechanism the whole design rests on, and an option to disable it would only offer a way to produce a skewed ranking without noticing.

### 12.4 Anonymity that can be reproduced

Labels are assigned by shuffling the members with a seed derived from the question, so two deliberations on the same question pair the same labels with the same seats. A strange result can be repeated and studied. The mapping never appears in any prompt; it appears in the response, after the fact.

### 12.5 What partial failure means

A member that errors or times out is dropped and declared; the deliberation continues with the rest. Below two answers there is nothing to rank: with one, the gateway returns that answer and says plainly that no council took place, rather than dressing a single opinion as a synthesis.

### 12.6 What the client receives

The synthesis is the message content. The `capitoline` field carries the rest: each member with its real model name and its answer, the rankings and their aggregate, which seats fell back and why, which seats were lost, and the token cost. A client that wants only the answer ignores the field, as OpenAI clients do with unknown fields.

While the first two stages run there is nothing to stream token by token, so a streaming request receives progress lines instead — `2/4 answers`, `rankings`, then the synthesis, which does stream as it is written. Over MCP the same states are sent as progress notifications, which is also what keeps Claude Code from abandoning a call that takes minutes.

### 12.7 Accounting

Nine calls are nine rows in the usage table, each under the real model that served it, because quotas belong to those models and not to the council. A deliberation identifier ties them together, so the cost of one question can be summed.

### 12.8 The prompts are the strategy

The three prompts live in the code, not in the configuration: they are not CLI details but the strategy itself. Changing them changes the behaviour, so `STRATEGY_VERSION` is bumped and every `Deliberation` reports it: two runs months apart can then be compared, and a name whose behaviour has moved says so. Keeping the previous strategy on the air beside the new one — `capitoline` answering as before while `capitoline-2` answers the new way — means keeping its prompts in the file and adding a council entry for them, and that is done when a caller has measured something worth preserving rather than on every change. Version 2 (2026-09-22) kept nothing: version 1's only measurement is the one that found the flaw it fixes. Variants come only after the first shape has been measured: the two that ship, and the two that were considered and rejected, are §12.9.

### 12.9 Variants: what is configuration, what is not, and how they are named

The first real deliberation (2026-09-22) cost nine calls and about 90k tokens for one question. That is the right default and the wrong price for everyday use, which is why the model name was versioned from the start. `council:` is a record, one `Council` is built per entry, `Core` registers each as a virtual model by name, and both transports are name-free — `ask_council` already takes a council name. So **seats, judge, quorum and deadline are configuration and no code**: a second council with other seats works today. Only a change to the *sequence of stages*, which is fixed in `deliberate()`, needs the engine.

**Naming.** After the `capitoline-` prefix, a **shape word** says how the council deliberates (`-fast`), a **family name** says who sits (`-gemini`, later `-claude`, `-openai`), and a **number** is a new version of the same shape (`-2`, §12.8). `capitoline` alone stays the reference panel.

**The `ranking` flag.** The one thing that changes the sequence, and therefore the one thing the engine had to learn. With `ranking: false` stage 2 does not run: no ranking calls and no ranking progress events, an empty `rankings` and `aggregate` in the `Deliberation`, and the shape recorded beside them so a reader can tell a fast deliberation from one where every ranking happened to fail. `synthesisPrompt` omits the paragraph that introduces the aggregate rather than showing an empty ranking, so the judge is given the answers with no aggregate to weigh — the one prompt that differs. A four-seat council then costs **five calls** instead of nine. `min_members` keeps its meaning: below it there is still nothing to synthesize. It is a flag and not a strategy object on purpose — exactly one prompt differs, and an abstraction for two strategies is scaffolding that does not pay for itself. It earns its place when the role-chain variant arrives (backlog), which is a genuinely different shape.

**The effort is the shape (2026-09-27).** `reasoning_effort` was ignored for a council until then, on the grounds that its member calls run at each model's configured effort and its prompts are the strategy. Both still hold; what the field now chooses is the *shape*, exactly as it chooses a level for a model: a council configured with `ranking: true` declares `low` and `high`, `low` skips stage 2 for that deliberation and `high` runs it, no effort is `high`, and `medium`, `xhigh`, `max` and `ultra` resolve to the nearer of the two by the same rule a model's effort follows (`nearestEffort`, ties upward). So `capitoline-fast` is `capitoline` at `low`, kept under a name of its own for clients that cannot send the field, as `antigravity-gemini-flash-low` stands next to `antigravity-gemini-flash`: a council configured with `ranking: false` declares no effort and the field is declared ignored for it. The `Deliberation` says which shape ran. Who synthesizes is deliberately *not* a request option: the seat-apart judge is council policy (§12.3), and a client should not be able to move the judge into the council with a field — the 27 September measurement of the chairman is the reason it could have been and was not.

**The shipped variant, and the one that is not shipped.** `capitoline-fast` is the four default families and the same judge without the ranking stage: the everyday shape. A **capability ladder** — one family at three levels, the big model, the small one trying and the small one not trying — answers a different question, "is the cheaper model enough for this task", not "which answer is best": if the three rungs agree, the cheapest would have sufficed. It keeps the ranking, because the blind peer ranking *is* the measurement, and it seats a single lineage three times, knowingly: independent judgment (§12.2) is not what a ladder buys. Its rungs are single models and not chains, for the same reason: a rung that steps down is no longer the rung whose capability was being measured, so a refused rung is a lost seat (§12.5) and, with `min_members: 3`, the ladder does not run at all. Its judge is seated from outside the family, with a chain behind the head so that the first unforeseen refusal of a window does not throw away the six calls already spent, and a strong model at the head: a `claude-haiku` judge shipped a claim none of the rungs had made (§12.8, `docs/backlog.md`). `capitoline-gemini` shipped on 2026-09-22 and was measured on six registered questions (`docs/measurements/2026-09-23-council/`); on 2026-09-23 it was taken out of the shipped file, because a measuring instrument listed in `/v1/models` beside the panels reads as a council to use, and it is not one — three models of one family share their blind spots, at seven calls a question. The ladders live instead in `docs/measure-a-model.md`, three of them — Gemini, Claude, Codex — ready to add to a host's overlay for as long as a measurement runs, and checked against the shipped model tables by the test suite. Documenting all three rather than the one the owner's quotas favoured is deliberate: the gateway is sized for whoever installs it, not for one set of subscriptions.

**Two variants were considered and dropped**, and the reasons are recorded here rather than left in a conversation, because both look cheap on paper and will otherwise be proposed again:

- **Two seats with the ranking kept**, which costs the same five calls as the fast shape. With two members the ranking is one vote each and **cannot break a tie**; the owner's own measurements put two judges in disagreement or deadlock on one pair in three. At that price four seats without a ranking buy four perspectives instead of two, and give up only a mechanism that barely works at that size.
- **A panel that leaves Anthropic out to spare its quota.** If Anthropic has room, using it gives a better answer; if it does not, the seat walks down its chain and, when nothing on it is available, the panel degrades to three by itself (§12.2, §12.5). Handicapping the panel deliberately trades a worse answer now for a maybe-answer later.

## 13. Decisions taken and alternatives discarded

| Decision | Discarded alternative | Why |
|---|---|---|
| CLIs as processes | reuse of OAuth tokens | forbidden by Anthropic, actively blocked |
| Debian/Ubuntu host + Tunnel | Cloudflare Workers/Containers | no processes / ephemeral |
| OpenAI-compatible API, subset | custom API | loses Open WebUI, SDKs, LiteLLM |
| No multi-turn sessions | mapping CLI sessions | not needed by the council; fragile |
| Cloudflare tokens created from the owner's machine (`scripts/cf-service-token.sh`) | the gateway calling Cloudflare's API itself | a credential that can rewrite who may reach the gateway does not belong on the process facing the internet |
| Keys as state in the usage database, issued by the admin API | keys in the configuration file | a key is issued and revoked at run time, and a hash in a file that is copied about is a secret in a file that is copied about |
| Build from scratch, reading Conclave | fork of Conclave | it is a Go TUI without HTTP; single-stage council |
| MCP over HTTP in the same process | local stdio server | second program without benefits |
| Declared + verified models | dynamic discovery | only two of three CLIs expose a list; config also carries names and effort mapping |
| Indicative budget without blocking | automatic blocking | opaque limits, blocking on a wrong estimate |
| Descriptive names in code | lore names for every module | friction for readers |
| `api.example.com` | `api.capitoline.example.com` | two levels = 10 $/month certificate |
| SQLite for usage | JSON files | queryable |
| Separate `runner` user | single user | the exposed process cannot read tokens |
