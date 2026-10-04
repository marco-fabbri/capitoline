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

You can give the floor to a single member: `claude-fable`,
`codex-gpt-6-astra`, `antigravity-gemini-pro`, or any other model the three CLIs
serve, since every one of them is exposed by name. Or the `capitoline` model convenes the
Triad: every member answers, every member judges the others without knowing
who wrote what, and a judge synthesizes. As in the Temple, the value is not
in the agreement but in hearing the dissent before deciding.

The council is Andrej Karpathy's idea, and the credit is his:
[llm-council](https://github.com/karpathy/llm-council) is a local web app
that sends a question to several models through OpenRouter, has them review
and rank each other's answers anonymously, and lets a chairman model write
the final response. Capitoline keeps those three stages and changes what is
around them. The models are reached through their official CLIs, on your own
subscriptions, with no pay-per-use API, and the council is a model name any
OpenAI client or MCP client can ask for. Each seat is a model family with a
fallback chain, not a single model. The judge is seated apart and blind by
default: llm-council's chairman is a member, and here that is an option
(`judge_allow_member`). The synthesis builds on the top-ranked answer and
asserts nothing the answers do not support. And every change to the strategy
was measured before it shipped (`docs/measurements/`).

## Can I use Capitoline with my subscriptions?

Two different questions, with two different answers.

**The code** is MIT-licensed (`LICENSE`): anyone may use, change and share it.

**Your subscriptions** are governed by each provider's terms, and that is the
question `docs/terms-of-service.md` answers, with the clauses that matter
quoted and dated. In short, from the author's reading:

- **Yes, for your own use on your own plans.** Capitoline runs each provider's
  official CLI in the headless mode the provider documents, signed in with your
  account, and never touches its tokens. Anthropic permits it in so many words,
  OpenAI through its product documentation; Google is the least settled of the
  three, and xAI is not supported.
- **A business seat is still one person's.** A service for colleagues needs
  credentials the company holds, under the company's agreement.
- **An application of your own may use it** while four conditions hold: no text
  another person wrote reaches a prompt, the volume stays personal, nothing is
  sold, and no provider is named or branded in the output.
- **Never** share an account, hand a key to another person for their own
  questions, or pool several accounts of one provider.

This is the author's personal interpretation, not legal advice: the author is
not a lawyer, and the terms can change. Read the terms that bind your own
accounts; `docs/terms-of-service.md` has the full analysis and a checklist, and
`docs/deployment-policy.md` is how the author's own installation applies it.

## Run it

Requirements: Linux for a deployment (Debian or Ubuntu; macOS works for development), Node 24.x (pinned in `.nvmrc`; `engines` is `>=24 <25`), and the CLIs `claude`, `codex`, `agy` installed and logged in, on subscriptions of your own, for the user that runs them. The shipped configuration seats all three in its councils and sizes its concurrency for a host of about 8 GB (the startup log says whether yours fits, design §4.1). A CLI that is missing or signed out is reported unhealthy and its models unavailable; the councils then seat the members that are left.

On a development machine, a short overlay runs the CLIs as yourself instead of through `sudo`, and keeps the sandboxes and the database in the working copy:

    mkdir -p tmp && cat > tmp/dev-overlay.yaml <<'EOF'
    runner: { user: null, sandbox_root: ./tmp/sandboxes }
    usage: { db_path: ./tmp/usage.sqlite }
    EOF
    npm ci && npm run build
    CAPITOLINE_OVERLAY=tmp/dev-overlay.yaml node dist/main.js    # base config/capitoline.yaml, listens on 127.0.0.1:8080

To work on it, `git config core.hooksPath .githooks` enables a check that refuses a commit carrying a session link or a key (`.githooks/public-check`, which also reads a private pattern list of your own if you keep one).

A production host — a separate `runner` user that alone holds the CLI logins, a systemd service, backups, updates — is built by the Ansible playbook in **`deploy/ansible`**, from your own computer over SSH, at the version you have checked out:

    cd deploy/ansible && cp inventory.example.yml inventory.yml    # name the host
    ansible-playbook site.yml      # then log in to each CLI on the host, as it prints
    ansible-playbook verify.yml

The same steps by hand, with the reason for each, are **`docs/deploy.md`**, which stays the reference. Three things are kept apart there. **Who calls** is the gateway's own business: it issues and checks its own API keys, and signs in the MCP clients that cannot hold one with OAuth. **How it is reached** is yours to choose: a network of your own once `server.host` opens it beyond the loopback (§8.2), a reverse proxy with TLS, or a tunnel — the runbook describes Cloudflare's, which opens no inbound port. **Cloudflare Access** is an optional layer on top, which stops callers with no credential at the edge at the price of a second credential per application (§9.1). Nothing in Capitoline requires Cloudflare. A host can also serve less than all three: `serve: { providers: [claude], councils: [] }` in its overlay makes it a gateway to one subscription (§7).

Connecting another application of your own: `docs/connecting-an-application.md`, which covers the credential — a key issued by the gateway (`Authorization: Bearer cap_…`, managed through `/v1/admin/keys` or `npm run keys` on the host), plus a Cloudflare service token on a host that keeps Access in front (`scripts/cf-service-token.sh` creates one) — where the secret goes and what it may be used for. Every call is recorded under the caller's name: `GET /v1/usage` is the per-caller and per-model breakdown.

## Use it

    curl http://127.0.0.1:8080/v1/models
    curl http://127.0.0.1:8080/v1/chat/completions -H 'content-type: application/json' \
      -d '{"model":"codex-gpt-6-luna","reasoning_effort":"low","messages":[{"role":"user","content":"Reply with the single word: ok"}]}'
    curl http://127.0.0.1:8080/v1/images/generations -H 'content-type: application/json' \
      -d '{"prompt":"a red fox in the snow, 16:9"}' | jq -r '.data[0].b64_json' | base64 -d > fox.jpg
    curl -N http://127.0.0.1:8080/v1/chat/completions -H 'content-type: application/json' \
      -d '{"model":"capitoline","stream":true,"messages":[{"role":"user","content":"Is a retry after a refusal worth one more call?"}]}'
    curl -N http://127.0.0.1:8080/v1/chat/completions -H 'content-type: application/json' \
      -d '{"model":"capitoline","reasoning_effort":"low","stream":true,"messages":[{"role":"user","content":"Same question, five calls: no peer ranking."}]}'

`GET /v1/usage` answers two questions: `.callers` is who spent the last day, and `.models` is which real model served each gateway name over the last week. The second exists because the configuration names CLI aliases rather than dated ids — `opus` meant Opus 5 until 2026-09-22 and Opus 5.5 after it, with nothing here changed — so two rows under one name is an alias that moved, and without them every measurement would be undated underneath.

Any OpenAI-compatible client works by setting its base URL to `/v1` (Open WebUI, the official SDKs, LiteLLM). Supported: `model`, `messages` (text and base64 image parts: up to 16 PNG, JPEG, WebP or GIF images of 10 MB each, which reach `claude-*` and `codex-*` models; `antigravity-*` models take text only and refuse them with 400), `stream`, `reasoning_effort` (`low`, `medium`, `high`, `xhigh`, `max`, `ultra` — each provider prices the levels its CLI accepts and a request asking for one it does not runs at the nearest, never at the CLI's own default). Rejected with 400: `tools`, `n>1`, `logprobs`, `response_format`. Ignored with the `X-Capitoline-Ignored` header: `temperature`, `top_p`, `max_tokens` and other sampling knobs. Responses carry an extra `capitoline` field, which names the provider that served the call and, when the CLI reported one, `cliModelId`: the dated id of the model that actually answered. `model` stays the name you asked for, as an OpenAI client expects. Only Claude reports an id, because only its names are aliases — a Codex slug and an Antigravity id are the model itself.

Conversations work two ways. **Chat Completions is stateless**: a client that wants a second turn sends the whole history again in `messages`, which is what Open WebUI and the SDKs do. **The Responses API keeps the conversation on the server**: `POST /v1/responses` answers with an id, and a request that names it in `previous_response_id` continues from there without resending anything (`GET` and `DELETE /v1/responses/{id}` read a kept response and delete its conversation). Either way the history reaches the model the same way — rendered as labelled turns into one prompt, in a fresh CLI process with its sessions disabled — so each turn costs the whole history in tokens; the CLIs never hold a conversation. What the gateway keeps is text only (an image reaches the model in its own turn, and later turns see a line saying it was there), in a database file of its own, readable by the caller that created it and no one else, for 30 days after its last turn (`conversations:` in the configuration, which also caps a conversation's turns and size). `store: false` keeps nothing. Served from the Responses API: `model`, `input` (text and `input_image` data URLs), `instructions` (for that turn only, as in OpenAI's), `previous_response_id`, `store`, `stream` (its typed events), `reasoning.effort`, `truncation` (`auto` drops a long conversation's oldest turns instead of refusing it); `tools` and structured output are refused, and councils and image models keep their own endpoints.

Images: `POST /v1/images/generations` serves the models declared with `kind: image` (the kind is reported by `/v1/models`); omit `model` and the first available image model answers. Two exist: `codex-image`, Codex's built-in generation on the ChatGPT subscription, which comes first and so is the default; and `antigravity-image`, whose quota is small (12 per 5 hours, 58 per week) and which answers when a client names it or when Codex's is unavailable. Neither uses an API key. One image per call, returned inline as `b64_json`, with the real `mime`, `width`, `height` and `bytes` in the `capitoline` field. Rejected with 400: `n` other than 1, a `response_format` other than `b64_json`, an `output_format` other than `jpeg` (the gateway returns the format the CLI produced), a chat request against an image model and an image request against a text model. Ignored with the `X-Capitoline-Ignored` header: `size`, `quality`, `style` and the other style knobs — the CLI's image tool takes only a prompt, so there is nothing to map a size onto. A generation takes 11-45 s and the provider's quota is small: `docs/spike-2026-09.md` §8 has the two windows.

Council: `model: capitoline` convenes the Triad instead of giving the floor to one member. One question is **nine calls in three stages** — four independent answers, four anonymous peer rankings of those answers, one synthesis written by a judge seated apart from the panel — spread over three subscriptions, so it costs about what nine direct requests cost and takes minutes rather than seconds. The synthesis is the message content, so a client that knows nothing of the council reads an ordinary completion; the rest is in the `capitoline.council` field: every member with its real model name, its label and its answer, which seats fell back and which were lost, each member's ranking and the panel's aggregate, the judge and whether it was blind, the shape that ran and the strategy version, and a deliberation id — the same id that ties that deliberation's rows in the usage table together. Below two answers no council takes place: with one, that answer is returned as its member wrote it and the field says plainly that nobody ranked it. Ask for it with `stream: true` through a tunnel or any other proxy (`docs/deploy.md` §9): the silent stages then send a progress chunk per stage and per member (`{"stage":"rankings","done":2,"total":4}` in the chunk's own `capitoline` field, which an OpenAI client ignores) and the synthesis streams as ordinary content. The seats, the judge's chain, the quorum, the ranking stage and the per-stage timeout are configuration (`council:` in `config/capitoline.yaml`); the three prompts are not — they are the strategy itself, they live in `src/council/prompts.ts`, and changing them changes the model's name.

Two councils are configured, and a client asks for either the same way: in `model`, or as the `council` argument of the MCP tool `ask_council`. The price is one call per seat, one more per seat when the ranking stage runs, and one for the judge. The shape is also a request option, as the effort is for every model: `capitoline` with `reasoning_effort: low` (or `effort: low` on `ask_council`) skips the ranking stage and costs five calls; `high`, or no effort, is the full council, and the other levels resolve to the nearer of the two. A council configured without the ranking stage is pinned to it and reports `reasoning_effort` as ignored.

| Model | What it convenes | Calls |
|---|---|---|
| `capitoline` | the reference panel: four families — Anthropic, OpenAI, Google, open weights — answer, rank each other blind, and a judge seated apart synthesizes. The shape to ask when the panel's own verdict on its answers is worth its price | 9 |
| `capitoline-fast` | the same four families and the same judge, without the ranking stage (`ranking: false`): four independent perspectives and a synthesis for half the price, and no panel verdict on them. It is `capitoline` at `reasoning_effort: low`, pinned under a name of its own for clients that cannot send the field. The response carries an empty `rankings` and `aggregate` and says which shape ran, so a fast deliberation is never read as one whose rankings all failed | 5 |

The model list keeps itself current. Once a day, and at startup, the gateway asks the Codex and Antigravity CLIs which models they serve (`codex debug models`, `agy models`): a model they add is served under the door's prefix, one they drop disappears from `/v1/models` and the councils step past it, and `/health` shows what changed. Claude's names are aliases that already follow the latest model. Nothing is edited on disk, and a change can optionally be announced as one plain-text POST — to an [ntfy](https://ntfy.sh) topic, say, or any endpoint that takes one (`docs/deploy.md` §7.2).

A single model is named `<door>-<model>`: the door is the CLI the request goes through (`claude`, `codex`, `antigravity`), the model is what that door calls it. `antigravity-claude-opus` is Claude Opus through Antigravity and `claude-opus` is the same lineage through Claude Code, on a different subscription with a different quota, which is the distinction the prefix exists to draw.

To find out which model is enough for a task, a **capability ladder** seats three models of one family — three sizes, or one model at three reasoning levels — that rank each other blind. It is a measuring instrument rather than a council to use, so none ships: `docs/measure-a-model.md` has three ready to add to a host's overlay, and the measurement that showed the instrument works.

After the `capitoline-` prefix a **shape word** says how the council deliberates (`-fast`), a **family name** says who sits (`-gemini`, `-claude`, `-openai` for the ladders of that guide), and a **number** is a new version of the same shape (`-2`); `capitoline` alone stays the reference panel. A third council is configuration and a restart — other seats, another judge, a different quorum or deadline — and only a change to the *sequence* of stages needs the engine (spec §12.9).

MCP: `POST /mcp` (streamable HTTP) with tools `list_models`, `ask_model` (which also takes `images`, base64 with their media type, on the same terms as the HTTP image parts), `ask_council` and `generate_image` (the image comes back as an MCP image content block). Registration from Claude Code is in `docs/deploy.md` §10. Raise the tool timeout on the client side first — `export MCP_TOOL_TIMEOUT=1200000` in the shell that starts Claude Code: a CLI answer can take minutes, an image 11-45 s, and a deliberation has no deadline of its own beyond the 300 s each member of each stage gets, so it can run past 900 s — all well beyond the default. Capitoline sends a progress notification at every council stage and every 5 s while it draws, to clients that ask for one (a request with a progress token), but a notification postpones the deadline only in a client that sets `resetTimeoutOnProgress` (off by default in the MCP TypeScript SDK), so the raised timeout is what actually carries the call (spec §6.2). Claude on the web and other clients that sign in with OAuth connect too, once `server.oauth.public_url` is set: the gateway is its own authorization server, and signing in is pasting one of its keys (`docs/deploy.md` §10.1).

An operator's page, off by default: with `server.ui: { enabled: true }` the gateway serves `/ui`, one HTML file with no framework, which shows the providers' health and CLI versions, the models with their pauses and quotas, usage per caller, model and day, what that usage would have cost at the vendors' API list prices, the keys, the kept conversations (counts, never text) and the latest deliberations, and does the few things that are state and not configuration: create and revoke a key, name a caller, lift a pause or hold a model back for a while, run a health check now. It signs in with an administrator's key kept in the browser tab, and everything it does is a call to `/v1/admin` that `curl` can make too (`docs/deploy.md` §8.4). It is one operator's page, not accounts: there are no users or roles, whoever holds an administrator's key can do all of it, and the journal names the key behind each action; use it over TLS, since the key travels with every call. The configuration stays in its file.

Over MCP each `ask_model` or `ask_council` call is a question of its own, and the client holds the conversation — Claude Code or Claude on the web writes into the prompt whatever context the question needs. To hold one with a model instead, `ask_model` takes `conversation`: `"new"` on the first question, then the id each answer returns. The turns are kept with the Responses API's, under the same rules, so a conversation started over MCP can be continued over HTTP with the same key.

Token counts — the `usage` block of every chat response, the `usage` of the last chunk of a stream, the `usage` of the MCP `ask_model` result, and the per-caller sums in `GET /v1/usage` — follow each provider's own convention: OpenAI counts cached and reasoning tokens inside the prompt and completion totals, Anthropic reports cached reads beside the input, Antigravity leaves them out of its own total and keeps its thinking tokens inside the output (measured, `docs/spike-2026-09.md` §10). Each adapter is right for the CLI it reads, so one call's count is comparable with the same provider's own history and not comparable with another provider's — and the sums in `GET /v1/usage`, which add up whatever providers a caller used, are an order of magnitude rather than a measure (`docs/deploy.md` §9). For one figure across all three, count calls, not tokens.

After updating a CLI, run `scripts/smoke.sh` (see `docs/update-clis.md`); it needs `curl` and `jq` on the machine it runs from.

## Providers considered and declined

**Grok (xAI).** Grok Build, xAI's official CLI, can serve as a provider:
a subscription signs in on a headless host, and its non-interactive output
carries the text, token usage and the real model id (`docs/spike-2026-09.md`
§12). It was then measured as a fifth council member, on 2026-09-29, with
Grok Build 1.0.41 and `grok-4.7`, against a rule written before the runs
(`docs/measurements/2026-09-29-grok-seat/`). On the two open design
questions of the six, the other members ranked its answer first, blind, and
the syntheses built on it were more complete. Twice in five answers,
though, it stated a precise detail that is not true — a kernel source
comment that does not exist, a vSphere requirement described wrongly for
the way it was used — and the council carried both into the final answer:
the peer ranking rewards the best answer as a whole, and the judge is told
to build on it. It was also the slowest member by minutes per stage, and
lost one answer and three of five rankings to the stage timeout or a
malformed reply. So there is no Grok provider. The question is reopened
with a new run of the same measurement, not by argument, when a later model
or CLI might change the result; the protocol and the questions are there
to rerun.

## Principles

- **The CLIs are used as processes**, never their tokens. This is an
  architectural constraint, not just a policy.
- **The CLIs are agents**: they run in an empty sandbox, with tools disabled,
  as a separate user that is the only one holding the credentials.
- **Standard protocol, declared subset**: whatever cannot be honored is
  rejected explicitly, never silently degraded.
- **Everything that depends on the CLIs lives in configuration**, because
  the CLIs change every month.

## How this was built

Capitoline was written with Claude Code: most of the code and the documents
are Claude's, and every commit carries a `Co-Authored-By` line saying so.
The design, the decisions — what to build, the constraints above, the
council's strategy, which providers to trust with a seat — and the review
of every change are the author's.
