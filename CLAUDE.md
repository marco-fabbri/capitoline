# Capitoline

Personal AI gateway: OpenAI-compatible HTTP API and MCP server in front of the
official Claude Code, Codex and Antigravity CLIs, running on the owner's own
subscriptions.

## Rules for anyone working in this repo

- **The repository is public.** Nothing about the owner's infrastructure,
  applications, employers or clients goes into it: no hosts, IPs, internal
  domains or names. Those live in the host overlay. `.githooks/` enforces it
  on the owner's machine against a private pattern list kept outside the
  repository (`git config core.hooksPath .githooks`).
- **No private application in a rationale, even unnamed.** Every change is
  justified in terms that hold for any user of the gateway. The internals,
  numbers or needs of one of the owner's applications never appear in code,
  comments, docs, commit messages, release notes or pull request bodies: "an
  application needs N" is not a reason, why N makes sense for anyone is.
  `.githooks/public-check` refuses the usual phrasings, and
  `.claude/hooks/public-text` runs the same check on every `gh` or `git tag`
  command that publishes text, which no git hook sees.
- **English only** for everything in the repository: code, comments, docs,
  specs, plans, README, commit messages. The conversation with the owner may
  be in Italian; the repo never is.
- The CLIs are used **as processes** through their official non-interactive
  commands. Never read, copy or reuse their OAuth tokens or credential files.
- The CLIs are agents. Every execution goes through `src/runner` (empty temp
  working directory, tools disabled, separate `runner` user, timeout). Never
  call `spawn` from a provider adapter.
- Anything that depends on a CLI's flags, model aliases or output format lives
  in `config/capitoline.yaml`, not in code.
- Design spec: `docs/specs/2026-09-19-capitoline-design.md`.

## Designs and plans

Designs live in `docs/specs/`, plans in `docs/plans/` (owner, 2026-11-26), never in a folder
named after a tool. Until that day both sat in `docs/superpowers/`, named after a Claude Code
plugin the owner has turned off; no document here asks for a skill of that plugin.
