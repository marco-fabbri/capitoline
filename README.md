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

In phase 1 you can give the floor to a single member: `claude-opus`,
`codex-gpt-5`, `gemini-pro`. In phase 2 the `capitoline` model convenes the
Triad: every member answers, every member judges the others without knowing
who wrote what, and a judge synthesizes. As in the Temple, the value is not
in the agreement but in hearing the dissent before deciding.

## Run it

Requirements: Node 24+, and the CLIs `claude`, `codex`, `agy` installed and logged in for the user that runs them.

    npm ci && npm run build
    node dist/main.js                      # reads config/capitoline.yaml, listens on 127.0.0.1:8080

Production deployment on any Debian/Ubuntu host (a Nutanix AHV VM, a Proxmox LXC, bare metal), with a separate `runner` user and Cloudflare Tunnel + Access: see `docs/deploy.md`. An OpenAI-compatible API adapter (a company inference platform, Ollama, vLLM) is planned next, which also makes a stateless Kubernetes/NKP deployment possible.

## Use it

    curl http://127.0.0.1:8080/v1/models
    curl http://127.0.0.1:8080/v1/chat/completions -H 'content-type: application/json' \
      -d '{"model":"codex-gpt-5.5","reasoning_effort":"low","messages":[{"role":"user","content":"Reply with the single word: ok"}]}'
    curl http://127.0.0.1:8080/v1/images/generations -H 'content-type: application/json' \
      -d '{"prompt":"a red fox in the snow, 16:9"}' | jq -r '.data[0].b64_json' | base64 -d > fox.jpg

Any OpenAI-compatible client works by setting its base URL to `/v1` (Open WebUI, the official SDKs, LiteLLM). Supported: `model`, `messages` (text and base64 image parts), `stream`, `reasoning_effort`. Rejected with 400: `tools`, `n>1`, `logprobs`, `response_format`. Ignored with the `X-Capitoline-Ignored` header: `temperature`, `top_p`, `max_tokens` and other sampling knobs. Responses carry an extra `capitoline` field.

Images: `POST /v1/images/generations` serves the models declared with `kind: image` (the kind is reported by `/v1/models`); omit `model` and the first available image model answers. One image per call, returned inline as `b64_json`, with the real `mime`, `width`, `height` and `bytes` in the `capitoline` field. Rejected with 400: `n` other than 1, a `response_format` other than `b64_json`, a chat request against an image model and an image request against a text model. Ignored with the `X-Capitoline-Ignored` header: `size`, `quality`, `style` and the other style knobs — the CLI's image tool takes only a prompt, so there is nothing to map a size onto. A generation takes 11-45 s and the provider's quota is small: `docs/spike-2026-09.md` §8 has the two windows.

MCP: `POST /mcp` (streamable HTTP) with tools `list_models`, `ask_model` and `generate_image` (the image comes back as an MCP image content block). Registration from Claude Code is in `docs/deploy.md` §10. Raise the tool timeout on the client side first — `export MCP_TOOL_TIMEOUT=600000` in the shell that starts Claude Code: a CLI answer can take minutes and an image 11-45 s, well past the default. Capitoline sends a progress notification every 5 s while it draws, but a notification postpones the deadline only in a client that sets `resetTimeoutOnProgress` (off by default in the MCP TypeScript SDK), so the raised timeout is what actually carries the call (spec §6.2).

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
