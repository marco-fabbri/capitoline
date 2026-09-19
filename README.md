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

## Status

Design stage. The phase 1 spec is in
[`docs/superpowers/specs/2026-09-19-capitoline-design.md`](docs/superpowers/specs/2026-09-19-capitoline-design.md).

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
