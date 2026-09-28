# Terms of service: what the CLI-behind-an-API pattern is allowed to do

**An interpretation, not legal advice.** This is the owner's reading of the
four providers' terms as they stood when they were last read, with the
sentences that matter quoted verbatim from the primary pages. It records which
reading Capitoline follows and why, so that a change in a text — or a
provider enforcing a broader reading than the one taken here — is visible
rather than discovered. A provider can change its terms at any time and is
the only authority on what they mean.

First read 2026-09-21; the boundary redrawn 2026-09-22; **re-read in full
2026-09-28**, when xAI was added and every quote was taken again from the raw
text of its page (the pages that refuse scripts were read in a browser). The
owner lives in Italy, so where a provider publishes European terms those are
the ones quoted.

Re-read it when a provider announces a change to its plans or terms, when a
CLI update changes how it signs in, and before adding a provider
(`docs/update-clis.md`).

## The pattern

Capitoline runs the unmodified official CLIs (`claude -p`, `codex exec`,
`agy -p`) as processes, each authenticated once by the owner with the owner's
own subscription, and exposes their answers over an OpenAI-compatible HTTP
API and an MCP server. Two things decide who can reach it: Cloudflare Access
in front, and keys the gateway issues itself (`/v1/admin/keys`, design §4).
Both are the owner's to hand out, which is exactly why this document exists.

The question that decides everything is **whether anyone but the owner can
put words in front of a model**. Not who reads the answer: who writes the
prompt. **Where the line is**, below, says why.

## Anthropic (Claude Max)

Sources, read 2026-09-28:
[Consumer Terms](https://www.anthropic.com/legal/consumer-terms) (effective
October 8, 2025);
[Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance);
[Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
(June 16, 2026).

- Consumer Terms forbid, "Except when you are accessing our Services via an
  Anthropic API Key or where we otherwise explicitly permit it, to access the
  Services through automated or non-human means, whether through a bot,
  script, or otherwise." The explicit permission is Anthropic's own: headless
  `claude -p` is a documented feature, and the help center states that
  "Claude Agent SDK, claude -p , and third-party app usage still draw from
  your subscription's usage limits".
- The same help page records a change announced for June 15, 2026 and then
  paused: `claude -p` usage would have stopped counting toward the plan and
  moved to a separate monthly credit. It did not happen; if it resumes, the
  Claude provider's economics change, and this document with them.
- Claude Code legal page: "Advertised usage limits for Pro and Max plans
  assume ordinary, individual usage of Claude Code and the Agent SDK."
- Same page: "OAuth authentication is intended exclusively for purchasers of
  Claude Free, Pro, Max, Team, and Enterprise subscription plans and is
  designed to support ordinary use of Claude Code and other native Anthropic
  applications." And: "Anthropic does not permit third-party developers to
  offer Claude.ai login into their own applications, or to route requests
  through Free, Pro, or Max plan credentials on behalf of their users."
- Same page, for anyone who builds Claude Code into something offered to
  others: "preinstalling or running Claude Code in your products or services
  (e.g. in hosted sandboxes or other agent infrastructure) requires agreeing
  to our Commercial Terms of Service", and "Customers may not pay for,
  resell, or intermediate Claude usage on their end users' behalf. Each end
  user must authenticate with their own Anthropic API key, Claude
  subscription plan credentials, or 3P inference provider credential".
- Consumer Terms: "You may not share your Account login information,
  Anthropic API key, or Account credentials with anyone else or make your
  Account available to anyone else."

**Reading.** The owner asking Claude questions through his own tooling is
ordinary individual use of the unmodified binary, in the mode Anthropic
documents for scripts; it is the firmest of the four. The clause about
routing requests "on behalf of their users" decides everything else and is
read once, below, for all providers. The commercial paragraph is the answer
for anyone else who installs Capitoline: it is a personal tool, each
installation runs on its owner's own subscriptions for its owner's own use,
and offering it to other people as a service is the case that paragraph
covers — commercial terms, and every end user signing in with their own
credentials.

## OpenAI (ChatGPT Pro, Codex)

Sources, read 2026-09-28:
[Europe Terms of Use](https://openai.com/policies/eu-terms-of-use/)
(updated 16 January 2026; they apply to residents of the EEA, Switzerland and
the UK); [Codex pricing](https://developers.openai.com/codex/pricing);
[Codex non-interactive mode](https://developers.openai.com/codex/noninteractive);
[Codex authentication](https://developers.openai.com/codex/auth).

- Scope of the terms: they cover OpenAI's "services for individuals",
  "including personal, non-commercial use of our Services by consumers".
- "You may not share your account credentials or make your account available
  to anyone else and are responsible for all activities that occur under your
  account."
- Among the things one may not do: "Automatically or programmatically
  extracting data or Output (defined below)." The European text carries no
  exception. The version for the rest of the world, quoted here on
  2026-09-21 and not re-readable from here on 2026-09-28 (the site serves the
  European one), adds "except as permitted through the API".
- Also: "Interfering with or disrupting our Services, including circumventing
  any rate limits or restrictions".
- Codex pricing: "ChatGPT Work and Codex are included in your ChatGPT Free,
  Go, Plus, Pro, Business, Edu, or Enterprise plan". An API key is described
  as "Great for automation in shared environments like CI."
- Codex documentation, on the mode Capitoline uses: "Non-interactive mode
  lets you run Codex from scripts (for example, continuous integration (CI)
  jobs) without opening the interactive TUI." And: "codex exec reuses saved
  CLI authentication by default." On sign-in: "Codex supports two ways for a
  person to sign in when using OpenAI models", the first being "Sign in with
  ChatGPT for subscription access", and the page gives headless machines a
  path of their own ("You're running the CLI in a remote or headless
  environment"). It asks to "treat ~/.codex/auth.json like a password: it
  contains access tokens".

**Reading.** Read literally, the European clause against programmatically
extracting Output would forbid every scripted use of Codex, including the one
OpenAI documents: `codex exec` in scripts, signed in with ChatGPT, on a
remote or headless machine. The reading taken is that the product
documentation defines the permitted programmatic use of the product — the
clause targets scraping the ChatGPT service, `codex exec` is the Codex
service — and that "available to anyone else" is read as for Anthropic,
below. It is said plainly that in the European text this rests on the
documentation and not on an exception in the terms, which makes OpenAI the
second most exposed after Google.

## Google (AI Pro, Antigravity)

Sources, read 2026-09-28:
[Antigravity Additional Terms of Service](https://antigravity.google/terms)
(undated page); [Antigravity plans](https://antigravity.google/docs/plans/);
[Antigravity CLI headless mode](https://antigravity.google/docs/cli/headless/);
[Google Terms of Service](https://policies.google.com/terms) (effective July
30, 2026, Italian country version);
[Generative AI Prohibited Use Policy](https://policies.google.com/terms/generative-ai/use-policy)
(last modified December 17, 2024).

- Antigravity terms, whole: "You must not abuse, harm, interfere with, or
  disrupt the Service. This includes, but is not limited to, using the
  Service in connection with products not provided by us. Using third party
  software, tools, or services to access the Service (e.g. using OpenClaw
  with Antigravity OAuth) is a breach of this Agreement. Such actions may be
  grounds for suspension or termination of your Antigravity and/or Gemini CLI
  accounts."
- Same terms, on the third-party models Antigravity serves: "If you select a
  third party or open source model as your main agent model, you will be
  subject to the terms of that model. For Anthropic specifically, you agree
  to be bound by its terms and conditions found at
  https://www.anthropic.com/legal/commercial-terms ." So Capitoline's
  `antigravity-claude-*` models answer under Anthropic's commercial terms.
- Antigravity CLI documentation, headless mode: "Run Antigravity CLI
  non-interactively to script agent tasks, integrate with CI pipelines, and
  capture machine-readable output." And: "Use it whenever you need the
  agent's output in a program instead of a terminal UI."
- Plans: "Usage limits for this service are subject to modification." and
  "The baseline rate limits are primarily determined to the degree we have
  capacity, and exist to prevent abuse."
- Google Terms, the only automation clause: "using automated means to access
  content from any of our services in violation of the machine-readable
  instructions on our web pages".

**Reading.** The sentence "using the Service in connection with products not
provided by us" is the widest clause in the four providers' terms, and read
literally it covers Capitoline: a product not provided by Google, used in
connection with the Service. The first reading of this document (2026-09-21)
did not quote it; whether it was added since or missed then cannot be told
from an undated page, and it is recorded now. Against it, Google's own
documentation tells the reader to use headless mode "whenever you need the
agent's output in a program", and the example the clause names is a
third-party tool reusing the Antigravity OAuth token, which Capitoline never
touches. The reading taken: the clause gives examples of abusing, harming or
disrupting the Service, and running the official binary in its documented
headless mode for the owner's own questions is not that. It is the most
exposed of the four, by the text's own wording, and the consequence it names
is the loss of the Antigravity and Gemini CLI accounts: a path that is
marginal anywhere is dropped here first.

## xAI (SuperGrok, Grok Build) — not a Capitoline provider

Sources, read 2026-09-28:
[Terms of Service – Consumer](https://x.ai/legal/terms-of-service) (last
updated September 11, 2026; Europe Specific Terms apply to EEA residents);
[Acceptable Use Policy](https://x.ai/legal/acceptable-use-policy) (effective
August 14, 2026); [Grok Build](https://docs.x.ai/build/overview).

Capitoline has no xAI provider (`docs/backlog.md`, "Grok Build as a fourth
provider"); this section reads the terms for the day one is added.

- "You may not share your account credentials or make your account available
  to anyone else, and are responsible for all activities that occur under
  your account."
- Acceptable Use Policy, among the prohibited: "Accessing the Services
  through unauthorized automated or non-human means, whether through a bot,
  script, or otherwise"; "using bots to access" the Service; "Scraping,
  harvesting or reselling any Input or Output".
- Grok Build documentation: "Headless usage is ideal for scripts,
  automations, or integration into other apps." On sign-in: "On first
  launch, Grok opens a browser for authentication. In non-browser
  environments, use an API key".
- Unlike the other three, xAI asks for attribution rather than forbidding
  it. Terms: "When using Output or SpaceXAI's name, logos, trademarks, or
  other brand elements, you are required to obtain our permission and
  attribute your generation of the Output to the Service". Acceptable Use
  Policy, prohibited: "Misleading others or not being transparent regarding
  your use of AI, including by phishing, creating fake accounts, providing
  services that appear to be from you, when they are in fact from SpaceXAI".
  Terms, on disclosure: "you may be required to apply or SpaceXAI may apply a
  disclosure stating that the content was generated or altered by artificial
  intelligence."

**Reading.** Automation is permitted where authorised, and Grok Build's
headless mode is authorised by its own documentation; sharing the account is
forbidden in the same words as OpenAI's. Two things differ, and both would
shape an xAI provider before it is built. First, a subscription sign-in may
not work on a headless host at all: the documentation sends non-browser
environments to an API key, which is pay-per-use and excluded by the owner's
rule — the spike in the backlog decides. Second, condition 4 below inverts
for xAI: its output must not pass as the owner's own, so an application that
shows Grok's output to someone else discloses that it is AI-generated.

## Side by side

| | Anthropic | OpenAI | Google | xAI |
|---|---|---|---|---|
| Scripted use of the official CLI | explicitly permitted (help center on `claude -p`) | documented (`codex exec` with ChatGPT sign-in); the European terms have no carve-out | documented (headless mode); the Antigravity terms have the widest restriction | documented (headless); the AUP forbids only "unauthorized" automation |
| Account available to anyone else | forbidden | forbidden | not stated beyond "abuse" | forbidden |
| Third-party tools | route requests "on behalf of their users" forbidden | — | "products not provided by us", "third party software, tools, or services to access the Service" | — |
| Branding of output | brand guidelines | brand guidelines | — | attribution and AI disclosure required |
| How firm the owner's reading is | firmest | rests on product docs | most exposed | not yet applicable |

## Where the line is

The quotations that matter are alike: Anthropic forbids a third-party
developer to "route requests through Free, Pro, or Max plan credentials on
behalf of their users", and Anthropic, OpenAI and xAI forbid making the
account "available to anyone else". Google's wording is the loosest and the
widest.

**This is read narrowly, and the reading is stated here rather than assumed.**
Two readings are available. The broad one: any request whose answer serves
another person. The narrow one: do not let other people use your subscription
as their own model — no resale, no proxied login, no free access handed out.

The narrow reading is taken, for a reason that can be checked. The shape the
clause names is a product that lets *its* users sign in with, or spend, the
developer's plan; that is what Anthropic shut down in February 2026, and the
sentence sits in a paragraph about OAuth and about developers who should be
using API keys. The broad reading would also forbid a script that summarises
the owner's mail and sends the summary to his wife, which is not what the
clause pursues and not how anyone reads it.

So the line is drawn at **free-form passthrough**:

- **Not permitted: text of another person's choosing reaching a model.** A
  chat window, an API handed out, a command that forwards whatever was typed.
  If someone else can put words in front of the model, the account has been
  made available to them, and that is the clause.
- **Defensible: the model as an internal component of the owner's software.**
  The code composes the prompt from its own data and its own templates; a
  person presses a button or types a fixed command and receives the
  software's output. They are a recipient of a product, not a user of the
  model.

Four conditions hold the second case up, and all four must hold:

1. **No text another person wrote reaches a prompt.** Every value a person
   supplies is chosen from a closed list the software defines, or is data the
   software itself produced. A free-text field that lands in a prompt fails
   this outright.
2. **Personal volume.** "Ordinary, individual usage", in Anthropic's words.
   A few dozen calls a day, not a product's traffic.
3. **Nothing is sold.** No subscription, no per-use charge, no access resold.
4. **No provider is named or branded in the output.** The output is the
   software's, not an answer presented as coming from Claude, Codex or
   Gemini. For xAI this inverts (above): its output is disclosed as
   AI-generated, which does not change the other three.

The residual risk is not zero and this document will not pretend otherwise:
the broad reading exists, a provider who chose it would be within the words,
and for Google the literal text goes further than the narrow reading. What is
recorded here is which reading is being followed and why, so that if one of
the four conditions stops holding, the change is visible and the path moves
to free-tier or self-hosted inference instead.

## What the consumer terms let the provider do with the content

This matters the moment the content is not the owner's — work documents,
customer tickets, colleagues' data — and it is the same for Capitoline as for
the providers' own apps, because Capitoline changes nothing about which
account the CLI signs in with.

- **Anthropic** (Consumer Terms): "We may use Materials to provide, maintain,
  and improve the Services and to develop other products and services,
  including training our models, unless you opt out of training through your
  account settings. Even if you opt out, we will use Materials for model
  training when: (1) you provide Feedback to us regarding any Materials, or
  (2) your Materials are flagged for safety review".
- **OpenAI** (Europe Terms): "We can use your Content worldwide to provide,
  maintain, develop, and improve our Services"; training can be switched off
  ("If you do not want us to use your Content to train our models, you have
  the option to opt out by updating your account settings").
- **Google** (Antigravity terms): "We use Interactions to evaluate, develop,
  and improve Google and Alphabet research, products, services and machine
  learning technologies." And: "Google employees and contractors may access,
  view, review and use Interactions."
- **xAI** (Consumer Terms): inputs come with "an irrevocable, perpetual,
  transferable, sublicensable, royalty-free, and worldwide right to SpaceXAI"
  to use them, among other things, for "developing new products or features".

None of the four consumer texts read here contains a data processing
agreement. When a company has a provider process personal data on its behalf,
GDPR (Art. 28) requires one, and the providers offer it with their business
plans, which each of them names: Anthropic's Commercial Terms for "Team,
Enterprise, and Claude API users"; OpenAI's "Business Terms govern use of
ChatGPT Enterprise, our APIs, and our other services for businesses and
developers"; Antigravity used "through Gemini Enterprise (Google Cloud),
Gemini Enterprise for Business or a Google Workspace subscription" falls
under "the terms of use accepted or signed by your administrator"; and xAI's
"Enterprise Terms of Service govern the use of our Services for developers
and businesses".

## What can be done, case by case

The reading above applied to the cases that come up. "Yes" means within the
reading this document takes, not a guarantee.

| Case | Verdict | Why |
|---|---|---|
| The owner asks the models himself — Claude Code over MCP, his scripts, the council | **Yes** | Ordinary individual use of the official binaries in their documented headless modes. |
| The owner's software serves other people, the prompt composed by the software (app-one's `/dinner`) | **Yes, within the four conditions** | The model is a component of the owner's software; nobody else writes the prompt. |
| Content the owner generates and publishes (recipes, drafts, images) | **Yes** | The owner's use; who reads the result afterwards does not matter. |
| Other people type their own questions — a chat, a key handed to a friend, a team channel | **No, not on these subscriptions** | The account made "available to anyone else". Business accounts with their own terms, or self-hosted inference. |
| Someone else installs Capitoline on their own accounts, for themselves | **Yes, on their accounts and their reading** | The software is a tool; each installation answers to the terms of its own accounts. |
| Capitoline offered to others as a service on the operator's subscriptions | **No** | Anthropic's commercial paragraph and every provider's account-sharing clause. |
| The owner uses it for his own job, on his own tasks, with material that is his to send | **Yes, subject to the employer's policy** | Anthropic's note puts "Claude Pro use for individuals or entities" outside its Commercial Terms, and OpenAI's European terms have an addendum for "commercial or business use"; neither forbids working with a personal plan. The employer's rules on AI tools come first. |
| The owner runs the employer's or its customers' data through these subscriptions — tickets, logs, customer documents | **Not with these accounts** | The content clauses above apply to it (training unless opted out, Google staff review, xAI's licence) and there is no data processing agreement; the data is not the owner's to send there. Company accounts on business terms, or Capitoline over the company's own models (the platform, `docs/backlog.md`). |
| An internal company service for colleagues — internal agents, a ticket-analysis bot | **Not on personal subscriptions** | Both reasons at once: the account made available to others, and company data on consumer terms. The shape is a company account with API keys under business terms, or Capitoline inside the platform. |
| A company project paid for with an individual's consumer plan | **The company's decision, and a weak shape** | The account and its history belong to the person, not the company, and leave with them; the content clauses above apply to the project's data; no data processing agreement. Anthropic's European terms define a consumer as someone "acting wholly or mainly outside your trade, business, craft or profession", which a company project is not. The same line as above: business work on business plans. |

## What changed in Capitoline, read against the line

- **The gateway's own keys** (`/v1/admin/keys`, 2026-09-27). A key is a
  credential of the owner's gateway, not of any provider account, and it
  makes handing access out a one-line API call. So the line applies to keys
  exactly as to service tokens: a key for an application of the owner's that
  meets the four conditions is the owner's software; a key given to another
  *person* to ask their own questions is the account "available to anyone
  else", whatever the key is called.
- **A claude.ai connector** (open, `docs/backlog.md`). The owner's own
  Claude, through the owner's own gateway, back into the owner's
  subscriptions: owner use. A static connector credential is an
  organization's, sent for every member (Anthropic's connector
  documentation), so it is only acceptable on an account whose only member
  is the owner.
- **Capitoline inside the platform** (backlog). Only the platform's own models; the personal
  subscriptions never sit behind a corporate endpoint. That is the owner's
  rule and stricter than any of the texts above.
- **Anyone else installing Capitoline.** Each installation on its owner's own
  subscriptions for its owner's own use. Running it as a service for others
  is the case Anthropic's commercial paragraph covers, and the other three
  forbid the same thing in their account-sharing clauses.

## Rule for this project

1. **Subscription providers (`claude-*`, `codex-*`, `antigravity-*`) serve the
   owner and the owner's own software**: Claude Code via MCP, Open WebUI, the
   owner's scripts, the council the owner asks, and the applications listed
   in `docs/clients.md`. Volumes stay "ordinary, individual".
2. **Content the owner generates and then publishes is the owner's use**: a
   batch that writes recipes into a database, an article draft, images for a
   site. Who reads the result afterwards does not matter, as with any text
   written with a model and published.
3. **A request another person triggered may be answered by a subscription
   provider only when all four conditions above hold.** app-one's `/dinner`
   is the case that settled this: a parent types a fixed command, the Worker
   builds the prompt from the menu, the month, the dishes already
   suggested and a set of taste codes taken from a closed list, and sends a
   dinner suggestion back. No word the parent wrote reaches the model. That
   is the software using the owner's subscription to run itself.
4. **A path that takes free text from another person uses something else**:
   free-tier inference (app-one already holds a Gemini free-tier key),
   self-hosted (the platform), or API keys if the no-pay-per-use rule is ever lifted.
   This is not a matter of volume and cannot be bought off with a rate limit.
5. **Credentials are per application, never per person.** Never pool
   accounts; every application gets its own credential — a gateway key or a
   service token — never a shared one, never a token belonging to someone
   else's app, and never one handed to a person for their own questions
   (`docs/clients.md`).
6. **Google first.** Where a path is marginal, it is marginal on Antigravity
   first: the widest clause and the consequence it names (both accounts) are
   Google's.
