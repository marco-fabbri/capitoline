# Capitoline

Personal AI gateway: OpenAI-compatible HTTP API and MCP server in front of the
official Claude Code, Codex and Antigravity CLIs, running on the owner's own
subscriptions.

## Rules for anyone working in this repo

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
- Design spec: `docs/superpowers/specs/2026-09-19-capitoline-design.md`.
