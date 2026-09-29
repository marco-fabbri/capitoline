# Deployment runbook

Target: a Debian/Ubuntu host. Where that host lives does not matter to this
document: a virtual machine on any hypervisor, an unprivileged LXC on
Proxmox, or bare metal. Every command is run as root on the host unless the
prompt says otherwise. "Design §n" is `docs/superpowers/specs/2026-09-19-capitoline-design.md`.

The result is one systemd service (`capitoline`, user `capitoline`) that
runs the CLIs through `sudo` as a second user (`runner`), which is the only
user holding the subscription credentials. Clients reach it in one of two
ways, and Cloudflare is only one of them:

- **Through a Cloudflare Tunnel with Access in front** (§9): no inbound port
  is opened, and Cloudflare checks every caller before the gateway sees it.
- **On a network of your own, without Cloudflare** (§8.2): the gateway
  listens on the host's address and its own API keys (§8.1) are the door.

Three steps need the owner of each subscription, with a browser on their own
computer: the Claude login (§6.1), the Codex device code (§6.2) and the
Antigravity login (§6.3). A host that serves only some of them — one
application on one subscription, say — names them in the overlay's `serve`
(§7) and skips the steps of the others.

## 1. Host

Debian 13 or Ubuntu 24.04, 4 cores, 8 GB RAM, 20 GB disk, outbound
internet, no inbound ports.

The memory is what the shipped concurrency needs — ten runs per CLI, each a
whole CLI process — and not a round number: design §4.1 has the measured cost
of one run and the formula, `server.memory_mb + Σ concurrency × memory_mb`,
7,150 MB for the shipped file. A smaller host works with lower `concurrency`
in the overlay; the gateway checks the arithmetic at startup and logs
`sizing: the configured concurrency does not fit in memory` when it does not
hold, rather than let the kernel find out under load. Where the variants
differ:

- Proxmox LXC: unprivileged, with `features: nesting=1`. Without nesting,
  systemd 257 on Debian 13 does not start cleanly in an unprivileged
  container (`pct create ... --unprivileged 1 --features nesting=1`).
  Inbound comes only through the tunnel, so no port is forwarded.
- A virtual machine: a cloud-init Debian/Ubuntu image, VirtIO disk and NIC.
- An arm64 host: the Antigravity version check reads the installer's
  manifest for the platform, `linux_amd64` in the repository; set
  `providers.antigravity.version.latest.manifest` to the `linux_arm64` one in
  the overlay (§7).
- Bare metal: nothing special.

```sh
apt update && apt install -y curl ca-certificates sudo git jq sqlite3 python3 gnome-keyring dbus-user-session
```

`gnome-keyring` and `dbus-user-session` exist only for Antigravity (§6.3);
`sqlite3` reads the usage database (§9, §11) and `python3` runs the resource
sampler of `docs/update-clis.md`.

## 2. Node 24 LTS

```sh
curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt install -y nodejs
node --version    # v24.x
```

The major must be the one in the repository's `.nvmrc` (`24`), which is also
what `engines` in `package.json` allows (`>=24 <25`). A development machine on
a newer major is then a visible difference rather than one discovered here.

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
install -d -m 0755 /etc/capitoline      # the host's configuration, from §6 on
```

The setgid bit (`2770`) makes every sandbox the gateway creates belong to
the `capitoline` group, so `runner` can enter it.

## 4. CLIs, as runner

```sh
sudo -iu runner
npm config set prefix ~/.npm-global
printf '\nexport PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"\n' >> ~/.profile
. ~/.profile
# The versions this repository was last verified with: providers.<id>.version.verified
# in config/capitoline.yaml, the newest row of each CLI in docs/update-clis.md.
npm install -g @anthropic-ai/claude-code@2.1.285 @openai/codex@0.159.1
curl -fsSL https://antigravity.google/cli/install.sh | bash
claude --version; codex --version; agy --version
exit
```

npm 11 warns that it did not run Claude Code's install script; the package
already carries the native binary, and `claude --version` answering is the
check. The two npm packages are pinned because a new version can switch on a tool
the configuration has not switched off yet, which is what the update script
checks for and a plain install does not. The Antigravity installer takes no
version and installs the latest; once the service runs (§8), `/health` says
whether any of the three is behind, and `scripts/update-cli.sh` brings it up
with its checks (`docs/update-clis.md`). The binaries end up at
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

The interactive login, from an SSH session of your own: the CLI prints a URL,
you open it on your own computer, sign in and paste the code back.

```sh
sudo -iu runner claude      # /login, follow the URL, paste the code, then /exit
```

The credentials land in `/home/runner/.claude/.credentials.json` (mode
0600) and refresh themselves. Verify the way the gateway will call it:

```sh
sudo -Hu runner /home/runner/.npm-global/bin/claude -p "Reply with the single word: ok" \
  --setting-sources "" --tools "" --strict-mcp-config
```

The alternative is a one-year token, for a host where nobody can log in
interactively: `claude setup-token` on your own computer, the token put in
`/home/runner/.claude/capitoline.json` (owned by `runner`, 0600) as
`{"env":{"CLAUDE_CODE_OAUTH_TOKEN":"<token>"}}`, and
`--settings /home/runner/.claude/capitoline.json` added to the command line
through the overlay's `providers.claude.args_extra` (§7). `--settings` applies
even with `--setting-sources ""`, so the gateway process never sees the
token. It is not refreshed: repeat yearly.

### 6.2 Codex

```sh
sudo -iu runner codex login --device-auth      # confirm the code on your own computer
sudo -iu runner codex login status
```

Credentials go to `/home/runner/.codex/auth.json` (mode 0600) and refresh
themselves.

### 6.3 Antigravity

Antigravity stores the subscription login in the Linux Secret Service
keyring. There is no API-key fallback: the project's rule is no pay-per-use
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
AGY_CLI_DISABLE_AUTO_UPDATE=true
DISABLE_AUTOUPDATER=1
ENV
chmod 0644 /etc/capitoline/runner.env
cat > /etc/sudoers.d/capitoline-env <<'SUDO'
Defaults>runner env_file=/etc/capitoline/runner.env
SUDO
chmod 0440 /etc/sudoers.d/capitoline-env
visudo -cf /etc/sudoers.d/capitoline-env
sudo -Hu runner env | grep DBUS      # must print the bus address
```

The last two lines stop the CLIs updating themselves: `agy` otherwise checks
for a new version every fifteen minutes and installs it in the background,
and Claude Code has an updater of its own; Codex does not install updates by
itself. A new version can switch on a tool or change how one is refused, so
updates are installed by hand with `scripts/update-cli.sh`, which checks them
(`docs/update-clis.md`).

The values matter and were measured, not assumed. `agy` ignores
`AGY_CLI_DISABLE_AUTO_UPDATE=1` in silence and honours `true`; to see it,
delete `~/.gemini/antigravity-cli/last_check.timestamp` as `runner`, run any
`agy` command, and look for `Auto-update disabled via environment variable`
in the newest file under `~/.gemini/antigravity-cli/log/`. Without deleting
the timestamp the updater skips its check anyway and proves nothing. For
Claude Code, `claude doctor` as `runner` prints `Auto-updates: disabled (set
by env: DISABLE_AUTOUPDATER)`.

**d. Login, once, over SSH, by the owner.** The CLI prints a URL; open it
on your own computer, sign in, paste the code back. Do this from an interactive SSH
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

Tested on a Debian 13.6 unprivileged LXC (Proxmox 9.2, `nesting=1`) with
gnome-keyring 48.0: the login keyring written by the interactive login was
read back by `agy` started through `sudo -Hu runner`, and after a reboot it
answered with no manual step.

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

Expected: no `uid=` line in the output. Since 1.2.8 `agy` refuses the tool
by itself and ends the run, with an empty `response` and
`"denied_actions":[{"action":"command",…}]`; earlier versions hung on the
pending call until `timeout` killed them (`--print-timeout` does not fire on
a pending tool call, which is the case the gateway's own timeout covers).
Either is safe. If `uid=` appears, stop: the permission model changed and the
provider must stay disabled until `settings.json` locks it again.

## 7. Application

```sh
sudo -Hu capitoline git clone https://github.com/marco-fabbri/capitoline.git /var/lib/capitoline/app
cd /var/lib/capitoline/app
sudo -Hu capitoline npm ci
sudo -Hu capitoline npm run build
cp config/overlay.example.yaml /etc/capitoline/overlay.yaml
chown root:capitoline /etc/capitoline/overlay.yaml
chmod 0640 /etc/capitoline/overlay.yaml
```

`-H` matters: without it `sudo` keeps root's `HOME`, npm looks for its cache
in `/root/.npm` and `npm ci` fails with `EACCES`. With it the cache lands in
`/var/lib/capitoline/.npm`.

**Two files, one configuration.** The service reads `config/capitoline.yaml`
from the clone — the repository's own file, which every `git pull` updates —
and merges `/etc/capitoline/overlay.yaml` over it. The overlay holds only what
this host says differently: where the binaries are, who runs them, where the
sandboxes and the database live, the Access application. Everything else —
flags, model aliases, effort mapping, timeouts, budgets — arrives with the
pull that changes it, and the overlay is the only file of this host that is
not in git (§11 backs it up).

Merge rules, from `mergeConfig` in `src/config.ts`:

- objects merge key by key, so naming one binary leaves the rest of that
  provider untouched;
- a scalar or a **list replaces** the base's value whole, never appended to.
  A host that adds an argument to a CLI's command line therefore does not
  touch `args`: it sets `args_extra`, which the code appends to the
  repository's `args`;
- `null` is a value, not a deletion: `effort_flag: null` and `runner.user:
  null` are declared values of this schema;
- the merged result is validated once, by the same strict schema the single
  file went through, so a key the overlay mistypes is rejected by name rather
  than dropped.

Edit `/etc/capitoline/overlay.yaml`. It starts as a copy of the example, whose
`callers` and `admins` are placeholders: replace them, or empty them
(`callers: {}`, `admins: []`) until §8.1 and §9 give them real values.

| Key | Production value |
|---|---|
| `runner.user` | `runner` |
| `runner.sandbox_root` | `/var/lib/capitoline/sandboxes` |
| `usage.db_path` | `/var/lib/capitoline/usage.sqlite` — absolute, because the service's working directory is the clone |
| `providers.claude.binary` | `/home/runner/.npm-global/bin/claude` |
| `providers.claude.args_extra` | `[]` after the interactive login of §6.1. With the setup token instead, `[--settings, /home/runner/.claude/capitoline.json]` |
| `providers.codex.binary` | `/home/runner/.npm-global/bin/codex` |
| `providers.antigravity.binary` | `/home/runner/.local/bin/agy` |
| `server.host` | not in the example: the default `127.0.0.1` is right behind the tunnel of §9. `0.0.0.0` (or one address of the host) for clients on your own network, §8.2 |
| `serve` | not in the example: everything is served. A host that serves less names it, below |
| `server.access.callers` | the names of the Cloudflare service tokens, §9; `{}` without Cloudflare |
| `server.access.admins` | who may use `/v1/admin`, §8.1 |
| `server.access.team_domain`, `server.access.audience` | filled in §9; both empty until then, and for good without Cloudflare |

**Serving less than the repository declares.** With no `serve` key the host
serves every provider and every council of the repository file, and whatever a
later pull adds. A host that serves less names what it serves, and the lists
are closed: what the repository adds later stays out until the host names it.
One application on the Claude subscription alone:

```yaml
serve:
  providers: [claude]
  councils: []
```

A provider left out is not built at all: no health call, no model listing, no
version check, nothing in `/v1/models`. Its steps in §4–§6 and its path in the
sudoers rule of §5 can be skipped. A council that stays loses the models of
the providers left out from its chains, and a seat whose whole chain was on
them; a council left with fewer than two seats, or with no judge, is refused
by `check-config`, which names it. Leaving Codex out keeps both shipped
councils, with three seats each; serving Claude alone leaves none, hence
`councils: []` above.

Everything else stays in the repository file, verified with the CLI versions
of `docs/update-clis.md`. Three of its keys are worth knowing even
though they are not host-specific, all under `providers.antigravity.image`:

| Key | Why it reads as it does |
|---|---|
| `min_bytes` | `200000` — below this the collected file is a placeholder, not a picture, and the request fails with `bad_output` rather than returning a grey rectangle (placeholders were observed at 2-65 KB against 1.8-2.4 MB for a real image) |
| `quota_per_window` | `12` — the short image quota, 12 generations per 5 hours (the window length is fixed in the code, `H5`), reported only: the gateway never blocks on it. `/health` (`providers[].imageQuota`) and `/v1/models` (`capitoline.quota`) show `used` against it, and `used` is a lower bound rather than an exact count: it counts the successful generations served by the images endpoint, while a text run that invokes `generate_image` spends quota without being counted, and so does a generation the client abandons. Leave the key out and the count is still reported, with `limit: null`. The second, much longer quota of the same model (days) cannot be counted: it appears only as the `resetAt` of a quota hit, in `/health` and in the MCP `list_models` tool — never in `/v1/models`, which by then no longer lists the paused model |
| `allowed_tools` | `[generate_image]` — do not extend: any other tool call aborts the run, which is what keeps an image request from turning into an agent session |

**The council block.** `council:` is in the repository file too, and it is the
one block that changes what a request costs. It holds two councils, each a
virtual model of its own name, and they differ only in whether the ranking
stage runs — nothing in the code tells them apart, so a third one is
configuration and a restart:

| Council | What it convenes | Calls |
|---|---|---|
| `capitoline` | the reference panel: four families answer, rank each other blind, and a judge seated apart synthesizes. The shape to ask when the panel's own verdict on its answers is worth its price | 9 |
| `capitoline-fast` | the same four families and the same judge with `ranking: false`, so stage 2 never runs: the everyday shape, at half the price and with no panel verdict on the four answers | 5 |

The price is one call per seat, one more per seat when the ranking stage runs,
and one for the judge. The reference panel's nine land on three different
subscriptions at once: Anthropic, OpenAI and Antigravity answer in parallel in
each of the two member stages, Antigravity twice over because the Google seat
and the open-weights seat sit on that same subscription, and the ninth call
spends the Anthropic window again for the judge. So one question costs about
what nine direct requests cost, on windows this host does not replenish, and
takes as long as the slowest member of each stage in turn. Nothing rations
any of it but the per-provider `concurrency`: a client looping over councils
empties three windows at the same time.

A capability ladder — three models of one family ranking each other, to find
out which is enough for a task — is a council too, but a measuring instrument
rather than one to use, so none ships: `docs/measure-a-model.md` has three
ready to add to the overlay for as long as a measurement runs.

Every key below is read from both blocks; the values are the shipped
`capitoline`'s.

| Key | Why it reads as it does |
|---|---|
| `seats` | four families, each a **chain** and never one model: the first model the health and quota state reports available takes the seat, and an unforeseen refusal steps down the chain once. `antigravity-claude-*` is deliberately not seated — it is the Anthropic seat's opinion through another channel, and a panel of four wants four judgments |
| `judge` | `claude-opus`, `antigravity-claude-opus`, `codex-gpt-6-sol`, `codex-gpt-5.6-terra`: strong models built around what the seats cannot take. `judge_allow_member: false` strikes out a model seated in the same deliberation, so only the head of the chain can also be a seat, and the three behind it never are. The judge writes the answer the client reads, so it is the one seat where economising is false economy — a cheap judge was measured merging three answers into a claim none of them made. When the judge's CLI crashes or returns output that cannot be read, the next model of the chain on another provider takes over. No weak model closes the chain either: when no judge can be seated the council returns the best-ranked answer unsynthesised and says so (design §12.5), which is a better floor than a weak synthesis. |
| `judge_allow_member` | `false` — the judge is seated apart, so no synthesizer weighs an answer it wrote itself. `true` reproduces karpathy/llm-council's shape, where the chairman is also a member |
| `judge_blind` | `true` — the judge sees the labels, never the real model names, so the deliberation is blind end to end. The transparency is not lost, it moves: the client's `capitoline.council` field carries the un-blinded record |
| `min_members` | `2` — below two answers there is nothing to rank. With one the gateway returns that answer and says no council took place, rather than dressing a single opinion as a synthesis |
| `ranking` | `true` here, `false` for `capitoline-fast`: with `false` stage 2 does not run, the judge is given the answers with no aggregate to weigh, and a four-seat council costs five calls instead of nine. It is the one setting that changes the *sequence* of stages, which is why it is a flag in the engine and not a fourth prompt (design §12.9). With `true` the request still chooses: `reasoning_effort: low` skips stage 2 for that deliberation, `high` or no effort runs it, the other levels resolve upward; with `false` the shape is pinned and the field is declared ignored |
| `stage_timeout_s` | `300` — per member and per stage, not for the whole deliberation. A council can therefore run for a quarter of an hour on paper, which is why it is asked for streaming through the tunnel (§9) and with a raised tool timeout over MCP (§10) |

`providers.antigravity.concurrency` is `10`, as for every CLI: concurrency is
sized from the host's memory (design §4.1), not from the councils. What the
councils add is a floor, measured against the **largest** council the provider
is seated in: `capitoline` and `capitoline-fast` seat two chains there each,
Google and open weights, and both start in the same instant. With fewer slots
than that the second would sit on that provider's queue until
`server.queue.max_wait_s` and lose its seat — in every parallel stage, every
time. A ladder added from `docs/measure-a-model.md` needs three.

The slots belong to the subscription and not to one council, so the check
reads every block and measures each provider against the largest council it is
seated in, never the sum of them: the sum would make the slots grow with the
number of names declared — the two shipped councils would ask this one
Antigravity subscription for four parallel `agy` processes, and every ladder
added for a measurement for three more — and, since the gateway validates at startup, would leave a file the service
cannot restart with under `Restart=always`. Two councils asked for at the same
moment do draw on the same slots, but that is contention between two
deliberations: load, answered by the queue and `server.queue.max_wait_s`, not
by the file.

Adding a council is a configuration change that needs this check read again
before the service is restarted. It raises `concurrency` only when the new
panel seats more chains on one provider than any existing panel does, and
`npm run check-config` names the provider and the council that is short when
it does.

Validate after every edit, and before restarting the service:

```sh
cd /var/lib/capitoline/app && sudo -Hu capitoline \
  env CAPITOLINE_CONFIG=config/capitoline.yaml \
      CAPITOLINE_OVERLAY=/etc/capitoline/overlay.yaml npm run check-config   # prints "configuration OK"
```

This loads and merges the same two files through the same schema, out of the
service's way; it reads `dist/config.js`, so it needs the `npm run build`
above. A mistyped key or an empty value is rejected here instead of at
startup, where under `Restart=always` (§8) it is a restart loop whose only
trace is the journal. The message names both files, since the rejected key is
in one of the two. A missing overlay file is an error as well, never a silent
skip: a typo in the path would otherwise start the gateway on the repository's
own sandboxes, database and user. An overlay that exists but is empty — the
file created now and filled in later, a write cut short — is refused by name
(`the configuration overlay /etc/capitoline/overlay.yaml is empty`) rather
than as a schema error with no key in it.


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

`codex` does the same with its built-in image generation, which runs on the
ChatGPT subscription and needs no API key: the file lands in
`/home/runner/.codex/generated_images/<thread-id>/`, a directory named after
the thread id Codex announces at the start of the run, and nothing in the
stream says it was made. The file's own name is the CLI's business and has
changed before, so the helper takes the newest PNG in the thread's directory.
The same helper serves both, as
`capitoline-collect-image codex <thread-id>`. The sudoers rule of §5 allows
any arguments to this path, so the script's own check is what bounds them:
an optional literal `codex` and one UUID, nothing else.

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

Re-run this install after every `git pull` (§8.3): the installed copy is a
snapshot, not a link, and `sudo` runs the installed path, never the one in
the clone.

Image generation needs no change to the `strict` settings of §6.4: for
`agy` a `generate_image` call is not a file write, so it runs headless with
no approval prompt, while `run_command` and real file writes keep stalling.
The tool takes only `ImageName` and `Prompt` — there is no size parameter,
which is why the API accepts `size` and reports it as ignored.

Verify, after §8 has the service running and §8.1 has given you a key in
`CAPITOLINE_API_KEY`. Each generation spends one unit of that model's image
quota:

```sh
sudo -n -H -u capitoline -- sudo -n -H -u runner -- \
  /usr/local/bin/capitoline-collect-image not-a-uuid; echo $?   # prints 2
for m in antigravity-image codex-image; do
  curl -s http://127.0.0.1:8080/v1/images/generations -H "authorization: Bearer $CAPITOLINE_API_KEY" \
    -H 'content-type: application/json' \
    -d "{\"model\":\"$m\",\"prompt\":\"a red fox in the snow, 16:9\"}" | jq -c '.capitoline'
done
```

Expected: `antigravity-image` answers `mime` `image/jpeg`, about 1376x768
and around a million bytes; `codex-image` answers `image/png`. `bad_output` with "too small" means the collected file is
not a picture (the `min_bytes` gate of the table above) — with the `strict`
settings of §6.4 the CLI writes no placeholder, so it points at a broken or
changed CLI, not at a quota hit. A quota hit is a 429 with `Retry-After`:
there are two rolling windows and the longer one resets in days, see
`docs/spike-2026-09.md` §8.

### 7.2 Model catalog and notifications

The models a provider serves come from two places. `config/capitoline.yaml`
declares the curated ones: short names such as `antigravity-gemini-flash`,
pinned efforts, the image agents, the models the councils and the health
probe name. A provider that also declares `discover` has its CLI asked, at
startup and then every `server.discovery_interval_h` hours (24 by default),
which models it serves, through the CLI's own command run as `runner` like
any other run:

| Provider | Command | Output |
|---|---|---|
| Codex | `codex debug models` | JSON catalog, about 500 KB, about 11 s |
| Antigravity | `agy models` | one `<id>\t<display name>` line per model |
| Claude | none | its names are aliases that follow the latest model |

The sudoers rule of §5 already allows both, since it allows the binaries with
any arguments. Nothing is edited, neither the repository's file nor the
overlay. What the listing changes lives in the process and in the `catalog`
table of the usage database:

- **A model the CLI lists and no declared entry reaches** is served as
  `<prefix><id>` — `codex-gpt-7-nova`, `antigravity-gemini-3.9-flash-high`.
  For Codex it gets the reasoning levels the catalog says it serves. It is
  not added when Codex marks it hidden, when its id is in `discover.exclude`
  (`gpt-5.5`, retiring on 2026-10-14), or when its name is taken.
- **A declared model none of whose ids is listed any more** is retired: it
  leaves `/v1/models`, a request for it gets a 404 saying so, and a council
  seat steps past it to the next model of its chain. The configuration stays
  valid. When the model comes back to the listing, it comes back.
- **The health probe** moves to the first `health_fallback` still listed when
  `health_model` is retired, instead of failing every round and taking the
  whole provider down with it.
- **A listing that fails**, comes back empty or cannot be read changes
  nothing. The previous catalog stays, and the log says why.

`/health` shows each catalog: when the CLI was last asked and whether it
answered, what discovery added, what it retired, and which model the probe is
running on. Every change is also a log line (`model catalog changed`).

**Notifications are optional.** With `server.notify` set, every change is
also sent as one plain-text `POST`, with a `Title` header, to the configured
URL — for example "codex models changed. new: codex-gpt-7-nova; no longer
served: codex-gpt-6-luna (used by health_model, council capitoline).". A
model the configuration still uses is named with where it is used, because
that is the change worth reading. The same channel carries one message per
new CLI version the daily check finds (`docs/update-clis.md`), with the
command that installs it. Nothing else is ever sent, and a failed POST is
logged and forgotten.

Any endpoint that takes a text POST works. [ntfy](https://ntfy.sh) is the
simplest: an open-source service that turns an HTTP POST to a topic into a
phone notification, usable free on the public server or self-hosted. In the
host overlay:

```yaml
server:
  notify:
    url: https://ntfy.sh/capitoline-<long random string>
    token_env: CAPITOLINE_NOTIFY_TOKEN   # optional
```

Subscribe to the same topic in the ntfy app. On the public server anyone who
knows a topic's name can read it, so the name is the secret: make it long and
random, or use an access token on a reserved topic or on your own server.
The token is read from the environment variable `token_env` names, never
from a file in the repository or the overlay: the unit of §8 reads
`/etc/capitoline/notify.env` when it exists.

```sh
install -m 0600 /dev/null /etc/capitoline/notify.env
echo 'CAPITOLINE_NOTIFY_TOKEN=tk_...' > /etc/capitoline/notify.env
systemctl restart capitoline
```

The URL is never logged.

## 8. systemd

```sh
cat > /etc/systemd/system/capitoline.service <<'UNIT'
[Unit]
Description=Capitoline AI gateway
# time-sync as well as the network: the persisted pauses are absolute
# instants, and a service that starts while the clock is still the RTC's
# guess would read a five-day pause as expired and collect it.
Wants=network-online.target
After=network-online.target time-sync.target
[Service]
User=capitoline
Group=capitoline
WorkingDirectory=/var/lib/capitoline/app
Environment=CAPITOLINE_CONFIG=/var/lib/capitoline/app/config/capitoline.yaml
Environment=CAPITOLINE_OVERLAY=/etc/capitoline/overlay.yaml
Environment=NODE_ENV=production
EnvironmentFile=-/etc/capitoline/notify.env
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

The two `CAPITOLINE_*` paths are the base and the overlay of §7. The leading
`-` of `EnvironmentFile` makes that file optional: it holds the notification
token of §7.2 on a host that uses one. The first line of the journal at every
start is `configuration loaded`, naming both files and the keys — never the
values — the overlay set.

`NoNewPrivileges` must stay off: `sudo` needs it. The service listens on
`server.host`, `127.0.0.1` unless the overlay says otherwise (§8.2), port
8080. The startup log shows `listening` first, then one
`health check` line per provider with `ok: true`: the port is bound before the
checks run, so a CLI that is slow to answer (the probe waits up to a minute)
never turns a restart into a connection refused. Until that first round lands
every request but `/health` is answered `503` with `Retry-After: 5`, so a
`curl` issued right after `systemctl start` can legitimately get one; the state
itself is visible throughout with `curl -s http://127.0.0.1:8080/health | jq`.

A login done while the service runs — a CLI signed in after §8, or a
credential renewed — is noticed at the next health check, up to an hour
later; until then that provider stays marked as signed out
(`auth_expired`). `systemctl restart capitoline` makes it immediate.

Between `listening` and the health checks the gateway sweeps `sandbox_root`
once: the `run-*` directories older than the longest `timeout_s` of the
configuration (per-model overrides included) plus twice `kill_grace_s` are
removed, and their names are logged as `removed stale sandboxes`. Those are the
working directories of runs an earlier instance was killed in the middle of; a
restart that left nothing behind logs nothing, which is the normal case. The
threshold is what a run of this configuration can take at most, so a run of a
second instance sharing the root would survive the sweep — but a CLI orphaned
by a previous instance has no timeout left to kill it, so one sandbox root per
gateway remains the rule.

`stale sandbox removal failed` names one `run-…` directory the gateway could
not delete, and it comes back at every restart until the directory is gone. The
usual cause is a subdirectory that the `runner` user created inside the sandbox
with a umask that leaves out the `capitoline` group: `ls -la
/var/lib/capitoline/sandboxes` shows owner and mode (§3 has the group the two
users share), and `rm -rf` of the named directory as root clears it. A `run-…`
directory that appears there *while* the service is running is another matter —
a run that hung rather than one that was killed — and is worth reading the
journal around its timestamp.

`invalid configuration` in the journal, followed by a restart every three
seconds, means the configuration was rejected. The line names the two files it
was built from, and the lines below it name the key and the reason (`runner: Unrecognized key(s) in object:
'usr'`, `runner.user: String must contain at least 1 character(s)`). Fix the
key and restart; `npm run check-config` of §7 prints the same message without
touching the service.

### 8.1 The gateway's own keys

Beside the Cloudflare Access JWT of §9 the gateway accepts keys it issued
itself, sent as `Authorization: Bearer cap_…` (design §4). They are the
identity that works with no Cloudflare in front, and the one
`docs/connecting-an-application.md` recommends for applications behind the
tunnel too. Keys are stored hashed in the usage database and issued and
revoked through `/v1/admin/keys` by the callers `server.access.admins` names:
an email from Access, a bound service token's name, or a key's own name. The
first one is made on the host, as the user that owns the database:

```sh
cd /var/lib/capitoline/app && sudo -Hu capitoline \
  env CAPITOLINE_OVERLAY=/etc/capitoline/overlay.yaml npm run -s keys -- create owner
```

The key is printed once. `list` and `revoke <name>` are the other two
commands. With `owner` in `server.access.admins` (§7, then a restart), that
key makes the others over HTTP.

With `server.access.team_domain` empty the gateway is open until the first
key exists and closed from then on; the startup log line `identity` says
which. With Access configured, a request that carries one of these keys is
judged on the key alone: that is how the host itself calls `/v1` on
`127.0.0.1`, where no request has passed through Cloudflare (§12).

The checks of this runbook read the key from the shell, never from a file
or the command line:

```sh
read -rs CAPITOLINE_API_KEY && export CAPITOLINE_API_KEY    # paste the key, then Enter
curl -s http://127.0.0.1:8080/v1/models -H "authorization: Bearer $CAPITOLINE_API_KEY" | jq '.data | length'
```

### 8.2 Without Cloudflare

On a network of your own the gateway can be reached directly, and its keys
are then the only door. Make the first key (§8.1) before anything else, then
set in the overlay:

```yaml
server:
  host: 0.0.0.0          # or one address of this host
```

Run `check-config` (§7) and restart. The service refuses to listen on
anything but the loopback while it would be open to the network, with no
Access and no key: the journal then says `refusing to listen on 0.0.0.0` and
names the command that makes a key.

The traffic is plain HTTP, keys included. Keep it on a network you trust, or
put a TLS reverse proxy on this host and leave `server.host` at `127.0.0.1`.
`/health` needs no key on any address the service listens on: it tells
whoever can reach the port which providers are up and which models they
serve, never who calls.

### 8.3 Updating the code

As `capitoline`, which owns the clone; the two helpers are then reinstalled
as root, because `sudo` and the timer run the installed copies, never the
clone's:

```sh
cd /var/lib/capitoline/app
sudo -Hu capitoline git pull --ff-only
sudo -Hu capitoline npm ci
sudo -Hu capitoline npm run build
sudo -Hu capitoline env CAPITOLINE_OVERLAY=/etc/capitoline/overlay.yaml npm run check-config
install -o root -g root -m 0755 scripts/capitoline-collect-image /usr/local/bin/capitoline-collect-image
install -o root -g root -m 0755 scripts/capitoline-backup /usr/local/bin/capitoline-backup
systemctl restart capitoline
curl -s http://127.0.0.1:8080/health | jq -c '.providers[] | {id, ok: .health.ok}'
```

A pull that needs more than this — a new sudoers rule, a new overlay key —
says so in its commit message. The CLIs are updated separately, one at a
time, with `scripts/update-cli.sh` (`docs/update-clis.md`).

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

Verify from your own computer:

```sh
curl -i https://api.example.com/v1/models          # 302 (browser login) or 401
curl -s https://api.example.com/v1/models \
  -H "CF-Access-Client-Id: <id>" -H "CF-Access-Client-Secret: <secret>" | jq   # 200
```

From the host, `curl -s http://127.0.0.1:8080/v1/models` now answers 401
unless it carries a key of §8.1 (no request to the loopback carries an Access
JWT), while `curl -s http://127.0.0.1:8080/health` still answers: that is the
intended exemption for local monitoring.

A verified token also says who is calling, and every usage row records it: the
email of a user token, and for a service token the `common_name` claim —
which holds the **client id**, `<32 hex>.access`, not the name typed into the
dashboard. `server.access.callers` maps an id to a name where `/v1/usage`
reports it, not where the row is written: a row stores the id Cloudflare
sent, so a token mapped an hour late reads back all the way, and renaming an
application renames its past with it. An id the overlay has not named is
reported as itself, which is unreadable and still correct. The same binding
can be made at run time, without a restart, by the admin API
(`PUT /v1/admin/callers/<client id>`, `docs/connecting-an-application.md` §2b), and a binding
made there wins over the overlay's. A key of §8.1 is reported by its name.

`GET /v1/usage` reports the last 24 hours grouped by it, which is how two
applications sharing one gateway are told apart. It is deliberately not on
`/health`: that route is the exemption above, readable by anyone who can open
127.0.0.1:8080 on this host — including `runner` — and this breakdown names
people. So it is read through the tunnel, with the service token, like any
other `/v1` route:

```sh
curl -s https://api.example.com/v1/usage \
  -H "CF-Access-Client-Id: <id>" -H "CF-Access-Client-Secret: <secret>" | jq .callers
# [ { "caller": "claude-code", "calls": 12, "inputTokens": 4210, "outputTokens": 980 } ]
```

A `caller` of `null` is a call nothing identified: one served while the
gateway was open, with no Access and no key. The
gateway's own health probes are left out of the breakdown — on this host they
are most of the table and would bury the rest under one `null` row.

The `inputTokens` and `outputTokens` columns of that table are sums over
whatever providers the caller used, and the three CLIs do not count the same
way. OpenAI reports cached and reasoning tokens *inside* the prompt and
completion counts, so `codex.ts` adds neither; Anthropic reports cached reads
*beside* the input, so `claude.ts` adds them; Antigravity leaves its cached
reads out of its own total and keeps its thinking tokens inside the output
(measured, `docs/spike-2026-09.md` §10), so `antigravity.ts` adds the first and
not the second. Each adapter is right for the CLI it reads, and no single
formula would make the three mean the same thing. So a caller's token sum is an
order of magnitude and not a measure, and it is not comparable with that same
caller's earlier sums either: what it means moves whenever the caller's mix of
providers moves. `calls` is the only homogeneous column here.

No endpoint splits those tokens by provider — not this one, and not `/health`,
which carries no token count at all: what it reports per provider is
`overBudget`, a boolean the gateway computes against that same provider's
`budget.window_5h_tokens` and `window_7d_tokens`, a comparison inside one
provider and therefore one of the few that stay valid. A
provider's tokens are read against its own history in the database, as the user
that owns it (§11 says why never as root):

```sh
sudo -u capitoline sqlite3 -readonly /var/lib/capitoline/usage.sqlite \
  "SELECT provider, COUNT(*), SUM(input_tokens), SUM(output_tokens) FROM calls
   WHERE ts > strftime('%s', 'now', '-7 days') * 1000 GROUP BY provider"
```

That is what shows a prompt that has grown or a model change that costs more.
For one figure across the three, count calls, not tokens: `calls` is the same
unit everywhere.

The same endpoint answers a different question in `.models`: **which real
model served each gateway name**, over the last week rather than the last day,
because what it is read for is a change.

```sh
curl -s https://api.example.com/v1/usage \
  -H "CF-Access-Client-Id: <id>" -H "CF-Access-Client-Secret: <secret>" | jq .models
# [ { "model": "claude-opus", "cliModelId": "claude-opus-5",   "calls": 40, "firstAt": …, "lastAt": … },
#   { "model": "claude-opus", "cliModelId": "claude-opus-5-5", "calls": 12, "firstAt": …, "lastAt": … } ]
```

Two rows under one name is an alias that moved. The configuration names CLI
aliases — `opus`, `fable`, `haiku` — and not dated ids, on purpose: the day
Anthropic points `opus` at a new model the gateway serves it with nothing
changed here, and this is where the move shows. Only Claude appears: a Codex slug
and an Antigravity id are the model itself, so those rows carry no id and are
left out rather than listed as unchanged.

A council is nine of those rows for the reference panel and five for
`capitoline-fast` (seven for a ladder), under as many models as
the seats and the judge resolved to, and they are tied
together by the identifier the deliberation minted — the same one the client
reads back in `capitoline.council.deliberationId`. That is what answers "what
did that question cost", which no time window can:

```sh
sudo -u capitoline sqlite3 -readonly /var/lib/capitoline/usage.sqlite \
  "SELECT deliberation, COUNT(*), SUM(input_tokens), SUM(output_tokens) FROM calls
   WHERE deliberation IS NOT NULL GROUP BY deliberation ORDER BY MIN(ts) DESC LIMIT 5"
```

**The council, through the tunnel, is asked for streaming.** `capitoline` is
not one call but nine, in three stages, and the first two produce no output
at all: every member is answering, or ranking, and nothing is written until
the judge starts the synthesis. `capitoline-fast` skips the ranking stage
and is no better off — one silent stage of four answers is still minutes of
nothing. Each stage is bounded per member by each council's
`stage_timeout_s` (300 s in both shipped blocks), so the wait before
the first byte is minutes, not seconds — while Cloudflare's edge gives up on
an origin that has sent nothing for 100 s and answers the client `524`. The
deliberation does not stop with it: its calls carry on — nine for the
reference panel, five for `capitoline-fast` — spending the
subscriptions for a client that is already gone.

So through the tunnel a council is asked for with `stream: true`, which opens
the response before the first stage — not on the first token, which is minutes
away — and then writes a line as each stage opens and as each member comes
back (`{"stage":"answers","done":2,"total":4}` in the chunk's `capitoline`
field, where an OpenAI client ignores it):

```sh
curl -N -s https://api.example.com/v1/chat/completions \
  -H "CF-Access-Client-Id: <id>" -H "CF-Access-Client-Secret: <secret>" \
  -H 'Content-Type: application/json' \
  -d '{"model":"capitoline","stream":true,"messages":[{"role":"user","content":"why?"}]}'
```

Opening the response early is only half of the answer, and the smaller half:
the silence that matters is *inside* a stage. Between `answers 0/4` and the
first member coming back, and above all between `synthesis 0/1` — written
before the judge is even chosen — and the judge's first token, nothing is
written for as long as that one call takes, which is the same 300 s as before.
So while a stage runs the gateway keeps the stream alive by itself, with an SSE
comment (`: keep-alive`) every 20 s. A comment frame carries no field, so it is
not a chunk: every conforming client drops it without seeing anything, the
OpenAI SDKs included, and the edge sees a byte four times inside its 100 s
budget. In a `curl -N` the line is visible, and it is the only thing there that
does not start with `data:`.

The non-streaming shape (`"stream": false`, the default) builds the whole body
before sending a byte, so nothing can keep the edge from timing it out: it is
for a client on the host itself (`http://127.0.0.1:8080`, inside the tunnel's
reach) and for the MCP tool, which has a timeout of its own (§10). The same
applies to any single model slow enough to stay silent for 100 s, but a
council is the only thing here that does it by design.

## 10. Claude Code as MCP client (on your own computer)

Through the tunnel, with a service token of §9:

```sh
claude mcp add --transport http capitoline https://api.example.com/mcp \
  --header "CF-Access-Client-Id: <id>" --header "CF-Access-Client-Secret: <secret>"
```

Without Cloudflare (§8.2), with a key of §8.1:

```sh
claude mcp add --transport http capitoline http://<host>:8080/mcp \
  --header "Authorization: Bearer cap_…"
```

A CLI answer can take minutes, an image 11-45 s and a deliberation longer
than either; raise the tool timeout in your shell profile:

```sh
export MCP_TOOL_TIMEOUT=1200000
```

Twenty minutes, and the figure is `ask_council`'s: a deliberation has no
deadline of its own, only each member of each stage has one — each council's
`stage_timeout_s`, 300 s in both shipped blocks (§9) — and the three
stages run in sequence, so the worst case is above 900 s with nothing wrong.
The timeout has to stay larger than three times `stage_timeout_s`; re-derive
it whenever that value changes. Below it Claude Code drops a call the
gateway keeps running, and the deliberation's calls carry on — nine for the
reference panel, five for `capitoline-fast` —
spending the subscriptions for a client that is already gone: the MCP twin
of the `524` of §9.

This is the only thing that keeps a long call alive. `ask_council` sends a
progress notification as each stage opens and as each member comes back
(`answers 2/4`, `rankings 0/4`, then the characters of the synthesis as the
judge writes it), and `generate_image` one every 5 s while it draws — both
only to a client that asked for one (a request with a progress token). But a
notification postpones the client's deadline only when that client sets
`resetTimeoutOnProgress`, off by default in the MCP TypeScript SDK (spec
§6.2): treat the progress as a sign of life for whoever is watching the call,
and the timeout above as the thing that carries it.

Test: in Claude Code run `/mcp` (the server must show as connected), then
ask "use capitoline ask_model with codex-gpt-6-luna: reply ok", "use capitoline
generate_image: a red fox in the snow" and "use capitoline ask_council: why
is a blind ranking better than a public one?". The last one is nine calls on
three subscriptions and takes minutes: run it once, and not on a day when
the quotas are already tight (§9).

## 11. Backup

Daily, as the `capitoline` user, of the usage database and the configuration.
Credentials are deliberately not backed up: if one is lost, log in again
(§6). A copy of a token is one more secret to protect, and it buys nothing —
the CLIs bind a credential to the machine that obtained it.

`scripts/capitoline-backup` ships in the repository and is installed from the
clone of §7, like the image helper of §7.1:

```sh
install -o root -g root -m 0755 \
  /var/lib/capitoline/app/scripts/capitoline-backup \
  /usr/local/bin/capitoline-backup
install -d -o capitoline -g capitoline -m 0700 /var/backups/capitoline
```

Owned by `root` and not writable by `capitoline`, for the same reason as
§7.1, and a snapshot of the clone rather than a link: §8.3 reinstalls it. The destination is a directory of its own under
`/var/backups` (which is `0755`), owned by `capitoline` and `0700`: the unit
below runs as `capitoline`, and nothing on this host — `runner` included —
has any business reading the archives.

`capitoline-backup <dest-dir>` writes `<dest-dir>/capitoline-<date>.tgz`,
mode `0600`, holding two flat entries: `usage.sqlite` and `capitoline.yaml`.
The database goes in through `sqlite3 "VACUUM INTO"`, never through `tar` or
`cp` over the live file: the service keeps the database open in WAL mode, so
the most recent committed rows sit in the `-wal` sidecar until a checkpoint,
and an archive of the main file alone restores a database that has silently
lost them. `VACUUM INTO` takes a read lock — the service does not have to be
stopped — and writes one self-contained file, with no sidecar to keep
together. The archive is written as `capitoline-<date>.tgz.part` and renamed
only once `tar` has returned, so a run that dies half-way — a full `/var` is
the realistic case — leaves nothing behind rather than a truncated file
carrying the day's date, which would read as that day's backup and, counted
by the retention rule, would cost a good older archive. The script keeps the
14 most recent archives and exits non-zero, with the reason on stderr, when
the destination directory, the database, the configuration or `sqlite3`
itself is missing. The two paths default to the
production ones and can be overridden with `CAPITOLINE_DB` and
`CAPITOLINE_CONFIG`, the retention with `CAPITOLINE_BACKUP_KEEP`.

A systemd timer, not `/etc/cron.daily`: the last run, its exit code and its
output are then visible with `systemctl status`, in the journal, next to the
service's own lines — a cron failure on an unwatched machine is an email
nobody reads.

```sh
cat > /etc/systemd/system/capitoline-backup.service <<'UNIT'
[Unit]
Description=Capitoline backup
[Service]
Type=oneshot
User=capitoline
Group=capitoline
# The host-specific file, the overlay of §7: the base configuration is in git
# and needs no backup. The archive entry is named `capitoline.yaml`.
Environment=CAPITOLINE_CONFIG=/etc/capitoline/overlay.yaml
ExecStart=/usr/local/bin/capitoline-backup /var/backups/capitoline
UNIT
cat > /etc/systemd/system/capitoline-backup.timer <<'UNIT'
[Unit]
Description=Daily Capitoline backup
[Timer]
OnCalendar=daily
RandomizedDelaySec=15m
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now capitoline-backup.timer
```

`Persistent=true` runs a backup missed while the host was off at the next
boot instead of skipping the day.

`User=capitoline` rather than root, and not only on principle: `sqlite3`
opening the WAL database creates `usage.sqlite-shm` (and recovers `-wal`)
owned by the user that runs it. If the timer fires while the service is
stopped — a deploy, a restart loop — root is then the only connection, and a
run interrupted before sqlite removes them leaves both sidecars owned by
`root:root` in `/var/lib/capitoline`; the service, which runs as
`capitoline`, can no longer open its own database read-write, and under
`Restart=always` that is a silent restart loop. As `capitoline` the job needs
nothing it does not already have: it owns the database, reads
`/etc/capitoline/overlay.yaml` through the group of §7, and owns the
destination directory.

Verify one run by hand, with the service running — that is the case the
archive has to survive:

```sh
systemctl start capitoline-backup
systemctl status capitoline-backup     # "Deactivated successfully", no "status=1"
ls -l /var/backups/capitoline/
systemctl list-timers capitoline-backup.timer
```

Then copy `/var/backups/capitoline/capitoline-*.tgz` off the host with the
owner's usual mechanism (rsync to another machine, or a bucket). An archive that
never leaves the host is not a backup.

### 11.1 Restore

As root, into a scratch directory first, always, and verify it there: an
archive is worth nothing until it has been read once.

```sh
install -d -o capitoline -g capitoline -m 0700 /var/tmp/restore
tar xzf /var/backups/capitoline/capitoline-<date>.tgz -C /var/tmp/restore
sqlite3 /var/tmp/restore/usage.sqlite 'PRAGMA integrity_check; SELECT COUNT(*), MAX(ts) FROM calls;'
install -o capitoline -g capitoline -m 0600 \
  /var/tmp/restore/capitoline.yaml /var/tmp/restore/capitoline.checked.yaml
cd /var/lib/capitoline/app && sudo -Hu capitoline \
  env CAPITOLINE_CONFIG=config/capitoline.yaml \
      CAPITOLINE_OVERLAY=/var/tmp/restore/capitoline.checked.yaml npm run check-config   # prints "configuration OK"
```

`integrity_check` prints `ok`, the count is non-zero and `MAX(ts)` is a
millisecond epoch from the day the backup ran (`date -d @$(( <ts> / 1000 ))`).
The archived configuration is the host's overlay (the entry is named
`capitoline.yaml`), so it is validated the way the service reads it: merged
over the clone's `config/capitoline.yaml`. A count that stops days before the backup means the snapshot lost the WAL —
the failure this whole section exists to prevent — and the archive is not
usable. The configuration is validated here, before the restart rather than
after, because restoring replaces the file the service reads at startup and a
rejected one under `Restart=always` is a restart loop whose only trace is the
journal (§8).

The two `install` lines are not decoration. `tar` run by root restores the
owner and the mode recorded in the archive, and the archived configuration
carries those of the installed file — `0640`, or `0600` from a run of the
timer as `capitoline` — so the extracted copy is not readable by whoever
`check-config` runs as; the check would fail with `EACCES` before it ever
reached the schema, in the middle of a restore, which is the one procedure
that has to work on the first try. Hence a copy of the configuration owned by
`capitoline`, validated in place of the original, which stays untouched for
the step below. And hence a scratch directory owned by `capitoline` and
`0700` rather than `mkdir -p`: the extracted database is a full copy of the
usage data, and `/var/tmp` is world-readable on a host that also runs
`runner`.

Putting it back. The configuration goes back to the overlay:

```sh
systemctl stop capitoline
install -o root -g capitoline -m 0640 /var/tmp/restore/capitoline.yaml /etc/capitoline/overlay.yaml
install -o capitoline -g capitoline -m 0640 /var/tmp/restore/usage.sqlite /var/lib/capitoline/usage.sqlite
rm -f /var/lib/capitoline/usage.sqlite-wal /var/lib/capitoline/usage.sqlite-shm
systemctl start capitoline
curl -s http://127.0.0.1:8080/health | jq
rm -rf /var/tmp/restore
```

Stop the service first: replacing the file under a running process leaves it
writing into the database it still holds open, and the restored one is
overwritten the moment it checkpoints. The old `-wal`/`-shm` must go with it —
they describe the file being replaced, and sqlite would try to apply them to
the new one. The ownership is the one of §7: the configuration is read by
`capitoline`, the database is written by it. The scratch directory goes last,
once the service answers: it holds a second copy of everything §11 exists to
keep private.

What a restore does not bring back: the CLI credentials (§6, log in again) and
the Cloudflare service token (§9). The gateway comes up degraded until the
first `claude`/`codex`/`agy` login is done, and `/health` names the provider
that is still unauthenticated; restart the service after the logins (§8).

## 12. Smoke test

One real call per provider with its `health_model`, read from the clone's
`config/capitoline.yaml`, and with `SMOKE_IMAGE=1` one image generation
whose result must be larger than `image.min_bytes`. The script needs `curl`
and `jq` on the machine it runs from, and a checkout of the repository.

On the host, with the key of §8.1 in `CAPITOLINE_API_KEY` — the loopback
path works the same with or without Access, since a key is judged on its
own:

```sh
cd /var/lib/capitoline/app && scripts/smoke.sh http://127.0.0.1:8080
```

Through the tunnel, from your own computer, the Access headers get the
request past the edge (a key can go with them):

```sh
CF_ACCESS_CLIENT_ID=<id> CF_ACCESS_CLIENT_SECRET=<secret> \
  scripts/smoke.sh https://api.example.com
```

Expected: three lines with status `200`, a short answer and a token count,
and an `image` line that says `skipped`; exit code 0. With `SMOKE_IMAGE=1`
the image line is one real generation, `200` and the size of the picture:
the only end-to-end check of the sudoers entry of §5 and of the helper of
§7.1, and it spends one unit of an image quota, so it is off by default. A
429 on the image model is printed and does not fail the run.
`SMOKE_IMAGE_MODEL=codex-image` checks the Codex one instead of the first the
configuration declares. `scripts/update-cli.sh` runs this script after every
CLI update (`docs/update-clis.md`).
