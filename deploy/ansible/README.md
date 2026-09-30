# Installing with Ansible

`site.yml` builds a Capitoline host the way `docs/deploy.md` does, §1 to §8
with §7.1 and §11, and `verify.yml` checks it once the CLIs are logged in. The
runbook stays the reference: every task names the section it comes from, and
the runbook says why each step is what it is.

What stays by hand: the CLI logins (§6), which only the owner of each
subscription can do, and Cloudflare (§9). The first key (§8.1) is made on the
host, since it is shown once.

## Run

From this directory, on your own computer, with Ansible 2.15 or later and
root SSH access to a fresh Debian 13 or Ubuntu 24.04 host:

The first connection to a new host asks to trust its SSH key. Compare it with
the one the host itself reports, from its console (`ssh-keygen -lf
/etc/ssh/ssh_host_ed25519_key.pub`, or `pct exec <id> -- …` on Proxmox),
before answering yes: that comparison is the only thing telling you the key is
the host's.

```sh
cp inventory.example.yml inventory.yml      # name the host; inventory.yml is not in git
ansible-playbook site.yml --check --diff    # what would change
ansible-playbook site.yml                   # build
# the logins it prints at the end, on the host
ansible-playbook verify.yml                 # restart, the checks of §6 and §12
```

The host gets the commit this directory is checked out at, cloned from GitHub,
so it has to be pushed: check out a tag to install that version. A second run changes nothing unless the host drifted,
and `--check --diff` shows how.

## Choices

| Variable | Default | |
|---|---|---|
| `capitoline_providers` | all three | the CLIs installed; a subset is written to the overlay as `serve` |
| `capitoline_councils` | every council | `[]` when serving Claude alone, which cannot seat one |
| `capitoline_overlay_src` | empty | a file of yours to install as the overlay on every run; empty writes one once and never touches it again |
| `capitoline_admin` | `owner` | the key name the overlay admits to `/v1/admin` |
| `capitoline_listen` | `127.0.0.1` | `server.host`; another address needs a key first (§8.2) |
| `capitoline_verify_images` | `false` | `verify.yml` generates one image per image model, a unit of each quota |

Claude alone, for one application:

```yaml
capitoline_providers: [claude]
capitoline_councils: []
```

The CLI versions are the ones this repository was verified with,
`providers.<id>.version.verified` in `config/capitoline.yaml`. Antigravity's
installer takes no version, so the playbook installs it only when it is missing
and says when the one installed is not the verified one.
