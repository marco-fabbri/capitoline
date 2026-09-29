# Updating the CLIs

The CLIs change almost monthly. They are updated by hand, one at a time,
and every update is followed by the smoke test. Never auto-update.

That rule was written down and not enforced, and it was broken without
anyone noticing: `agy` updates itself every fifteen minutes unless told not
to, and moved from 1.2.7 to 1.2.9 in three days. It is enforced since
2026-09-23 through `/etc/capitoline/runner.env` (`docs/deploy.md` §6), for
`agy` and for Claude Code; Codex never installs updates by itself. Updating
by hand is not updating less: it is knowing when a CLI changed, so that the
checks below run at that moment and a failure after it has a known cause.

What is automatic is knowing that a new version exists. Once a day, with the
model catalog, the gateway reads each CLI's `--version` and the latest one
published — the npm registry for Claude Code and Codex, the official
installer's manifest for Antigravity (`providers.<id>.version`) — and shows
both in `/health` (`providers[].version`); with `server.notify` set it sends
one message per new version (`docs/deploy.md` §7.2). Installing it is the
procedure below, which a person runs.

## Versions in use

| CLI | version | date | notes |
|---|---|---|---|
| Claude Code (`claude`) | 2.1.278 | 2026-09-20 | spike; flags and `stream-json` format recorded in `test/fixtures/claude` |
| Codex CLI (`codex`) | 0.154.0 | 2026-09-20 | spike; `exec --json` events recorded in `test/fixtures/codex` |
| Antigravity CLI (`agy`) | 1.2.7 | 2026-09-20 | spike; `stream-json` in/out recorded in `test/fixtures/antigravity` |
| Codex CLI (`codex`) | 0.155.1 | 2026-09-20 | first host deployment (a Proxmox LXC); same flags as 0.154.0, smoke test pending |
| Antigravity CLI (`agy`) | 1.2.8 | 2026-09-22 | on the host before the model lists were first committed; `agy models` unchanged from 1.2.7 |
| Claude Code (`claude`) | 2.1.280 | 2026-09-23 | Opus 5.5. The alias list is unchanged, so nothing was configured: `opus` simply resolves to the new model, and `GET /v1/usage` `.models` is what records that it did (`docs/deploy.md` §9). Fixture `slash-model.json` re-captured |
| Antigravity CLI (`agy`) | 1.2.9 | 2026-09-23 | **installed by its own updater** at 05:14 UTC, as 1.2.8 had been before it; `agy models` unchanged; self-update disabled the same morning |
| Codex CLI (`codex`) | 0.156.0 | 2026-09-23 | same flags; the model cache is unchanged slug for slug, only its version line moved. Fixture `models.txt` re-captured after one `codex exec`, which is what refreshes the cache |

| Claude Code (`claude`) | 2.1.284 | 2026-09-29 | with `scripts/update-cli.sh`, smoke test passed; the rollback path was exercised on purpose the same day (2.1.283 installed, a failing check, 2.1.284 put back) |
| Codex CLI (`codex`) | 0.159.0 | 2026-09-29 | the script stopped the first attempt: two features newly on by default, `daemon_auto_start` and `write_stdin_approval`, neither a tool of `codex exec`, both now switched off in `providers.codex.args`; second attempt passed, image and tool probe included |
| Antigravity CLI (`agy`) | 1.2.13 | 2026-09-29 | with `scripts/update-cli.sh`; the installer refuses to overwrite an installed binary, so the script removes it first; `agy models` unchanged; `AGY_CLI_DISABLE_AUTO_UPDATE` still honoured ("Auto-update disabled via environment variable" in its log) |

Add a row for every update, newest last.

## The model lists

Exposing a new model, or withdrawing a retired one, no longer waits for an
update: the gateway asks Codex and Antigravity for their models once a day
and adjusts on its own (`docs/deploy.md` §7.2), and `/health` shows what it
found. What an update still calls for is refreshing the committed lists the
tests check the configuration against, so a declared model that no longer
exists fails a test instead of being retired in production unnoticed:

```sh
cd /tmp && codex debug models | jq '{models: [.models[] | {slug, display_name, visibility, supported_reasoning_levels: [.supported_reasoning_levels[] | {effort}]}]}' > debug-models.json   # test/fixtures/codex/debug-models.json
cd /tmp && agy models > models.txt                                                                                                                                         # test/fixtures/antigravity/models.txt
```

Claude has no list to refresh: its names are aliases that follow the latest
model (`opus` moved from Opus 5 to Opus 5.5 with nothing configured).

## After updating Codex: the tool surface

The smoke test proves a model answers. It cannot see that a new version
switched a tool on, and Codex does that by default: on 2026-09-23 a text
request through the gateway generated an image, because 0.155 and 0.156 had
turned on image generation, plugins, sub-agents and nine more tools that the
configuration of 0.154 had no reason to name. So after every Codex update,
as `runner`:

```sh
cd /tmp && codex features list | awk '$NF == "true" {print $1}'
```

`scripts/update-cli.sh` does this comparison itself: it stops, and puts the
previous version back, when the new version enables a feature the previous
one did not and `providers.codex.args` does not already switch off. Such a
feature is either harmless — a terminal or app-UI feature, which `codex exec`
never uses — or a tool that has just been handed to every client. Read its
definition in Codex's source (`codex-rs/features/src/lib.rs`, each feature is
documented there), switch it off in `providers.codex.args` either way — a
default nobody has read is not left on — and add it to the list
`test/config.test.ts` pins, then run the script again.

Then the script asks the question that matters directly: it runs Codex
exactly as the gateway does and asks it to execute a shell command
(`scripts/codex-tool-probe.mjs`). Any step in the stream other than the
model's words — a `command_execution`, a file change, an MCP call — fails
the update. Asking the model to *list* its tools, as this section once
advised, is not evidence: on 2026-09-29 GPT-6 Luna listed `functions.exec`
and six `collaboration.*` tools, then, asked to use exec, answered CANNOT
and the stream held no command. With the shell switched back on for a test
the probe does report `command_execution` and fails, which is what it is for.

## Procedure

On the host, as root, from the clone:

1. Update one CLI with the script, and read what it prints:

   ```sh
   cd /var/lib/capitoline/app && scripts/update-cli.sh codex      # or claude, antigravity (agy); a version may follow for npm CLIs
   ```

   It records the installed version (and, for Antigravity, whose installer
   only installs the latest, a copy of the binary), installs as `runner`,
   checks Codex's new features and tool behaviour (the section above), runs
   the smoke test below with one image from the CLI's own image model through
   a temporary gateway key it revokes afterwards, and **puts the previous
   version back if any of that fails**, then smoke-tests the restored one.
   On success it prints the row for the table above. No restart is needed:
   the gateway starts a CLI per request. What follows is what the script
   automates, and what to do by hand when it stops.

2. Run the smoke test against the running service (`curl` and `jq` must be
   installed where it runs). With Cloudflare Access enabled (`docs/deploy.md`
   §9) the loopback address answers `401` to every call, so the test goes
   through the tunnel with the service token, from the host or from the Mac:

   ```sh
   cd /var/lib/capitoline/app && \
     CF_ACCESS_CLIENT_ID=<id> CF_ACCESS_CLIENT_SECRET=<secret> \
     scripts/smoke.sh https://api.example.com
   ```

   Only while `server.access.team_domain` is still empty can it run locally:
   `scripts/smoke.sh http://127.0.0.1:8080` (see `docs/deploy.md` §12).

3. If the updated CLI's line is not `200`:
   - compare the CLI's `--help` with its `args` in the clone's
     `config/capitoline.yaml` — the flags live in the repository, not on the
     host (`docs/deploy.md` §7) — and with the parser in
     `src/providers/<id>.ts` (`claude.ts`, `codex.ts`, `antigravity.ts`);
   - capture a new fixture with the same command used in
     `docs/spike-2026-09.md` §3 for that CLI, sanitize paths and user names,
     and put it next to the existing ones in `test/fixtures/<id>/`;
   - fix the config and/or the parser, run `npx vitest run`, commit;
   - deploy the fix: `git pull`, `npm ci`, `npm run build`, re-install the
     collection helper (`install -o root -g root -m 0755
     /var/lib/capitoline/app/scripts/capitoline-collect-image
     /usr/local/bin/capitoline-collect-image`, `docs/deploy.md` §7.1 — the
     installed copy is a snapshot of the clone, not a link, so without this
     a change to the helper has no effect), `systemctl restart capitoline`;
     then run the smoke test again. The configuration change arrives with the
     pull: the host's `/etc/capitoline/overlay.yaml` holds only what is local
     and nothing is copied across. The one exception is
     `providers.claude.args`, which the overlay repeats in full because a list
     replaces — if the pull touched it, run the re-read command of
     `docs/deploy.md` §7 and realign the overlay's list by hand (the
     repository's list, then `--settings
     /home/runner/.claude/capitoline.json`) before the restart. On a host that
     has not migrated to the overlay yet, the whole configuration is still a
     hand-made copy and every changed key has to be retyped into it
     (`docs/deploy.md` §7, last paragraph).

4. Measure what one run of the new version costs, since a CLI can grow with
   an update and the host is sized from that figure (design §4.1). Start the
   sampler, send a few requests through the updated CLI — the smoke test is
   enough — and stop it:

   ```sh
   python3 /var/lib/capitoline/app/scripts/measure-cli-resources.py --seconds 300
   ```

   If the peak it prints for that CLI is above the provider's `memory_mb` in
   `config/capitoline.yaml`, raise `memory_mb` there (rounded up to the next
   50 MB), update the table of design §4.1, and check that the host still
   holds `server.memory_mb + Σ concurrency × memory_mb` — the service's
   startup log says so after the restart.

5. Update the table above with the new version, the date and what changed.

6. If the update changed how the CLI signs in, or the provider announced a
   change to its plans or terms, re-read `docs/terms-of-service.md` against
   the provider's current pages and date the re-reading there. Quote from the
   page itself, never from a summary of it.

If only the `image` line of the smoke test fails, the CLI flags are not the
place to look: that line exercises the sudoers entry of `docs/deploy.md` §5,
the helper installed in §7.1 and the `strict` settings of §6.4. Start at
§7.1 — a `/usr/local/bin/capitoline-collect-image` left over from a previous
version is the usual cause.

If the smoke test fails for reasons unrelated to flags or output format
(expired token, rate limit), the response's `error.message` says which; see
`docs/deploy.md` §6 to log in again.
