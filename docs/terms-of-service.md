# Terms of service: what the CLI-behind-an-API pattern is allowed to do

Checked 2026-09-21 against the primary documents. Not legal advice; a reading of
the texts as they stand today, with the quotes that matter. Re-check after any
provider announcement.

## The pattern

Capitoline runs the unmodified official CLIs (`claude -p`, `codex exec`,
`agy -p`) as processes, authenticated once by the owner with the owner's own
subscriptions, and exposes their answers over an HTTP API and an MCP server
that only the owner's credentials (Cloudflare Access) can reach.

The question that decides everything is **who the answers are for**.

## Anthropic (Claude Max)

Sources: [Consumer Terms](https://www.anthropic.com/legal/consumer-terms),
[Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance),
[Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

- Consumer Terms §3 forbid "to access the Services through automated or
  non-human means, whether through a bot, script, or otherwise" **"except when
  you are accessing our Services via an Anthropic API Key or where we otherwise
  explicitly permit it"**. Headless `claude -p` is an Anthropic-documented
  feature, and the help center states that "Claude Agent SDK, `claude -p`, and
  third-party app usage still draw from your subscription's usage limits":
  that is the explicit permission.
- Claude Code legal page: "Advertised usage limits for Pro and Max plans
  assume **ordinary, individual usage** of Claude Code and the Agent SDK."
- Same page: OAuth "is designed to support ordinary use of Claude Code and
  other native Anthropic applications"; "Developers building products or
  services that interact with Claude's capabilities [...] should use API key
  authentication"; "Anthropic does not permit third-party developers to offer
  Claude.ai login into their own applications, **or to route requests through
  Free, Pro, or Max plan credentials on behalf of their users**."
- Consumer Terms §2: "You may not share your Account login information [...]
  or make your Account available to anyone else."

Reading: the owner asking Claude questions through their own tooling is
ordinary individual use of the official binary. A service whose end users are
other people, answered through the owner's Max plan, is "routing requests
through Max plan credentials on behalf of their users": not permitted, and
the page says Anthropic enforces without notice.

## OpenAI (ChatGPT Pro, Codex)

Sources: [Terms of Use](https://openai.com/policies/terms-of-use/),
[Codex pricing](https://learn.chatgpt.com/docs/pricing),
[Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan).

- Plus and Pro include "Codex in the CLI, SDK, or IDE extension"; local
  messages share the plan allowance. `codex exec` is part of the CLI.
- Terms of Use forbid to "automatically or programmatically extract data or
  Output" **"except as permitted through the API"**, and to share credentials
  or "make your account available to anyone else".
- The docs recommend API keys for "automation in shared environments like CI"
  and say to treat `auth.json` "like a password"; they do not forbid plan
  sign-in in automation.

Reading: the owner's own use through the official CLI is within the plan;
answering other people's requests with the owner's plan makes the account
"available to anyone else". Same line as Anthropic, less explicitly drawn.

## Google (AI Pro, Antigravity)

Sources: [Antigravity additional terms](https://antigravity.google/terms),
[Google Terms of Service](https://policies.google.com/terms).

- Antigravity terms: "Using third party software, tools, or services to access
  the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this
  Agreement." The example targets tools that reuse the OAuth token outside the
  CLI. Capitoline never touches the token: the unmodified `agy` binary makes
  every request. Whether a script that launches `agy` counts as a "third party
  service to access the Service" is not defined.
- Google Terms: "Don't abuse our services", no clause on sharing or automation
  beyond robots.txt-style scraping.

Reading: the least precise of the three. Personal use through the official
binary is defensible; serving other people is the same risk as above, and the
wording gives Google the widest latitude.

## Rule for this project

1. **Subscription providers (`claude-*`, `codex-*`, `agy-*`) serve the owner
   only**: Claude Code via MCP, Open WebUI, the owner's scripts, the council
   the owner asks. Volumes stay "ordinary, individual".
2. **Anything with other people as end users (a Telegram bot for other
   parents, a service for colleagues, an endpoint registered in a corporate
   gateway) must not be answered by the subscription providers.** Those apps
   use free-tier or self-hosted inference (Gemini free tier, the platform, Ollama), or
   API keys if the no-pay-per-use rule is ever lifted.
3. Never pool accounts, never share the service token with anyone else's app.
