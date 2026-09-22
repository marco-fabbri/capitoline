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
pull that changes it. That is the whole point of the shape: the production
file used to be a full hand-made copy, so a required key added upstream
reached the host only when someone retyped it, and on 2026-09-22 that cost two
restart loops in one day.

Merge rules, from `mergeConfig` in `src/config.ts`:

- objects merge key by key, so naming one binary leaves the rest of that
  provider untouched;
- a scalar or a **list replaces** the base's value whole. A list is never
  appended to — that is what a host changing a flag needs, and it is why the
  `claude` block writes out the whole `args` list to add one argument;
- `null` is a value, not a deletion: `effort_flag: null` and `runner.user:
  null` are declared values of this schema;
- the merged result is validated once, by the same strict schema the single
  file went through, so a key the overlay mistypes is rejected by name rather
  than dropped.

Edit `/etc/capitoline/overlay.yaml`:

| Key | Production value |
|---|---|
| `runner.user` | `runner` |
| `runner.sandbox_root` | `/var/lib/capitoline/sandboxes` |
| `usage.db_path` | `/var/lib/capitoline/usage.sqlite` — absolute, because the service's working directory is the clone |
| `providers.claude.binary` | `/home/runner/.npm-global/bin/claude` |
| `providers.claude.args` | the repository's list plus `--settings` and `/home/runner/.claude/capitoline.json` as two more items, written out in full because a list replaces. That file (owned by `runner`, mode `0600`) holds `{"env":{"CLAUDE_CODE_OAUTH_TOKEN":"..."}}`, and `--settings` applies even with `--setting-sources ""`, so the gateway process never sees the token. It is the one value the overlay pins against the repository: re-read it after a pull that changes `providers.claude.args`, with the command below |
| `providers.codex.binary` | `/home/runner/.npm-global/bin/codex` |
| `providers.antigravity.binary` | `/home/runner/.local/bin/agy` |
| `providers.antigravity.image.collect` | `[/usr/local/bin/capitoline-collect-image]` — must match the sudoers path of §5 (a developer machine sets `runner.user: null` and points it at `scripts/capitoline-collect-image`; the runner then spawns it directly, as the developer, so it reads that machine's own `$HOME`) |
| `server.access.team_domain`, `server.access.audience` | filled in §9; both empty until then |

`config/overlay.example.yaml` in the repository is exactly this file with the
Access pair left empty, and `test/config.test.ts` pins the list of keys that
example sets: a key added to it, or dropped from it, fails in CI until the
list in the test is updated too. The table above is prose and nothing checks
it against either — a row added here without a key there passes, so the two
are kept in step by hand.

Everything else stays in the repository file, the verified set for the CLI
versions of `docs/update-clis.md`. Three of its keys are worth knowing even
though they are not host-specific, all under `providers.antigravity.image`:

| Key | Why it reads as it does |
|---|---|
| `min_bytes` | `200000` — below this the collected file is a placeholder, not a picture, and the request fails with `bad_output` rather than returning a grey rectangle (placeholders were observed at 2-65 KB against 1.8-2.4 MB for a real image) |
| `quota_per_window` | `12` — the short image quota, 12 generations per 5 hours (the window length is fixed in the code, `H5`), reported only: the gateway never blocks on it. `/health` (`providers[].imageQuota`) and `/v1/models` (`capitoline.quota`) show `used` against it, and `used` is a lower bound rather than an exact count: it counts the successful generations served by the images endpoint, while a text run that invokes `generate_image` spends quota without being counted, and so does a generation the client abandons. Leave the key out and the count is still reported, with `limit: null`. The second, much longer quota of the same model (days) cannot be counted: it appears only as the `resetAt` of a quota hit, in `/health` and in the MCP `list_models` tool — never in `/v1/models`, which by then no longer lists the paused model |
| `allowed_tools` | `[generate_image]` — do not extend: any other tool call aborts the run, which is what keeps an image request from turning into an agent session |

**The council block.** `council:` is in the repository file too, and it is the
one block that changes what a request costs. It holds three councils, each a
virtual model of its own name, and they differ only in who sits and whether
the ranking stage runs — nothing in the code tells them apart, so a fourth one
is configuration and a restart:

| Council | What it convenes | Calls |
|---|---|---|
| `capitoline` | the reference panel: four families answer, rank each other blind, and a judge seated apart synthesizes. The shape to ask when the panel's own verdict on its answers is worth its price | 9 |
| `capitoline-fast` | the same four families and the same judge with `ranking: false`, so stage 2 never runs: the everyday shape, at half the price and with no panel verdict on the four answers | 5 |
| `capitoline-gemini` | the first capability ladder: one family at three reasoning levels, all three rungs on Antigravity, judged from outside by `codex-gpt-6-astra`, with `claude-fable`, `claude-opus` and `codex-gpt-5.6-sol` behind it. A measuring instrument to run over a sample of questions, not a daily mode; `min_members: 3` makes it refuse rather than report a ladder that is missing a rung | 7 |

The price is one call per seat, one more per seat when the ranking stage runs,
and one for the judge. The reference panel's nine land on three different
subscriptions at once: Anthropic, OpenAI and Antigravity answer in parallel in
each of the two member stages, Antigravity twice over because the Google seat
and the open-weights seat sit on that same subscription, and the ninth call
spends the Anthropic window again for the judge. So one question costs about
what nine direct requests cost, on windows this host does not replenish, and
takes as long as the slowest member of each stage in turn. `capitoline-gemini`
is the opposite shape: six of its seven calls are one Antigravity
subscription, and only the judge's is spent elsewhere. Nothing rations any of
it but the per-provider `concurrency`: a client looping over councils empties
three windows at the same time.

Every key below is read from each of the three blocks; the values are the
shipped `capitoline`'s.

| Key | Why it reads as it does |
|---|---|
| `seats` | four families, each a **chain** and never one model: the first model the health and quota state reports available takes the seat, and an unforeseen refusal steps down the chain once. `agy-claude-*` is deliberately not seated — it is the Anthropic seat's opinion through another channel, and a panel of four wants four judgments. `capitoline-gemini` is the exception, and deliberately: its three seats are single models, because a rung that steps down is no longer the rung whose capability was being measured, so a refused rung is a lost seat (design §12.5) and, with `min_members: 3`, the ladder does not run at all |
| `judge` | The top model of each family, descending: `claude-fable`, `claude-opus`, `codex-gpt-6-astra`, `agy-gemini-pro`, `codex-gpt-5.6-sol`. The judge writes the answer the client reads, so it is the one seat where economising is false economy — a cheap judge was measured on 2026-09-22 merging three answers into a claim none of them made. No weak model closes the chain either: when no judge can be seated the council returns the best-ranked answer unsynthesised and says so (design §12.5), which is a better floor than a weak synthesis. The chain has one more model than the panel has seats, so the `judge_allow_member: false` filter alone can never empty it. `capitoline-gemini` opens on `codex-gpt-6-astra` instead and ends on `codex-gpt-5.6-sol`, with no Gemini anywhere: a Claude judge would spend back, on one call in seven, the Anthropic window that ladder was put on Gemini to spare, and a Gemini judge would synthesize its own measurement |
| `judge_allow_member` | `false` — the judge is seated apart, so no synthesizer weighs an answer it wrote itself. `true` reproduces karpathy/llm-council's shape, where the chairman is also a member |
| `judge_blind` | `true` — the judge sees the labels, never the real model names, so the deliberation is blind end to end. The transparency is not lost, it moves: the client's `capitoline.council` field carries the un-blinded record |
| `min_members` | `2` — below two answers there is nothing to rank. With one the gateway returns that answer and says no council took place, rather than dressing a single opinion as a synthesis. `capitoline-gemini` sets `3`, its whole seating: a ladder missing a rung has nothing to compare against and measures nothing, so it refuses and `/v1/models` says it cannot be run today |
| `ranking` | `true` here and for the ladder, `false` for `capitoline-fast`: with `false` stage 2 does not run, the judge is given the answers with no aggregate to weigh, and a four-seat council costs five calls instead of nine. It is the one setting that changes the *sequence* of stages, which is why it is a flag in the engine and not a fourth prompt (design §12.9) |
| `stage_timeout_s` | `300` — per member and per stage, not for the whole deliberation. A council can therefore run for a quarter of an hour on paper, which is why it is asked for streaming through the tunnel (§9) and with a raised tool timeout over MCP (§10) |

`providers.antigravity.concurrency` is `3` for these blocks' sake, measured
against the **largest** council the provider is seated in: `capitoline` and
`capitoline-fast` seat two chains there each, Google and open weights, while
`capitoline-gemini` is three rungs and every one of them is Antigravity. All
three start in the same instant, and with fewer slots the last of them would
sit on that provider's queue until `server.queue.max_wait_s` and lose its seat
— in every parallel stage, every time. It is not three subscriptions, only
three processes against the same one, which is one more than `claude` already
runs; the quota is accounted per model, not per slot.

The slots belong to the subscription and not to one council, so the check
reads every block and measures each provider against the largest council it is
seated in, never the sum of them: the sum would make the slots grow with the
number of names declared — these three councils would ask this one Antigravity
subscription for seven parallel `agy` processes, a number nobody has measured
— and, since the gateway validates at startup, would leave a file the service
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

One value in the overlay is a copy of a repository value and drifts silently:
`providers.claude.args`, written out in full because a list replaces. After a
pull that changes it the host keeps passing the old command line, and
`check-config` stays green — the schema is satisfied either way. Re-read it
with the same two files the service loads:

```sh
cd /var/lib/capitoline/app && sudo -Hu capitoline node -e "
import('./dist/config.js').then(m => {
  const repo = m.loadConfig('config/capitoline.yaml').providers.claude.args;
  const host = m.loadConfig('config/capitoline.yaml', '/etc/capitoline/overlay.yaml').providers.claude.args;
  const same = JSON.stringify(host.slice(0, repo.length)) === JSON.stringify(repo);
  console.log(same ? 'args in step; the host adds: ' + host.slice(repo.length).join(' ')
                   : 'DRIFT\nrepo: ' + repo.join(' ') + '\nhost: ' + host.join(' '));
});"
```

It prints `args in step` and the host's own tail (`--settings
/home/runner/.claude/capitoline.json`) when the overlay's list is still the
repository's plus that tail, and the two command lines when it is not — in
which case edit the overlay's `args` to the repository's list with the tail
back at the end. Run it after every pull that touches `claude`'s flags
(`docs/update-clis.md` step 3). The residue is recorded in `docs/backlog.md`
§ Deployment: a dedicated key for the host's extra arguments would remove the
duplication altogether.

**A host that still runs a full copy keeps working.** Passing no overlay is
still supported and behaves exactly as it did, so a deployment where
`CAPITOLINE_CONFIG` alone names `/etc/capitoline/capitoline.yaml` is valid —
it just keeps drifting, and every key added upstream has to be retyped into
it. To migrate: write the overlay, point `CAPITOLINE_CONFIG` at the clone's
`config/capitoline.yaml` and add `CAPITOLINE_OVERLAY` to the unit (§8),
validate with the command above, restart, then delete the old copy. Move the
backup with it (§11): from that moment the overlay is the only file on this
host that is not in git.

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
# time-sync as well as the network: the persisted pauses are absolute
# instants, and a service that starts while the clock is still the RTC's
# guess would read a five-day pause as expired and collect it.
After=network-online.target time-sync.target
[Service]
User=capitoline
Group=capitoline
WorkingDirectory=/var/lib/capitoline/app
Environment=CAPITOLINE_CONFIG=/var/lib/capitoline/app/config/capitoline.yaml
Environment=CAPITOLINE_OVERLAY=/etc/capitoline/overlay.yaml
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

The two `CAPITOLINE_*` paths are the base and the overlay of §7, in that
order; the base is written out in full rather than left to the working
directory, so the unit says which files the service reads without the reader
having to know what `WorkingDirectory` is. The first line of the journal at
every start is `configuration loaded`, naming both files and the keys — never
the values — the overlay set. A host that has not migrated yet keeps the
single `CAPITOLINE_CONFIG=/etc/capitoline/capitoline.yaml` and no
`CAPITOLINE_OVERLAY`, and behaves exactly as before; `CAPITOLINE_OVERLAY=`
with nothing after it counts as no overlay too, which is how the variable is
turned off without editing the unit's other lines.

`NoNewPrivileges` must stay off: `sudo` needs it. The service listens on
`127.0.0.1:8080` only. The startup log shows `listening` first, then one
`health check` line per provider with `ok: true`: the port is bound before the
checks run, so a CLI that is slow to answer (the probe waits up to a minute)
never turns a restart into a connection refused. Until that first round lands
every request but `/health` is answered `503` with `Retry-After: 5`, so a
`curl` issued right after `systemctl start` can legitimately get one; the state
itself is visible throughout with `curl -s http://127.0.0.1:8080/health | jq`.

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
seconds, means the configuration was rejected. The line names the files it was
built from — one with `CAPITOLINE_CONFIG` alone, both when `CAPITOLINE_OVERLAY`
is set — and the lines below it name the key and the reason (`runner: Unrecognized key(s) in object:
'usr'`, `runner.user: String must contain at least 1 character(s)`). Fix the
key and restart; `npm run check-config` of §7 prints the same message without
touching the service.

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

A verified token also says who is calling, and every usage row records it: the
email of a user token, the name (`common_name`) of a service token.
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

A `caller` of `null` is a call nothing identified: one served while
`server.access.team_domain` is empty, or a row written before the column
existed (the database is upgraded in place, the history is kept). The
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

A council is nine of those rows for the reference panel, five for
`capitoline-fast` and seven for `capitoline-gemini`, under as many models as
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
`stage_timeout_s` (300 s in all three shipped blocks), so the wait before
the first byte is minutes, not seconds — while Cloudflare's edge gives up on
an origin that has sent nothing for 100 s and answers the client `524`. The
deliberation does not stop with it: its calls carry on — nine for the
reference panel, five for `capitoline-fast`, seven for `capitoline-gemini`,
six of those on the one Antigravity subscription — spending the
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

## 10. Claude Code as MCP client (on the Mac)

```sh
claude mcp add --transport http capitoline https://api.example.com/mcp \
  --header "CF-Access-Client-Id: <id>" --header "CF-Access-Client-Secret: <secret>"
```

A CLI answer can take minutes, an image 11-45 s and a deliberation longer
than either; raise the tool timeout in the Mac shell profile:

```sh
export MCP_TOOL_TIMEOUT=1200000
```

Twenty minutes, and the figure is `ask_council`'s: a deliberation has no
deadline of its own, only each member of each stage has one — each council's
`stage_timeout_s`, 300 s in all three shipped blocks (§9) — and the three
stages run in sequence, so the worst case is above 900 s with nothing wrong.
The timeout has to stay larger than three times `stage_timeout_s`; re-derive
it whenever that value changes. Below it Claude Code drops a call the
gateway keeps running, and the deliberation's calls carry on — nine for the
reference panel, five for `capitoline-fast`, seven for `capitoline-gemini` —
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
ask "use capitoline ask_model with codex-gpt-5.5: reply ok", "use capitoline
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
apt-get install -y sqlite3
install -o root -g root -m 0755 \
  /var/lib/capitoline/app/scripts/capitoline-backup \
  /usr/local/bin/capitoline-backup
install -d -o capitoline -g capitoline -m 0700 /var/backups/capitoline
```

Owned by `root` and not writable by `capitoline`, for the same reason as
§7.1, and a snapshot of the clone rather than a link: re-install it after a
`git pull` that changes it. The destination is a directory of its own under
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
# The host-specific file, which on a host migrated to the overlay of §7 is the
# overlay: the base configuration is in git and needs no backup. The archive
# entry is named `capitoline.yaml` whatever this points at.
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
owner's usual mechanism (rsync to the Mac, or a bucket). An archive that
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
The archived configuration is the host's overlay (§11 archives whatever
`CAPITOLINE_CONFIG` names, under the entry name `capitoline.yaml`), so it is
validated the way the service reads it: merged over the clone's
`config/capitoline.yaml`. On a host that never migrated it is a full
configuration instead, and the `CAPITOLINE_OVERLAY` line comes off.
A count that stops days before the backup means the snapshot lost the WAL —
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

Putting it back. The configuration goes back into the file this host's own
unit names — `/etc/capitoline/overlay.yaml` on a host migrated to the overlay
of §7, `/etc/capitoline/capitoline.yaml` on one that still runs a full copy,
the same distinction the validation above makes. It is read from the unit
rather than assumed, because writing the archive into the other file leaves
the live configuration in place: the service then restarts clean on exactly
what was being replaced, and nothing says so. `CAPITOLINE_OVERLAY` first and
`CAPITOLINE_CONFIG` only when it is unset or empty, since on a migrated host
the base is the clone's `config/capitoline.yaml`, which is in git and is not
what the archive holds.

```sh
systemctl stop capitoline
env=$(systemctl show capitoline -p Environment --value | tr ' ' '\n')
dest=$(printf '%s\n' "$env" | sed -n 's/^CAPITOLINE_OVERLAY=//p')
dest=${dest:-$(printf '%s\n' "$env" | sed -n 's/^CAPITOLINE_CONFIG=//p')}
echo "$dest"        # /etc/capitoline/overlay.yaml, or the full copy — never the clone's own file
install -o root -g capitoline -m 0640 /var/tmp/restore/capitoline.yaml "$dest"
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
that is still unauthenticated.

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
cd /var/lib/capitoline/app && scripts/smoke.sh http://127.0.0.1:8080
# add SMOKE_IMAGE=1 to include one real generation: it spends a unit of a quota
# that is 12 per 5 hours and 58 per week, so it is off by default. A 429 on the
# image model is printed and does not fail the run.
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

(from the clone, as above: the script reads the `health_model` of each
provider out of `config/capitoline.yaml`, and model names are not something
the host overlay changes.)

Expected: three lines with status `200`, a short answer and a token count,
then an `image` line with `200` and the size of the collected picture; exit
code 0. Run it again after every CLI update (`docs/update-clis.md`).
