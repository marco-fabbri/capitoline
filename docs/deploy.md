# Deployment runbook

Target: a Debian/Ubuntu host. Where that host lives does not matter to this
document: a VM on Nutanix AHV (another deployment), an
unprivileged LXC on Proxmox (the owner's first deployment) or bare metal.
Every command is run as root on the host unless the prompt says otherwise.

The result is one systemd service (`capitoline`, user `capitoline`) that
runs the CLIs through `sudo` as a second user (`runner`), which is the only
user holding the subscription credentials, behind a Cloudflare Tunnel with
Cloudflare Access in front. No inbound port is opened.

Three steps need the owner with a browser on the Mac: `claude setup-token`
(§6.1), the Codex device code (§6.2) and the Antigravity login (§6.3).

## 1. Host

Debian 13 or Ubuntu 24.04, 2 cores, 4 GB RAM, 20 GB disk, outbound
internet, no inbound ports. Where the variants differ:

- Proxmox LXC: unprivileged, with `features: nesting=1`. Without nesting,
  systemd 257 on Debian 13 does not start cleanly in an unprivileged
  container (`pct create ... --unprivileged 1 --features nesting=1`).
  Inbound comes only through the tunnel, so no port is forwarded.
- Nutanix AHV: a cloud-init Debian/Ubuntu image, VirtIO disk and NIC.
- Bare metal: nothing special.

```sh
apt update && apt install -y curl ca-certificates sudo git jq gnome-keyring dbus-user-session
```

`gnome-keyring` and `dbus-user-session` exist only for Antigravity (§6.3).

## 2. Node 24 LTS

```sh
curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt install -y nodejs
node --version    # v24.x
```

## 3. Users

`capitoline` owns the code, the configuration, the database and the
service. `runner` owns the CLIs and their credentials. They share only the
sandbox directory, where the gateway writes request attachments and the CLI
runs.

```sh
adduser --system --group --home /var/lib/capitoline capitoline
adduser --disabled-password --gecos "" runner
usermod -aG capitoline runner
mkdir -p /var/lib/capitoline/sandboxes
chown capitoline:capitoline /var/lib/capitoline/sandboxes
chmod 2770 /var/lib/capitoline/sandboxes
```

The setgid bit (`2770`) makes every sandbox the gateway creates belong to
the `capitoline` group, so `runner` can enter it.

## 4. CLIs, as runner

```sh
sudo -iu runner
npm config set prefix ~/.npm-global
printf '\nexport PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"\n' >> ~/.profile
. ~/.profile
npm install -g @anthropic-ai/claude-code @openai/codex
curl -fsSL https://antigravity.google/cli/install.sh | bash
claude --version; codex --version; agy --version
exit
```

Record the three versions in `docs/update-clis.md`. The binaries end up at
`/home/runner/.npm-global/bin/claude`, `/home/runner/.npm-global/bin/codex`
and `/home/runner/.local/bin/agy`; check with `ls -l` because §5 and §7
use these absolute paths.

## 5. Sudoers

`sudoers`, not code, limits what the gateway can run as `runner`.

```sh
cat > /etc/sudoers.d/capitoline <<'SUDO'
capitoline ALL=(runner) NOPASSWD: /home/runner/.npm-global/bin/claude, /home/runner/.npm-global/bin/codex, /home/runner/.local/bin/agy, /usr/local/bin/capitoline-collect-image
SUDO
chmod 0440 /etc/sudoers.d/capitoline
visudo -cf /etc/sudoers.d/capitoline
```

The production configuration (§7) must use exactly these absolute paths as
`binary`; a relative name would not match the sudoers rule. `sudo` is
invoked by the gateway as `sudo -n -H -u runner -- <binary> ...` with an
environment reduced to `PATH`, so nothing from the gateway's environment
reaches the CLI.

The fourth entry is not a CLI: it is the image collection helper of §7.1,
run the same way, with a conversation id as its only argument. Write the
rule now — `visudo -cf` does not check that the path exists — but remember
that until §7.1 has installed the file an image request fails with a `sudo`
error.

## 6. Authentication, as runner

Everything in this section is done once, by hand. The credentials stay in
`/home/runner`; the gateway process never reads them.

### 6.1 Claude

On the Mac:

```sh
claude setup-token        # one-year OAuth token, copy it
```

On the host:

```sh
sudo -iu runner
mkdir -p ~/.claude
cat > ~/.claude/capitoline.json <<'JSON'
{"env":{"CLAUDE_CODE_OAUTH_TOKEN":"<token>"}}
JSON
chmod 600 ~/.claude/capitoline.json
exit
```

`--settings` applies even with `--setting-sources ""`, which is why the
token lives in that file and the production config adds
`--settings /home/runner/.claude/capitoline.json` to the claude `args`
(§7). Verify the way the gateway will call it:

```sh
sudo -Hu runner /home/runner/.npm-global/bin/claude -p "Reply with the single word: ok" \
  --settings /home/runner/.claude/capitoline.json --setting-sources "" --tools "" --strict-mcp-config
```

The token is not refreshed automatically: repeat this step yearly.

### 6.2 Codex

```sh
sudo -iu runner codex login --device-auth      # confirm the code from the Mac
sudo -iu runner codex login status
```

Credentials go to `/home/runner/.codex/auth.json` (mode 0600) and refresh
themselves.

### 6.3 Antigravity

Antigravity stores the subscription login in the Linux Secret Service
keyring. There is no API-key fallback: the owner's rule is no pay-per-use
API for any provider, so the keyring must work headless, and it must be
reachable from a process started by `sudo` with an empty environment (§5),
not only from a login shell.

The setup has three parts: a D-Bus user bus for `runner` that exists at boot,
a keyring daemon on that bus as a systemd user unit, and the bus address
handed to every CLI that `sudo` starts as `runner`.

**a. User bus at boot.** Lingering starts `systemd --user` for `runner` at
boot, and `dbus-user-session` gives it a bus at `/run/user/<uid>/bus`.

```sh
loginctl enable-linger runner
RUNNER_UID=$(id -u runner)
ls -l /run/user/$RUNNER_UID/bus       # must exist after a few seconds
```

**b. Keyring daemon as a user unit.** The login keyring is created and
unlocked with a password read from a file. That password only protects the
keyring file against a reader who cannot read `/home/runner`; it is the
same threat model as Codex's `auth.json`.

```sh
sudo -iu runner
mkdir -p ~/.config/systemd/user ~/.local/share/keyrings
head -c 32 /dev/urandom | base64 > ~/.keyring-password
chmod 600 ~/.keyring-password
cat > ~/.config/systemd/user/gnome-keyring.service <<'UNIT'
[Unit]
Description=Secret Service keyring for the Capitoline runner
After=dbus.socket
Requires=dbus.socket

[Service]
Type=simple
ExecStart=/bin/sh -c 'exec /usr/bin/gnome-keyring-daemon --foreground --components=secrets --unlock < %h/.keyring-password'
Restart=on-failure

[Install]
WantedBy=default.target
UNIT
# ~/.profile: same bus for interactive logins (needed for the one-time login below)
cat >> ~/.profile <<'PROFILE'
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
PROFILE
. ~/.profile
systemctl --user daemon-reload
systemctl --user enable --now gnome-keyring.service
systemctl --user status gnome-keyring.service
exit
```

**c. Bus address for CLIs started by sudo.** The gateway starts every CLI
with `sudo -n -H -u runner` and an environment containing only `PATH`;
`sudo` then resets the environment. A per-runas `env_file` adds the bus
address to every command run as `runner`, without widening the sudoers rule:

```sh
RUNNER_UID=$(id -u runner)
cat > /etc/capitoline/runner.env <<ENV
XDG_RUNTIME_DIR=/run/user/$RUNNER_UID
DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$RUNNER_UID/bus
ENV
chmod 0644 /etc/capitoline/runner.env
cat > /etc/sudoers.d/capitoline-env <<'SUDO'
Defaults>runner env_file=/etc/capitoline/runner.env
SUDO
chmod 0440 /etc/sudoers.d/capitoline-env
visudo -cf /etc/sudoers.d/capitoline-env
sudo -Hu runner env | grep DBUS      # must print the bus address
```

(`/etc/capitoline` is created in §7; create it first if you are following
this section before that one.)

**d. Login, once, over SSH, by the owner.** The CLI prints a URL; open it
on the Mac, sign in, paste the code back. Do this from an interactive SSH
session of your own: in `-p` mode the CLI waits only 60 s for the code and
the URL is bound to that single run (PKCE), so relaying the URL and the code
through a chat or a ticket does not fit in the window, and without a TTY the
CLI refuses to start the login at all ("authentication required. Run 'agy'
to log in").

```sh
sudo -iu runner agy       # complete the URL/code flow, then /quit
```

**e. Verify.** Both as the login shell and the way the gateway calls it:

```sh
sudo -iu runner agy -p "Reply with the single word: ok" --model gemini-3.8-flash-low --output-format json
sudo -Hu runner /home/runner/.local/bin/agy -p "Reply with the single word: ok" --model gemini-3.8-flash-low --output-format json
```

**f. Reboot test.** `reboot`, then repeat the second command in **e**
without touching anything. If it fails, `sudo -iu runner systemctl --user
status gnome-keyring.service` and `journalctl --user-unit gnome-keyring
-u runner` tell whether the daemon came up before or after the bus.

Record here what made it work on the first host, with the date:

- Verified on: Debian 13.6 unprivileged LXC (Proxmox 9.2, `nesting=1`),
  gnome-keyring 48.0, dbus-user-session, 2026-09-21. The login keyring
  (`~/.local/share/keyrings/login.keyring`) was written by the interactive
  `agy` login and read back by `agy` started through `sudo -Hu runner` with
  the `env_file` bus address; reboot test passed 2026-09-21 (`pct reboot`, then `agy` through `sudo -Hu runner` answered without any manual step).

### 6.4 Antigravity tool permissions

`agy` cannot disable its tools by flag; the permission model lives in a
settings file of the user that runs it. `strict` makes any tool call stall
instead of executing, and the gateway's timeout kills the stalled process.

```sh
sudo -iu runner
mkdir -p ~/.gemini/antigravity-cli
cat > ~/.gemini/antigravity-cli/settings.json <<'JSON'
{"toolPermission":"strict","enableTerminalSandbox":true,"allowNonWorkspaceAccess":false}
JSON
exit
```

Verify that a command request stalls and never prints the output of `id`:

```sh
timeout 30 sudo -Hu runner /home/runner/.local/bin/agy -p 'run the command: id' \
  --model gemini-3.8-flash-low --output-format json --print-timeout 30s
```

Expected: no `uid=` line in the output; a hang until `timeout` kills it is
the expected behavior (`--print-timeout` does not fire on a pending tool
call, which is exactly the case the gateway's own timeout covers). If
`uid=` appears, stop: the permission model changed and the provider must
stay disabled until `settings.json` locks it again.

## 7. Application

```sh
mkdir -p /etc/capitoline
sudo -Hu capitoline git clone <repo url> /var/lib/capitoline/app
cd /var/lib/capitoline/app
sudo -Hu capitoline npm ci
sudo -Hu capitoline npm run build
cp config/capitoline.yaml /etc/capitoline/capitoline.yaml
chown root:capitoline /etc/capitoline/capitoline.yaml
chmod 0640 /etc/capitoline/capitoline.yaml
```

`-H` matters: without it `sudo` keeps root's `HOME`, npm looks for its cache
in `/root/.npm` and `npm ci` fails with `EACCES`. With it the cache lands in
`/var/lib/capitoline/.npm`.

Edit `/etc/capitoline/capitoline.yaml`:

| Key | Production value |
|---|---|
| `runner.user` | `runner` |
| `runner.sandbox_root` | `/var/lib/capitoline/sandboxes` |
| `usage.db_path` | `/var/lib/capitoline/usage.sqlite` |
| `providers.claude.binary` | `/home/runner/.npm-global/bin/claude` |
| `providers.claude.args` | append `--settings` and `/home/runner/.claude/capitoline.json` as two list items |
| `providers.codex.binary` | `/home/runner/.npm-global/bin/codex` |
| `providers.antigravity.binary` | `/home/runner/.local/bin/agy` |
| `providers.antigravity.image.collect` | `[/usr/local/bin/capitoline-collect-image]` — already the value in the repository copy; it must match the sudoers path of §5 (a developer machine sets `runner.user: null` and points `image.collect` at `scripts/capitoline-collect-image`; the runner then spawns it directly, as the developer, so it reads that machine's own `$HOME`) |
| `providers.antigravity.image.min_bytes` | `200000` — keep it: below this the collected file is a placeholder, not a picture, and the request fails with `bad_output` rather than returning a grey rectangle (placeholders were observed at 2-65 KB against 1.8-2.4 MB for a real image, hence the threshold) |
| `providers.antigravity.image.quota_per_window` | `12` — the short image quota (12 generations per 5 hours), reported only: `/health` and `/v1/models` show `used` against it and the gateway never blocks on it. Leave it out and the count is still reported, with `limit: null`. The second, much longer quota of the same model (days) cannot be counted and shows up only as the `resetAt` of a quota hit |
| `providers.antigravity.image.allowed_tools` | `[generate_image]` — do not extend: any other tool call aborts the run, which is what keeps an image request from turning into an agent session |
| `server.access.team_domain`, `server.access.audience` | filled in §9; both empty until then |

Everything else (flags, model aliases, effort mapping) stays as in the
repository copy; it is the verified set for the CLI versions in
`docs/update-clis.md`.

### 7.1 Image collection helper

The helper ships in the repository, so it is installed from the clone made
above, even though what it configures belongs to the runner's setup.

`agy` writes a generated image inside its own home, never into the sandbox:
`/home/runner/.gemini/antigravity-cli/brain/<conversation-id>/image_<ts>.jpg`
(JPEG, about one megabyte). `/home/runner` is `0700`, so the gateway user
cannot read it, and the agent's claim that it saved `./image.png` in the
working directory is invented. `scripts/capitoline-collect-image` is the
only way across that boundary: it checks that its argument is a UUID,
prints the newest `image_*` file of that conversation to stdout and removes
the conversation directory.

```sh
install -o root -g root -m 0755 \
  /var/lib/capitoline/app/scripts/capitoline-collect-image \
  /usr/local/bin/capitoline-collect-image
```

Owned by `root` and not writable by `capitoline`: the sudoers rule of §5
lets `capitoline` run this exact path as `runner`, so a copy the gateway
user could edit would hand it the `runner` account. Exit codes: 2 invalid
conversation id, 3 no such conversation, 4 no image (the directory is
removed anyway). The gateway maps 4 and an empty output to `bad_output`, or
to `rate_limited` when the run also carried a quota refusal.

Re-run this install after every `git pull`: the installed copy is a
snapshot, not a link, and `sudo` runs the installed path, never the one in
the clone (`docs/update-clis.md` step 3).

Image generation needs no change to the `strict` settings of §6.4: for
`agy` a `generate_image` call is not a file write, so it runs headless with
no approval prompt, while `run_command` and real file writes keep stalling.
The tool takes only `ImageName` and `Prompt` — there is no size parameter,
which is why the API accepts `size` and reports it as ignored.

Verify, after §8 has the service running:

```sh
sudo -n -H -u capitoline -- sudo -n -H -u runner -- \
  /usr/local/bin/capitoline-collect-image not-a-uuid; echo $?   # prints 2
curl -s http://127.0.0.1:8080/v1/images/generations -H 'content-type: application/json' \
  -d '{"prompt":"a red fox in the snow, 16:9"}' | jq '.capitoline'
```

Expected: `mime` `image/jpeg`, dimensions around 1376x768 and `bytes`
around a million. `bad_output` with "too small" means the collected file is
not a picture (the `min_bytes` gate of the table above) — with the `strict`
settings of §6.4 the CLI writes no placeholder, so it points at a broken or
changed CLI, not at a quota hit. A quota hit is a 429 with `Retry-After`:
there are two rolling windows and the longer one resets in days, see
`docs/spike-2026-09.md` §8.

## 8. systemd

```sh
cat > /etc/systemd/system/capitoline.service <<'UNIT'
[Unit]
Description=Capitoline AI gateway
After=network-online.target
[Service]
User=capitoline
Group=capitoline
WorkingDirectory=/var/lib/capitoline/app
Environment=CAPITOLINE_CONFIG=/etc/capitoline/capitoline.yaml
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=3
NoNewPrivileges=false
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now capitoline
journalctl -u capitoline -f
```

`NoNewPrivileges` must stay off: `sudo` needs it. The service listens on
`127.0.0.1:8080` only. The startup log should show `listening` and one
`health check` line per provider with `ok: true`; the same is visible with
`curl -s http://127.0.0.1:8080/health | jq`.

## 9. Cloudflare Tunnel and Access

**Tunnel.** Zero Trust → Networks → Tunnels → Create a tunnel → name
`capitoline`. The dashboard shows a token; install `cloudflared` on the host
as a service with it:

```sh
mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' > /etc/apt/sources.list.d/cloudflared.list
apt update && apt install -y cloudflared
cloudflared service install <tunnel token>
systemctl status cloudflared
```

In the tunnel's Public Hostname tab: hostname `api.example.com`,
service `http://localhost:8080`. The DNS record is created by the tunnel.

**Access.** Zero Trust → Access → Applications → Add an application →
Self-hosted, domain `api.example.com`. Two policies:

1. `owner`: action Allow, include Emails = the owner's address (browser login).
2. `apps`: action Service Auth, include Service Token = `capitoline-apps`
   (create it under Access → Service Auth → Service Tokens; copy the client
   id and secret now, the secret is shown once).

From the application's overview copy the **Application Audience (AUD) tag**
and the team domain (`<team>.cloudflareaccess.com`, without `https://`)
into the config, then restart:

```yaml
server:
  access:
    team_domain: <team>.cloudflareaccess.com
    audience: <aud tag>
```

```sh
systemctl restart capitoline
```

Verify from the Mac:

```sh
curl -i https://api.example.com/v1/models          # 302 (browser login) or 401
curl -s https://api.example.com/v1/models \
  -H "CF-Access-Client-Id: <id>" -H "CF-Access-Client-Secret: <secret>" | jq   # 200
```

From the host, `curl -s http://127.0.0.1:8080/v1/models` now answers 401
(no Access JWT) while `curl -s http://127.0.0.1:8080/health` still answers:
that is the intended exemption for local monitoring.

## 10. Claude Code as MCP client (on the Mac)

```sh
claude mcp add --transport http capitoline https://api.example.com/mcp \
  --header "CF-Access-Client-Id: <id>" --header "CF-Access-Client-Secret: <secret>"
```

A CLI answer can take minutes and an image 11-45 s; raise the tool timeout
in the Mac shell profile:

```sh
export MCP_TOOL_TIMEOUT=600000
```

This is the only thing that keeps a long call alive. `generate_image` sends
a progress notification every 5 s to clients that ask for one (a request
with a progress token), but a notification postpones the client's deadline
only when that client sets `resetTimeoutOnProgress`, off by default in the
MCP TypeScript SDK (spec §6.2); treat it as a sign of life, not as a
timeout extension.

Test: in Claude Code run `/mcp` (the server must show as connected), then
ask "use capitoline ask_model with codex-gpt-5.5: reply ok" and "use
capitoline generate_image: a red fox in the snow".

## 11. Backup

Daily, as root, of the configuration and the usage database. Credentials
are deliberately not included: if lost, log in again (§6); a token backup
is one more copy to protect.

```sh
cat > /etc/cron.daily/capitoline-backup <<'CRON'
#!/bin/sh
set -e
tar czf /var/backups/capitoline-$(date +%F).tgz /etc/capitoline /var/lib/capitoline/usage.sqlite
ls -1t /var/backups/capitoline-*.tgz | tail -n +15 | xargs -r rm -f
CRON
chmod 0755 /etc/cron.daily/capitoline-backup
/etc/cron.daily/capitoline-backup && ls -l /var/backups/
```

Copy `/var/backups/capitoline-*.tgz` off the host with the owner's usual
mechanism (rsync to the Mac, or a bucket).

## 12. Smoke test

One real call per provider with its `health_model`, read from the same
configuration the service uses, plus — when that configuration declares an
image model — one `POST /v1/images/generations` whose result must be larger
than `image.min_bytes`. The script needs `curl` and `jq` on the machine it
runs from. The image line is the only end-to-end check of the sudoers entry
of §5 and of the helper installed in §7.1, and it spends one unit of the
image quota (12 per 5 hours).

Before §9 (Access not yet configured, `server.access.team_domain` empty),
on the host:

```sh
cd /var/lib/capitoline/app && CAPITOLINE_CONFIG=/etc/capitoline/capitoline.yaml scripts/smoke.sh http://127.0.0.1:8080
```

Once §9 is done the loopback form no longer authenticates: the gateway
accepts only the `Cf-Access-Jwt-Assertion` header (or the `CF_Authorization`
cookie), which the Cloudflare edge issues after checking the service token,
and a call to `127.0.0.1:8080` never passes through the edge. Every line
would be `401`. From then on the smoke test goes through the tunnel, from
the Mac or from the host alike:

```sh
CF_ACCESS_CLIENT_ID=<id> CF_ACCESS_CLIENT_SECRET=<secret> \
  scripts/smoke.sh https://api.example.com
```

(on the host, prefix `CAPITOLINE_CONFIG=/etc/capitoline/capitoline.yaml` as
above so the model list matches the production configuration.)

Expected: three lines with status `200`, a short answer and a token count,
then an `image` line with `200` and the size of the collected picture; exit
code 0. Run it again after every CLI update (`docs/update-clis.md`).
