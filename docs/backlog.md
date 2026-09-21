# Backlog

Open points from independent code review of the phase 1 implementation (minor
findings only; each was checked against the current code and dropped if
already fixed or superseded), plus phase 2 and beyond. Findings that were
duplicated across tasks are merged into one line. Runner (`src/runner/runner.ts`)
had two review findings and both are already fixed in the current code
(attachment name validation, eager line buffering); the Runner section below is
not one of them but a later observation from the host, still to be confirmed.

## Runner

- Observation to confirm on the host: watch `/var/lib/capitoline/sandboxes` while the service is up. The one empty `run-…` directory seen on the Mac now has an explanation and a fix (a grandchild inheriting stdout kept `close` from firing, so the run never settled: `src/runner/runner.ts` bounds that wait since A6), and the startup sweep removes whatever an earlier process left behind — which is exactly why the remaining symptom is a `run-…` directory appearing there *between* two restarts. That means a run that hung rather than one that was killed, and it is the only thing left that would show a second leak path. Nothing else in the repository looks at that directory while the gateway is running.

## Phase 2 and beyond

- **Cloudflare MCP Server Portals (beta)**: register `/mcp` in a portal (Zero Trust → Access controls → MCP Portals) to get OAuth login, per-tool policies and invocation logs instead of the raw service token in Claude Code's config. To verify: whether the portal forwards progress notifications (the council needs them) and how it coexists with the Access service-token policy already on the hostname (a second hostname for the portal may be needed).


**OpenAI-compatible API adapter.** For self-hosted inference only — a company inference platform, Ollama, vLLM. No pay-per-use public APIs, by the owner's rule. This adapter also enables a stateless Kubernetes/NKP deployment and lets a company inference platform register Capitoline as a backend (Agent Gateway / Unified Endpoints) and as an MCP server (the platform 2.8).

**Council.** A virtual model named `capitoline`, using the strategy from karpathy/llm-council: independent answers from each provider, anonymous peer ranking, then judge synthesis. Exposed as the MCP tool `ask_council`.

**The judge: two options, with opinionated defaults.** karpathy/llm-council seats `google/gemini-3-pro-preview` as both a member and the chairman, and lets the chairman see everything in the synthesis stage. Both choices become configuration here, because the right answer is empirical and options are what make it measurable on the same prompts:

- `judge.allow_member` (default `false`): the judge is a seat of its own. It costs one call out of eleven and removes any question of a synthesizer weighing an answer it wrote itself. Set it to `true` to reproduce Karpathy's shape.
- `judge.blind` (default `true`): the judge receives the labelled answers and the aggregate ranking, not the identities, so the deliberation is blind end to end. The response's `capitoline` field still carries the un-blinded detail, which puts the transparency in the report rather than in the deliberation.

Not configurable: the anonymity of the peer-ranking stage. It is the mechanism the whole design rests on, and an option to disable it would only offer a way to produce a skewed ranking without noticing.

**Council seats are preferences, not fixed models.** A seat declares a family and an ordered list of models; at deliberation time the engine seats the first one that is currently available, which it already knows from the health and quota state. Two reasons this is not a refinement but a requirement. First, quotas run out: on 2026-09-21 the Fable model was refused while the same subscription answered on Opus and Sonnet, so a member list naming a model outright would have broken every deliberation that day. Second, a panel needs independent judgment, and models of one family agree with each other and rank each other's answers alike, so three Anthropic seats would give one lineage three votes out of five and would also spend one 5-hour window three times over. The shape that follows: one seat per family (Anthropic, OpenAI, Google, open weights through `gpt-oss-120b` on Antigravity), each with its own fallback chain, and the judge chosen the same way. Watch for the same model reachable through two channels — `claude-opus` and `agy-claude-opus` are one model, two seats, one opinion.

**Council variant: a chain of roles, not a panel.** A second strategy, under its own model name (`capitoline-critique` or similar), where the members do different jobs instead of the same one: one drafts, one attacks the draft, one rewrites from both. It answers a different question than the panel does — "how do I improve this answer" rather than "which answer is best" — and it deliberately gives up the anonymous ranking, which only works while the members are symmetric and their answers comparable. Worth measuring against the panel on the same prompts before deciding which one becomes the default; the panel ships first because the ranking is the part with published calibration behind it. Roles stay decoupled from models, as the member list already is.

**Expose `gpt-oss-120b` through Antigravity.** `agy models` lists `gpt-oss-120b-medium` (recorded in `test/fixtures/antigravity/models.txt`) and the configuration never exposed it. One line, and it adds an open-weights family to the council without any local compute and without a new provider.

**Antigravity text rate limits.** The same "reports success but the error is in the text" pattern, now confirmed and handled for image generation, may also occur for text output — verify this and, if confirmed, call `detectQuotaExhausted` (`src/providers/errors.ts`, already written for the image path) from the text path of `CliProvider.execute()` too.

**Real error fixtures.** Capture real fixtures (expired token, exhausted window) for all three CLIs, recorded when the conditions actually occur rather than synthesized. One is now in: `test/fixtures/antigravity/image-429.jsonl`, the image quota refusal captured on 2026-09-21. Still synthetic: every expired-token case, and the text-side window for all three.

**Attachments over MCP.** The `ask_model` tool takes a prompt and nothing else, so an image can be sent to a model through `POST /v1/chat/completions` (data-URL content parts, `InternalRequest.attachments`) but not through MCP. **Deliberately deferred in B5, 2026-09-22**, as that task's own text recommends: the council of phase 2 deliberates on text, no caller has asked for it, and adding it is not one parameter but a decision about how bytes travel over JSON-RPC — base64 inside a tool argument, counted against the client's own context and repeated in every retry, against a file path the gateway would have to be allowed to read from the client's machine, which it is not. Revisit when a caller needs it, and take the HTTP path as the shape to mirror.

**Two-container pod shape.** Gateway and runner as separate containers in one pod, communicating over a local socket, as the clean alternative to running sudo inside a single container.

## Shipped

**Antigravity image generation — done (2026-09-21).** `POST /v1/images/generations` and the MCP tool `generate_image`, served by models declared `kind: image`. The silent 429 (the run reports SUCCESS and hides the refusal in a tool step) is detected from the tool event's raw JSON by `detectQuotaExhausted`, and the absolute reset instant the provider returns becomes the provider pause — never an assumed five hours, because the longer of the two windows resets in days. The image itself never reaches the sandbox: it is collected out of the CLI's own home by `scripts/capitoline-collect-image` through sudo and gated on `image.min_bytes` as a second line of defence against a truncated or placeholder file. Findings in `docs/spike-2026-09.md` §8, install steps in `docs/deploy.md` §7.1, both fixtures real. Left as it is by design: `size` is accepted and ignored, since the CLI's tool has no size parameter. Image quota state done (2026-09-21): `UsageStore.imageWindow` counts the successful generations of the 5-hour window, `image.quota_per_window` supplies the limit, and `/health` exposes `imageQuota` (`/v1/models` shows `used` and `limit` for the image models still available). Only the short window is countable locally, and only as a lower bound; the longer one stays known only from the reset instant a refusal carries, reported by `/health` and by the MCP `list_models` tool.
