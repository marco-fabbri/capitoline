# Terms of service: what the CLI-behind-an-API pattern is allowed to do

Checked 2026-09-21 against the primary documents; the boundary re-read and
redrawn 2026-09-22. Not legal advice; a reading of
the texts as they stand today, with the quotes that matter. Re-check after any
provider announcement.

## The pattern

Capitoline runs the unmodified official CLIs (`claude -p`, `codex exec`,
`agy -p`) as processes, authenticated once by the owner with the owner's own
subscriptions, and exposes their answers over an HTTP API and an MCP server
that only the owner's credentials (Cloudflare Access) can reach.

The question that decides everything is **whether anyone but the owner can
put words in front of a model**. Not who reads the answer: who writes the
prompt. **Where the line is**, below, says why.

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
ordinary individual use of the official binary. The clause about routing
requests "on behalf of their users" is the one that decides everything else,
and it is read below, under **Rule for this project**, rather than here: it
is the same question for all three providers and it deserves one answer.

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

Reading: the owner's own use through the official CLI is within the plan.
"Available to anyone else" is the same clause Anthropic draws more explicitly,
and it is read the same way, below.

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
binary is defensible, and the same line is taken here as for the other two —
with the caveat that the wording gives Google the widest latitude, so a path
that is marginal anywhere is marginal here first.

## Where the line is

The three quotations that matter are alike: Anthropic forbids a third-party
developer to "offer Claude.ai login into their own applications, or to route
requests through Free, Pro, or Max plan credentials on behalf of their users",
and both Anthropic and OpenAI forbid making the account "available to anyone
else". Google's wording is looser and gives Google the widest latitude.

**This is read narrowly, and the reading is stated here rather than assumed.**
Two readings are available. The broad one: any request whose answer serves
another person. The narrow one: do not let other people use your subscription
as their own Claude — no resale, no proxied login, no free access handed out.

The narrow reading is taken, for a reason that can be checked. The shape the
clause names is a product that lets *its* users sign in with, or spend, the
developer's plan; that is what Anthropic actually shut down in February 2026,
and the sentence sits in a paragraph about OAuth and about developers who
should be using API keys. The broad reading would also forbid a script that
summarises the owner's mail and sends the summary to his wife, which is not
what the clause pursues and not how anyone reads it.

So the line is drawn at **free-form passthrough**:

- **Not permitted: text of another person's choosing reaching a model.** A
  chat window, an API handed out, a command that forwards whatever was typed.
  If someone else can put words in front of the model, the account has been
  made available to them, and that is the clause.
- **Defensible: the model as an internal component of the owner's software.**
  The code composes the prompt from its own data and its own templates; a
  person presses a button or types a fixed command and receives the
  software's output. They are a recipient of a product, not a user of Claude.

Four conditions hold the second case up, and all four must hold:

1. **No user text reaches a prompt.** Every value a person supplies is chosen
   from a closed list the software defines, or is data the software itself
   produced. A free-text field that lands in a prompt fails this outright.
2. **Personal volume.** "Ordinary, individual usage", in Anthropic's words.
   A few dozen calls a day, not a product's traffic.
3. **Nothing is sold.** No subscription, no per-use charge, no access resold.
4. **No provider is named or branded.** The output is the software's, not an
   answer presented as coming from Claude, Codex or Gemini.

The residual risk is not zero and this document will not pretend otherwise:
the broad reading exists, and a provider who chose it would be within the
words. What is recorded here is which reading is being followed and why, so
that if one of the four conditions stops holding, the change is visible and
the path moves to free-tier or self-hosted inference instead.

## Rule for this project

1. **Subscription providers (`claude-*`, `codex-*`, `antigravity-*`) serve the owner
   and the owner's own software**: Claude Code via MCP, Open WebUI, the
   owner's scripts, the council the owner asks, and the applications listed in
   `docs/clients.md`. Volumes stay "ordinary, individual".
2. **Content the owner generates and then publishes is the owner's use**: a
   batch that writes recipes into a database, an article draft, images for a
   site. Who reads the result afterwards does not matter, as with any text
   written with Claude and published.
3. **A request another person triggered may be answered by a subscription
   provider only when all four conditions above hold.** app-one's `/dinner`
   is the case that settled this: a parent types a fixed command, the Worker
   builds the prompt from the menu, the month, the dishes already
   suggested and a set of taste codes taken from a closed list, and sends a
   dinner suggestion back. No word the parent wrote reaches the model. That
   is the software using the owner's subscription to run itself.
4. **A path that takes free text from another person uses something else**:
   free-tier inference (app-one already holds a Gemini free-tier key),
   self-hosted (the platform), or API keys if the no-pay-per-use rule is ever
   lifted. This is not a matter of volume and cannot be bought off with a
   rate limit.
5. Never pool accounts, and give every application its own service token —
   never a shared one, and never a token belonging to someone else's app
   (`docs/clients.md`).
