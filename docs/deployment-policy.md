# Deployment policy: how this installation applies the terms

The analysis is `docs/terms-of-service.md`: a personal interpretation by the
author of Capitoline, who is not a lawyer, of what the providers' terms allow.
This file is the other half — the rules this installation follows because of
that reading, and a few that are stricter than any text, by the owner's own
choice. Where the two disagree, the stricter one wins.

## Rules

1. **Subscription providers serve the owner and the owner's own software.**
   The `claude-*`, `codex-*` and `antigravity-*` models answer the owner —
   Claude Code over MCP, the owner's scripts, the council the owner asks —
   and the owner's own applications, each connected as
   `docs/connecting-an-application.md` describes. Volumes stay "ordinary,
   individual".
2. **Content the owner generates and then publishes is the owner's use.** Who
   reads it afterwards does not matter.
3. **A request another person triggered is answered by a subscription
   provider only when all four conditions hold** (`docs/terms-of-service.md`,
   "The line, and four conditions"). Every application of the owner's is
   checked against them when it is connected and whenever it gains a way
   for a person to type something.
4. **A path that takes free text from another person uses something else**:
   free-tier inference or other inference the owner does not pay per use
   for. It is not a matter of volume and cannot be bought off with a rate
   limit.
5. **Credentials are per application, never per person.** Every application
   gets its own gateway key or service token
   (`docs/connecting-an-application.md`); none is
   ever handed to a person for their own questions, and accounts are never
   pooled.
6. **Google first.** A path that is marginal is marginal on Antigravity
   first: the widest clause, and the loss of both accounts as its stated
   consequence.
7. **No pay-per-use APIs**, by the owner's own rule, which is about the
   owner's money and not a reading of any term. An installation run for a
   company on credentials the company pays for is outside this rule and
   inside that company's agreement.

## The owner's own features, read against the line

- **The gateway's own keys** (`/v1/admin/keys`). A key is a credential of this
  gateway, not of a provider account, and it makes handing access out a
  one-line API call. The line applies to keys exactly as to service tokens: a
  key for an application of the owner's that meets the four conditions is the
  owner's software; a key given to a person to ask their own questions is
  the account "available to anyone else", whatever the key is called.
- **A claude.ai connector** (open, `docs/backlog.md`). The owner's own Claude,
  through the owner's own gateway, back into the owner's subscriptions:
  owner use. A static connector credential is sent for every member of the
  organization that adds it, so it is acceptable only on an account whose
  only member is the owner.
- **Personal subscriptions never sit behind a company's endpoint.** A
  gateway run for a company serves that company's own models or credentials,
  never the owner's personal plans. That is the owner's rule and stricter
  than any of the texts.
