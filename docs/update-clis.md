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

Compare that list with the `features.*=false` entries under
`providers.codex.args` in `config/capitoline.yaml`. A feature that is on and
not named there is either harmless — a terminal or app-UI feature, which
`codex exec` never uses — or a tool that has just been handed to every client.
To tell which, see what the model is actually offered, which costs one call
on the subscription and executes nothing:

```sh
echo "Do not call any tool. List the exact names of every tool or function you are able to call in this session, one per line, and nothing else. If there are none, reply NONE." \
  | codex <the args of providers.codex.args> -m gpt-6-luna - | grep agent_message
```

With the configuration of 2026-09-23 the answer is `apply_patch`,
`request_user_input` and `multi_tool_use.parallel`, and nothing else:
`apply_patch` because no setting removes it (the read-only sandbox rejects
it), `request_user_input` because a non-interactive run has nobody to ask.
Anything more is a tool to switch off, and `test/config.test.ts` pins the
list so it cannot shrink by accident.

## Procedure

On the host, as root:

1. Update one CLI as `runner`, then leave the shell:

   ```sh
   sudo -iu runner
   npm install -g @anthropic-ai/claude-code      # or @openai/codex
   # Antigravity: curl -fsSL https://antigravity.google/cli/install.sh | bash
   claude --version                              # or codex --version, agy --version
   exit
   ```

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
