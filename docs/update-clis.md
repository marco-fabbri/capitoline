# Updating the CLIs

The CLIs change almost monthly. They are updated by hand, one at a time,
and every update is followed by the smoke test. Never auto-update.

## Versions in use

| CLI | version | date | notes |
|---|---|---|---|
| Claude Code (`claude`) | 2.1.278 | 2026-09-20 | spike; flags and `stream-json` format recorded in `test/fixtures/claude` |
| Codex CLI (`codex`) | 0.154.0 | 2026-09-20 | spike; `exec --json` events recorded in `test/fixtures/codex` |
| Antigravity CLI (`agy`) | 1.2.7 | 2026-09-20 | spike; `stream-json` in/out recorded in `test/fixtures/antigravity` |
| Codex CLI (`codex`) | 0.155.1 | 2026-09-20 | first host deployment (a Proxmox LXC); same flags as 0.154.0, smoke test pending |

Add a row for every update, newest last.

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
   cd /var/lib/capitoline/app && CAPITOLINE_CONFIG=/etc/capitoline/capitoline.yaml \
     CF_ACCESS_CLIENT_ID=<id> CF_ACCESS_CLIENT_SECRET=<secret> \
     scripts/smoke.sh https://api.example.com
   ```

   Only while `server.access.team_domain` is still empty can it run locally:
   `scripts/smoke.sh http://127.0.0.1:8080` (see `docs/deploy.md` §12).

3. If the updated CLI's line is not `200`:
   - compare the CLI's `--help` with its `args` in `config/capitoline.yaml`
     (production copy: `/etc/capitoline/capitoline.yaml`) and with the parser
     in `src/providers/<id>.ts` (`claude.ts`, `codex.ts`, `antigravity.ts`);
   - capture a new fixture with the same command used in
     `docs/spike-2026-09.md` §3 for that CLI, sanitize paths and user names,
     and put it next to the existing ones in `test/fixtures/<id>/`;
   - fix the config and/or the parser, run `npx vitest run`, commit;
   - deploy the fix: `git pull`, `npm ci`, `npm run build`, re-install the
     collection helper (`install -o root -g root -m 0755
     /var/lib/capitoline/app/scripts/capitoline-collect-image
     /usr/local/bin/capitoline-collect-image`, `docs/deploy.md` §7.1 — the
     installed copy is a snapshot of the clone, not a link, so without this
     a change to the helper has no effect), copy any config change to
     `/etc/capitoline/capitoline.yaml` — `diff` it against the repository
     copy, keys added by an update are not optional (`docs/deploy.md` §7) —
     `systemctl restart capitoline`; then
     run the smoke test again.

4. Update the table above with the new version, the date and what changed.

If only the `image` line of the smoke test fails, the CLI flags are not the
place to look: that line exercises the sudoers entry of `docs/deploy.md` §5,
the helper installed in §7.1 and the `strict` settings of §6.4. Start at
§7.1 — a `/usr/local/bin/capitoline-collect-image` left over from a previous
version is the usual cause.

If the smoke test fails for reasons unrelated to flags or output format
(expired token, rate limit), the response's `error.message` says which; see
`docs/deploy.md` §6 to log in again.
