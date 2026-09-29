# Terms of service: can you use Capitoline with your accounts, and for what

**A personal interpretation, not legal advice.** This is the reading of the
author of Capitoline, who is not a lawyer, of the terms of four AI providers —
Anthropic, OpenAI, Google and xAI — as they stood on 2026-09-28 (first read
2026-09-21), with the sentences that matter quoted verbatim from the
providers' own pages. Nothing
here has been reviewed by a lawyer or confirmed by any provider. A provider
can change its terms at any time and is the only authority on what they mean;
anyone relying on this for their own accounts should read the terms that
bind them, and take legal advice where it matters.

How this installation applies the reading is a separate document,
`docs/deployment-policy.md`.

## The answer

**Yes, for your own use — with a different strength for each provider.**
Capitoline runs each provider's official CLI — `claude -p`, `codex exec`,
`agy -p` — unmodified, in the headless mode the provider documents for
scripts, signed in with your own account, and puts an OpenAI-compatible API
and an MCP server in front of it. How firmly the texts support that differs:

- **Anthropic:** a clean yes. Its terms forbid automated access "except …
  where we otherwise explicitly permit it", and its help center names
  `claude -p` as drawing on the plan.
- **OpenAI:** yes by its product documentation, which describes `codex exec`
  in scripts with a ChatGPT sign-in; the European terms, read literally,
  forbid programmatic extraction of output with no exception.
- **Google:** an interpretation against the literal text. The Antigravity
  terms call third-party tools that access the Service a breach; the reading
  below relies on the official CLI, not Capitoline, being what accesses it.
  This is the provider where the reading is a bet on how the text is
  enforced.
- **xAI:** not applicable yet. Capitoline has no xAI provider; a spike on
  2026-09-29 signed Grok Build in with a subscription on a headless host.
  Output must be attributed to xAI's service.

What Capitoline supports today: the Claude, Codex and Antigravity CLIs,
signed in with a subscription — the path tested in production. Signing the
CLIs in with API keys or workspace tokens instead is untested.

Beyond whether scripting is allowed, the terms regulate **who uses the
account and whose data goes through it**. That gives three regimes:

1. **Your personal plan** (Claude Pro or Max, ChatGPT Plus or Pro, Google AI
   Pro). You and your own software. Not other people asking their
   own questions, not Capitoline as a service, not data that is not yours to
   send.
2. **Your seat on a business plan** (Claude Team or Enterprise, ChatGPT
   Business or Enterprise, Gemini Enterprise). The same as above — a seat is
   still one person's — but under the agreement the company signed, which is
   where work data belongs.
3. **Credentials the company holds** (an Anthropic API key, a ChatGPT
   workspace service account, a Gemini Enterprise key, an xAI API key). The
   only regime in which Capitoline may answer other people's own questions:
   an internal service for colleagues, run by the company, billed to it.

At a glance, with the evidence under **The evidence, provider by provider**:

| | Anthropic | OpenAI | Google | xAI |
|---|---|---|---|---|
| Scripted use of the official CLI | explicitly permitted | documented; the European terms have no carve-out | documented; the consumer terms carry the widest restriction | documented; only "unauthorized" automation is forbidden |
| Making the account available to others | forbidden | forbidden | not stated in the texts read | forbidden |
| Clause on third-party tools | no routing "on behalf of their users" | — | "products not provided by us" | — |
| Output attribution | not stated | not stated | not stated | permission and attribution required |
| Path for a shared service | company API keys | workspace service accounts (pay-as-you-go plans only) | Gemini Enterprise, under administrator terms not quoted here | Enterprise terms, not read |
| How firm the reading is | firmest | rests on product documentation | against the literal text | no Capitoline provider yet |

## What you can and cannot do

"Can" means within this reading, not a guarantee. The account decides most
answers: the same example changes verdict when it moves from a personal plan
to credentials the company holds.

### The line, and four conditions

The question that decides almost everything is **whether anyone but the
account holder can put words in front of a model** — not who reads the
answer, but who writes the prompt. The providers' clauses forbid routing
requests "on behalf of their users" (Anthropic) and making the account
"available to anyone else" (Anthropic, OpenAI, xAI). Read broadly, that
would forbid any request whose answer serves another person — even a script
that summarises your mail for a family member. Read narrowly, it forbids
letting other people use your subscription as their own model. This
document takes the narrow reading, because Anthropic's sentence sits in a
paragraph about OAuth and about developers who should use API keys, and
names products that let *their* users spend the developer's plan. The
residual risk is that a provider applies the broad one, and for Google the
literal text goes further than either.

Three different things follow, and they are kept apart:

- **Content you generate yourself** and then publish or give to others is
  your use, whoever reads it.
- **Data about other people that you process for your own purposes** —
  summarising your mail, reading logs that contain customers' messages — is
  your use of the account, but a question of whether the data is yours to
  send (**What the providers may do with your content**).
- **A request someone else triggers** — a person pressing a button in your
  software — is the case the clauses are about.

For the third case, this document proposes four conditions. **They are the
author's conservative operating rules drawn from the narrow reading, not
contract text**, and a provider could read even a fixed button as its user
talking to the model. All four must hold:

1. **No text another person wrote reaches a prompt.** Every value a person
   supplies is chosen from a closed list the software defines, or is data the
   software itself produced. A free-text field that lands in a prompt fails
   this outright.
2. **Personal volume.** "Ordinary, individual usage", in Anthropic's words:
   a few dozen calls a day, not a product's traffic.
3. **Nothing is sold.** No subscription, no per-use charge, no access resold.
4. **No provider is named or branded in the output.** The output is the
   software's, not an answer presented as coming from Claude, Codex or
   Gemini. For xAI this inverts: its terms require you "to obtain our
   permission and attribute your generation of the Output to the Service".

### On your own plan

You can:

- **Ask the models yourself, from anything.** Claude Code on your laptop
  calling `ask_model` or `ask_council` over MCP; Open WebUI pointed at the
  gateway for your own chats; a script that asks Codex to review a diff
  before you commit.
- **Let your software run on it, for you.** A nightly job that drafts the
  articles of your travel blog and publishes them after you read them; a
  batch that fills your recipe app's database; images for your own site.
  Content you generate and then publish is your use; who reads it afterwards
  does not matter.
- **Use it for paid work or on a monetised site**, as far as the texts go:
  Anthropic's Commercial Terms explicitly exclude "Claude Pro use for
  individuals or entities", so a personal Anthropic plan may be used for work;
  OpenAI's European terms apply extra terms "If you use our Services for
  commercial or business use" rather than forbidding it; the Google and xAI
  texts read here do not address it.
- **Point your own tools at it** — an IDE or coding assistant on your machine
  that speaks the OpenAI API, used by you, is the first case in this list.
- **Let your software serve other people, within the four conditions.** A
  family-meal bot: a parent presses a fixed "what's for dinner" button, the
  software builds the prompt from the menu, the season and
  preferences picked from a closed list, and sends back a suggestion. The
  parent receives the software's output and never talks to the model.

You cannot:

- **Give someone a way to ask their own questions.** A gateway key for your
  partner's chat app; a Telegram bot where anyone types a question and your
  plan answers it; an Open WebUI shared with friends. That is the account
  "available to anyone else", whatever the key is called.
- **Add a free-text field to an app that is otherwise fine.** A *tell us
  what your child likes* box in prose instead of a closed list turns the
  family-meal bot into the case above. That path needs something else: a
  free-tier key, the company's or your own inference, or a paid API.
- **Sell it or offer it as a service**, even at cost.
- **Send data that is not yours to send.** Your employer's documents, its
  customers' tickets, other people's personal data: on a consumer plan they
  fall under the content clauses below, with no data processing agreement.
- **Pool accounts to multiply limits.** Two subscriptions of one provider
  behind one gateway, to get twice the allowance, is what OpenAI's terms
  call "circumventing any rate limits or restrictions", as does xAI's
  policy, and it is not "ordinary, individual usage" in Anthropic's sense.

### On a seat of a business plan

The same lists: a colleague asking their own questions through your seat is
the shared-account case again. What changes is the data. Work material —
your company's code, documents, tickets — belongs here, under the agreement
the company signed. On Google the consumer Antigravity terms, widest clause
included, stop applying under Gemini Enterprise.

### With credentials the company holds

You can, for example:

- **Run an internal ticket-triage service** on a Codex service account of the
  company's ChatGPT workspace — the "shared integration" OpenAI's service
  accounts exist for.
- **Give colleagues internal agents** on the company's Anthropic API key,
  which Anthropic allows "for use by the customer's own authorized users" as
  long as the company is billed.
- **Put the council in front of a team**, each caller with a gateway key of
  their own, so `/v1/usage` shows who spent what.

The prerequisites differ by provider: OpenAI's service accounts "are
available only on pay-as-you-go plans"; Anthropic's allowance is for the
customer's own authorized users, billed to the key owner; Google's route
rests on the administrator's agreement, which is not quoted here; xAI's
Enterprise terms were not read. Offering Capitoline to people outside the
company as a product is a different case again: Anthropic requires its
Commercial Terms and that "Each end user must authenticate with their own"
credentials. Capitoline never touches the credential — the CLI signs in with
whatever the host gives it — so this is configuration on the host, and
paying per use is the company's decision.

One case Capitoline cannot serve today: a single shared instance where each
person signs in with their own seat. Each CLI behind Capitoline has one
sign-in, so every request through it spends that one account; per-user
credentials would need one instance, or one set of CLI homes, per person.

## Checklist for anyone installing Capitoline

- **Your own accounts only**, one per provider. Never pool accounts.
- **One gateway credential per application** — a gateway key or a service
  token, never shared between applications, and never handed to a person
  for their own questions on a personal plan.
- **Check each application against the four conditions** before it serves
  anyone but you, and again when it gains a text field.
- **Turn training off** on personal plans if anything you would rather keep
  goes through them, and remember the exceptions (feedback you give,
  safety review).
- **No data that is not yours on a personal plan.** Work data goes on a
  business seat or on company credentials.
- **Company credentials live in the host's secrets**, never in the
  repository, under the agreement the company signed.
- **Re-read the terms** when a provider announces a change to its plans or
  terms, and when a CLI update changes how it signs in.

## The evidence, provider by provider

Every quote below was taken on 2026-09-28 from the raw text of its page; the
pages that refuse scripts were read in a browser. The author lives in the
EEA, so where a provider publishes European terms those are the ones quoted.

### Anthropic

Sources: [Consumer Terms](https://www.anthropic.com/legal/consumer-terms)
(effective October 8, 2025);
[Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance);
[Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
(June 16, 2026).

- Automation: the Consumer Terms forbid, "Except when you are accessing our
  Services via an Anthropic API Key or where we otherwise explicitly permit
  it, to access the Services through automated or non-human means, whether
  through a bot, script, or otherwise." The explicit permission is in the
  help center: "Claude Agent SDK, claude -p , and third-party app usage still
  draw from your subscription's usage limits". The same page records a change
  announced for June 15, 2026 and paused — `claude -p` usage moving off the
  plan to a separate monthly credit; if it resumes, a personal plan behind
  Capitoline behaves differently.
- Volume: "Advertised usage limits for Pro and Max plans assume ordinary,
  individual usage of Claude Code and the Agent SDK."
- Sign-in and sharing: "OAuth authentication is intended exclusively for
  purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription
  plans and is designed to support ordinary use of Claude Code and other
  native Anthropic applications." "Anthropic does not permit third-party
  developers to offer Claude.ai login into their own applications, or to
  route requests through Free, Pro, or Max plan credentials on behalf of
  their users." And: "You may not share your Account login information,
  Anthropic API key, or Account credentials with anyone else or make your
  Account available to anyone else."
- Products and services: "preinstalling or running Claude Code in your
  products or services (e.g. in hosted sandboxes or other agent
  infrastructure) requires agreeing to our Commercial Terms of Service", and
  "Customers may not pay for, resell, or intermediate Claude usage on their
  end users' behalf. Each end user must authenticate with their own
  Anthropic API key, Claude subscription plan credentials, or 3P inference
  provider credential".
- Business path: the routing restriction "does not restrict how customers
  provision and manage their own API keys or third-party inference provider
  credentials — for example, configuring an API key in a development
  environment, secrets manager, or machine image for use by the customer's
  own authorized users — provided the resulting usage is billed to the key
  owner under their agreement with Anthropic (or the applicable provider)
  and is not resold or intermediated".

**Reading.** Your own use of the unmodified binary in its documented
headless mode is the firmest case of the four. The sentence closest to a
gateway is the one about "running Claude Code in your products or services
(e.g. in hosted sandboxes or other agent infrastructure)". A self-hosted
instance that only its owner uses is read here as the owner's own tooling,
not a product or service; the moment it serves other people's own questions
on a personal plan, it plausibly becomes one, which is the same line as
above. The commercial paragraph is the answer for offering Capitoline to
others: commercial terms, and every end user with their own credentials. A company's API key used by its own people
through Capitoline is the case the last quote describes.

### OpenAI

Sources: [Europe Terms of Use](https://openai.com/policies/eu-terms-of-use/)
(updated 16 January 2026; for residents of the EEA, Switzerland and the UK);
[Codex pricing](https://developers.openai.com/codex/pricing);
[Codex non-interactive mode](https://developers.openai.com/codex/noninteractive);
[Codex authentication](https://developers.openai.com/codex/auth);
[Codex access tokens](https://developers.openai.com/codex/enterprise/access-tokens);
[Codex service accounts](https://developers.openai.com/codex/enterprise/service-accounts).

- Scope: the terms cover OpenAI's "services for individuals", "including
  personal, non-commercial use of our Services by consumers", and have an
  addendum for "commercial or business use".
- Sharing: "You may not share your account credentials or make your account
  available to anyone else and are responsible for all activities that occur
  under your account."
- Automation: among the things one may not do, "Automatically or
  programmatically extracting data or Output (defined below)." The European
  text has no exception; the version for the rest of the world, read on
  2026-09-21 and not re-readable from the EEA on 2026-09-28, adds "except as
  permitted through the API".
- The product's own documentation: "Non-interactive mode lets you run Codex
  from scripts (for example, continuous integration (CI) jobs) without
  opening the interactive TUI." "codex exec reuses saved CLI authentication
  by default." Sign-in: "Codex supports two ways for a person to sign in when
  using OpenAI models", the first "Sign in with ChatGPT for subscription
  access", with a path for "a remote or headless environment". Codex is
  included in "your ChatGPT Free, Go, Plus, Pro, Business, Edu, or
  Enterprise plan".
- Business path: access tokens "authenticate trusted non-interactive local
  workflows, including Codex CLI and app-server-based automation, with a
  ChatGPT workspace identity" and are "currently supported for ChatGPT
  Business and Enterprise workspaces". Service accounts "let you run and
  scale headless Codex workflows across your organization without relying
  on an employee's account. Each continuous integration (CI) runner,
  scheduled job, or shared integration gets its own ChatGPT workspace
  identity" — and "Service accounts are available only on pay-as-you-go
  plans."

**Reading.** Taken literally, the European clause against programmatically
extracting Output would forbid every scripted use of Codex, including the one
OpenAI documents. The reading taken is that the product documentation defines
the permitted programmatic use of the product: the clause targets scraping
the ChatGPT service, and `codex exec` is the Codex service. In the European
text this rests on the documentation, not on an exception in the terms. A
shared internal service has a clear home: a workspace service account.

### Google

Sources: [Antigravity Additional Terms of Service](https://antigravity.google/terms)
(undated page); [Antigravity plans](https://antigravity.google/docs/plans/);
[Antigravity CLI headless mode](https://antigravity.google/docs/cli/headless/);
[Google Terms of Service](https://policies.google.com/terms) (effective July
30, 2026).

- The Antigravity terms: "You must not abuse, harm, interfere with, or
  disrupt the Service. This includes, but is not limited to, using the
  Service in connection with products not provided by us. Using third party
  software, tools, or services to access the Service (e.g. using OpenClaw
  with Antigravity OAuth) is a breach of this Agreement. Such actions may be
  grounds for suspension or termination of your Antigravity and/or Gemini CLI
  accounts."
- The product's own documentation: headless mode exists to "Run Antigravity
  CLI non-interactively to script agent tasks, integrate with CI pipelines,
  and capture machine-readable output", and to be used "whenever you need
  the agent's output in a program instead of a terminal UI."
- Third-party models: "If you select a third party or open source model as
  your main agent model, you will be subject to the terms of that model. For
  Anthropic specifically, you agree to be bound by its terms and conditions
  found at https://www.anthropic.com/legal/commercial-terms ."
- Limits: "Usage limits for this service are subject to modification."
- Business path: "If you are accessing the Service through Gemini Enterprise
  (Google Cloud), Gemini Enterprise for Business or a Google Workspace
  subscription on the Google Cloud Pre-GA Offering Terms, or with a Gemini
  Enterprise API Key, then you are subject to the terms of use accepted or
  signed by your administrator applicable to such service (including its
  applicable terms for downloadable software) and the terms below do not
  apply to you."

**Reading.** Read literally, Capitoline falls inside both sentences: it is
a product not provided by Google, used in connection with the Service, and a
third-party tool in front of the account. The reading taken rests on a
distinction the text does not make explicitly: what accesses the Service is
the official `agy` binary, in the headless mode Google documents for use in
a program, and the example the clause names — a third-party tool reusing the
Antigravity OAuth token — is precisely what Capitoline never does. That is a
bet on how Google applies the clause, not a reading the words compel. It is the most
exposed of the four, and the consequence it names is the loss of both the
Antigravity and the Gemini CLI accounts. Under Gemini Enterprise the clause
does not apply at all.

### xAI

Sources: [Terms of Service – Consumer](https://x.ai/legal/terms-of-service)
(last updated September 11, 2026);
[Acceptable Use Policy](https://x.ai/legal/acceptable-use-policy) (effective
August 14, 2026); [Grok Build](https://docs.x.ai/build/overview);
[Brand Guidelines](https://x.ai/legal/brand-guidelines) (dated February 14,
2025, read 2026-09-29). Capitoline has no xAI provider: one was measured as
a council member and declined for reasons of quality, not terms (README,
"Providers considered and declined"); this reads the terms for anyone who
builds one.

- Sharing: "You may not share your account credentials or make your account
  available to anyone else, and are responsible for all activities that
  occur under your account."
- Automation, in the Acceptable Use Policy, prohibited: "Accessing the
  Services through unauthorized automated or non-human means, whether
  through a bot, script, or otherwise". Grok Build's own documentation:
  "Headless usage is ideal for scripts, automations, or integration into
  other apps." Its sign-in: "On first launch, Grok opens a browser for
  authentication. In non-browser environments, use an API key" — but the
  CLI itself offers "device-code authentication for headless/remote
  environments" (`grok login --device-auth`, Grok Build 1.0.41), which
  signed a SuperGrok subscription in on a headless host in a spike on
  2026-09-29, with no API key.
- Attribution, unlike the other three: "When using Output or SpaceXAI's
  name, logos, trademarks, or other brand elements, you are required to
  obtain our permission and attribute your generation of the Output to the
  Service". The policy also prohibits "Misleading others or not being
  transparent regarding your use of AI, including by phishing, creating fake
  accounts, providing services that appear to be from you, when they are in
  fact from SpaceXAI". The Brand Guidelines the terms point to say where
  the attribution goes: "please attribute them to SpaceXAI and Grok by
  displaying one of the following phrases in a legible and noticeable
  manner wherever the Grok-generated material is published or distributed:
  Written with Grok / Created with Grok".
- Business path: "Our Enterprise Terms of Service govern the use of our
  Services for developers and businesses, including SpaceXAI APIs and
  PromptIDE."

**Reading.** Automation is permitted where authorised, and Grok Build's
headless mode is authorised by its own documentation, and a subscription
can sign in on a headless host. What would shape an xAI provider is the
fourth condition, which inverts: xAI output must be attributed to the
service, not left unbranded — wherever it is published or distributed, so
the obligation falls on what an application shows to others, not on
private use or on how the output is processed before that.

## What the providers may do with your content

This decides what may go through a personal plan. Capitoline changes nothing
here: the CLI signs in with the same account the provider's own apps use.

- **Anthropic** (Consumer Terms): "We may use Materials to provide, maintain,
  and improve the Services and to develop other products and services,
  including training our models, unless you opt out of training through your
  account settings. Even if you opt out, we will use Materials for model
  training when: (1) you provide Feedback to us regarding any Materials, or
  (2) your Materials are flagged for safety review".
- **OpenAI** (Europe Terms): "We can use your Content worldwide to provide,
  maintain, develop, and improve our Services", with an opt-out ("If you do
  not want us to use your Content to train our models, you have the option to
  opt out by updating your account settings").
- **Google** (Antigravity terms): "We use Interactions to evaluate, develop,
  and improve Google and Alphabet research, products, services and machine
  learning technologies." And: "Google employees and contractors may access,
  view, review and use Interactions."
- **xAI** (Consumer Terms): inputs come with "an irrevocable, perpetual,
  transferable, sublicensable, royalty-free, and worldwide right to
  SpaceXAI".

None of the four consumer texts contains a data processing agreement
(checked by searching each of them), which
GDPR (Art. 28) requires when a company has a provider process personal data
on its behalf. Each provider points businesses to its business terms:
Anthropic's Commercial Terms for "Team, Enterprise, and Claude API users";
OpenAI's "Business Terms govern use of ChatGPT Enterprise, our APIs, and our
other services for businesses and developers"; Google's administrator terms
above; xAI's Enterprise terms. The business agreements themselves were not
read for this document.
