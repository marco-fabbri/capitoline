# Security

Capitoline holds credentials and runs agents: the gateway keeps its own API
keys (hashed) and verifies Cloudflare Access tokens, and every request ends in
a CLI started through `sudo` as a separate `runner` user that is logged in to
the owner's subscriptions. A flaw here can hand someone else those
subscriptions, or a shell as `runner`.

## Reporting a vulnerability

Please report it privately, through GitHub's **Report a vulnerability** button
on this repository's Security tab (private vulnerability reporting), not in a
public issue. Say what you found, how to reproduce it and what it gives an
attacker. You will get an answer, and a fix or a reasoned decision, as soon as
the author can manage; this is a personal project with no service levels.

## What is in scope

- Authentication and authorization: the gateway keys, the admin API, the
  Cloudflare Access verification, the open-until-first-key state.
- Anything that lets a request reach a CLI tool, a file or a command it should
  not: the sandbox, the tool lockdown per CLI, the image collection helper and
  its sudoers rule.
- Leaks of prompts, answers, credentials or CLI stderr through responses,
  `/health`, logs or the usage database.

Out of scope: the providers' own CLIs and services, and a host where someone
already has root.
