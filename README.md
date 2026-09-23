# Capitoline

> In the Grand Temple, before the end, Desmond does not find a single voice.
> He finds three: Jupiter, Juno, Minerva. The Capitoline Triad, what remains
> of Those Who Came Before. They do not agree. Minerva asks him to let the
> world burn and start again. Juno asks him to save it, at a price. Jupiter
> has already spoken, and is silent. The answer does not come from consensus.
> It comes from the one who listens to all of them, and then chooses.

Capitoline is a self-hosted personal AI gateway. It exposes an
OpenAI-compatible HTTP API and an MCP server, and behind them it runs the
official Claude Code, Codex and Gemini CLIs, authenticated with the
subscriptions of whoever hosts it. Three voices, one endpoint.

You can give the floor to a single member: `claude-opus`,
`codex-gpt-6-astra`, `antigravity-gemini-pro`, or any other model the three CLIs
serve, since every one of them is exposed by name. Or the `capitoline` model convenes the
Triad: every member answers, every member judges the others without knowing
who wrote what, and a judge synthesizes. As in the Temple, the value is not
in the agreement but in hearing the dissent before deciding.

## Run it

Requirements: Node 24.x (pinned in `.nvmrc`; `engines` is `>=24 <25`), and the CLIs `claude`, `codex`, `agy` installed and logged in for the user that runs them.

    npm ci && npm run build
    node dist/main.js                      # reads config/capitoline.yaml, listens on 127.0.0.1:8080

Connecting another application of your own: `docs/clients.md`, which covers the service token, where the secret goes and what the token may be used for. Production deployment on any Debian/Ubuntu host (a Nutanix AHV VM, a Proxmox LXC, bare metal), with a separate `runner` user and Cloudflare Tunnel + Access: see `docs/deploy.md`. An OpenAI-compatible API adapter (a company inference platform, Ollama, vLLM) is planned next, which also makes a stateless Kubernetes/NKP deployment possible.

## Use it

    curl http://127.0.0.1:8080/v1/models
    curl http://127.0.0.1:8080/v1/chat/completions -H 'content-type: application/json' \
      -d '{"model":"codex-gpt-5.5","reasoning_effort":"low","messages":[{"role":"user","content":"Reply with the single word: ok"}]}'
    curl http://127.0.0.1:8080/v1/images/generations -H 'content-type: application/json' \
      -d '{"prompt":"a red fox in the snow, 16:9"}' | jq -r '.data[0].b64_json' | base64 -d > fox.jpg
    curl -N http://127.0.0.1:8080/v1/chat/completions -H 'content-type: application/json' \
      -d '{"model":"capitoline","stream":true,"messages":[{"role":"user","content":"Is a retry after a refusal worth one more call?"}]}'

`GET /v1/usage` answers two questions: `.callers` is who spent the last day, and `.models` is which real model served each gateway name over the last week. The second exists because the configuration names CLI aliases rather than dated ids — `opus` meant Opus 5 until 2026-09-22 and Opus 5.5 after it, with nothing here changed — so two rows under one name is an alias that moved, and without them every measurement would be undated underneath.

Any OpenAI-compatible client works by setting its base URL to `/v1` (Open WebUI, the official SDKs, LiteLLM). Supported: `model`, `messages` (text and base64 image parts), `stream`, `reasoning_effort` (`low`, `medium`, `high`, `xhigh`, `max`, `ultra` — each provider prices the levels its CLI accepts and a request asking for one it does not runs at the nearest, never at the CLI's own default). Rejected with 400: `tools`, `n>1`, `logprobs`, `response_format`. Ignored with the `X-Capitoline-Ignored` header: `temperature`, `top_p`, `max_tokens` and other sampling knobs. Responses carry an extra `capitoline` field, which names the provider that served the call and, when the CLI reported one, `cliModelId`: the dated id of the model that actually answered. `model` stays the name you asked for, as an OpenAI client expects. Only Claude reports an id, because only its names are aliases — a Codex slug and an Antigravity id are the model itself.

Images: `POST /v1/images/generations` serves the models declared with `kind: image` (the kind is reported by `/v1/models`); omit `model` and the first available image model answers. Two exist: `codex-image`, Codex's built-in generation on the ChatGPT subscription, which comes first and so is the default; and `antigravity-image`, whose quota is small (12 per 5 hours, 58 per week) and which answers when a client names it or when Codex's is unavailable. Neither uses an API key. One image per call, returned inline as `b64_json`, with the real `mime`, `width`, `height` and `bytes` in the `capitoline` field. Rejected with 400: `n` other than 1, a `response_format` other than `b64_json`, an `output_format` other than `jpeg` (the gateway returns the format the CLI produced), a chat request against an image model and an image request against a text model. Ignored with the `X-Capitoline-Ignored` header: `size`, `quality`, `style` and the other style knobs — the CLI's image tool takes only a prompt, so there is nothing to map a size onto. A generation takes 11-45 s and the provider's quota is small: `docs/spike-2026-09.md` §8 has the two windows.

Council: `model: capitoline` convenes the Triad instead of giving the floor to one member. One question is **nine calls in three stages** — four independent answers, four anonymous peer rankings of those answers, one synthesis written by a judge seated apart from the panel — spread over three subscriptions, so it costs about what nine direct requests cost and takes minutes rather than seconds. The synthesis is the message content, so a client that knows nothing of the council reads an ordinary completion; the rest is in the `capitoline.council` field: every member with its real model name, its label and its answer, which seats fell back and which were lost, each member's ranking and the panel's aggregate, the judge and whether it was blind, the shape that ran and the strategy version, and a deliberation id — the same id that ties that deliberation's rows in the usage table together. Below two answers no council takes place: with one, that answer is returned as its member wrote it and the field says plainly that nobody ranked it. Ask for it with `stream: true` through a tunnel or any other proxy (`docs/deploy.md` §9): the silent stages then send a progress chunk per stage and per member (`{"stage":"rankings","done":2,"total":4}` in the chunk's own `capitoline` field, which an OpenAI client ignores) and the synthesis streams as ordinary content. The seats, the judge's chain, the quorum, the ranking stage and the per-stage timeout are configuration (`council:` in `config/capitoline.yaml`); the three prompts are not — they are the strategy itself, they live in `src/council/prompts.ts`, and changing them changes the model's name.

Three councils are configured, and a client asks for any of them the same way: in `model`, or as the `council` argument of the MCP tool `ask_council`. The price is one call per seat, one more per seat when the ranking stage runs, and one for the judge.

| Model | What it convenes | Calls |
|---|---|---|
| `capitoline` | the reference panel: four families — Anthropic, OpenAI, Google, open weights — answer, rank each other blind, and a judge seated apart synthesizes. The shape to ask when the panel's own verdict on its answers is worth its price | 9 |
| `capitoline-fast` | the same four families and the same judge, without the ranking stage (`ranking: false`): four independent perspectives and a synthesis for half the price, and no panel verdict on them. The everyday shape. The response carries an empty `rankings` and `aggregate` and says which shape ran, so a fast deliberation is never read as one whose rankings all failed | 5 |
| `capitoline-gemini` | one capability ladder rather than a panel: a single family at three reasoning levels — `gemini-3.1-pro-high`, `gemini-3.8-flash-high`, `gemini-3.8-flash-low`, the big model, the small one trying and the small one not trying — ranking each other blind and judged from another family. It answers "how far down can I go", not "which answer is best": if the three rungs agree, the cheapest of them would have sufficed. A measuring instrument to run over a sample of real questions, not a daily mode, and it refuses rather than run with a rung missing | 7 |

A single model is named `<door>-<model>`: the door is the CLI the request goes through (`claude`, `codex`, `antigravity`), the model is what that door calls it. `antigravity-claude-opus` is Claude Opus through Antigravity and `claude-opus` is the same lineage through Claude Code, on a different subscription with a different quota, which is the distinction the prefix exists to draw.

After the `capitoline-` prefix a **shape word** says how the council deliberates (`-fast`), a **family name** says who sits (`-gemini`, later `-claude`, `-openai`), and a **number** is a new version of the same shape (`-2`); `capitoline` alone stays the reference panel. A fourth council is configuration and a restart — other seats, another judge, a different quorum or deadline — and only a change to the *sequence* of stages needs the engine (spec §12.9).

MCP: `POST /mcp` (streamable HTTP) with tools `list_models`, `ask_model`, `ask_council` and `generate_image` (the image comes back as an MCP image content block). Registration from Claude Code is in `docs/deploy.md` §10. Raise the tool timeout on the client side first — `export MCP_TOOL_TIMEOUT=1200000` in the shell that starts Claude Code: a CLI answer can take minutes, an image 11-45 s, and a deliberation has no deadline of its own beyond the 300 s each member of each stage gets, so it can run past 900 s — all well beyond the default. Capitoline sends a progress notification at every council stage and every 5 s while it draws, to clients that ask for one (a request with a progress token), but a notification postpones the deadline only in a client that sets `resetTimeoutOnProgress` (off by default in the MCP TypeScript SDK), so the raised timeout is what actually carries the call (spec §6.2).

Token counts — the `usage` block of every chat response, the `usage` of the last chunk of a stream, the `usage` of the MCP `ask_model` result, and the per-caller sums in `GET /v1/usage` — follow each provider's own convention: OpenAI counts cached and reasoning tokens inside the prompt and completion totals, Anthropic reports cached reads beside the input, Antigravity leaves them out of its own total and keeps its thinking tokens inside the output (measured, `docs/spike-2026-09.md` §10). Each adapter is right for the CLI it reads, so one call's count is comparable with the same provider's own history and not comparable with another provider's — and the sums in `GET /v1/usage`, which add up whatever providers a caller used, are an order of magnitude rather than a measure (`docs/deploy.md` §9). For one figure across all three, count calls, not tokens.

After updating a CLI, run `scripts/smoke.sh` (see `docs/update-clis.md`); it needs `curl` and `jq` on the machine it runs from.

## Principles

- **The CLIs are used as processes**, never their tokens. This is an
  architectural constraint, not just a policy.
- **The CLIs are agents**: they run in an empty sandbox, with tools disabled,
  as a separate user that is the only one holding the credentials.
- **Standard protocol, declared subset**: whatever cannot be honored is
  rejected explicitly, never silently degraded.
- **Everything that depends on the CLIs lives in configuration**, because
  the CLIs change every month.

## A note on terms of service

Capitoline uses consumer subscriptions through the providers' official
clients, for personal use. What each provider allows in headless, automated
mode must be checked provider by provider and can change. Never pool
multiple accounts of the same provider: it violates explicit clauses.
