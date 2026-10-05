#!/usr/bin/env bash
# Updates one CLI on the host, checks it, and puts the previous version back if
# a check fails. Run as root from the clone (docs/update-clis.md, "Procedure").
#
#   scripts/update-cli.sh <claude|codex|antigravity|agy> [version]
#   scripts/update-cli.sh <codex|antigravity|agy> image     only the image check, later
#
# Never run unattended, and never from a timer: the CLIs are agents, and a new
# version can switch on a tool the configuration never had reason to switch off
# (Codex 0.155 and 0.156 turned on image generation and twelve more). The
# gateway announces a new version (docs/update-clis.md); a person decides to run
# this, and this decides nothing a person has not seen: it stops at the first
# thing it cannot judge.
#
# 1. Before: the installed version; for Antigravity a copy of the binary, since
#    its installer only ever installs the latest; for Codex the enabled features.
# 2. Install, as runner: npm for Claude Code and Codex (a version may be given),
#    the official installer for Antigravity (it verifies the SHA-512 itself).
# 3. Check: Codex must enable no feature it did not enable before; then the
#    smoke test, with three images from this CLI's own image model if it has one,
#    through a temporary gateway key created and revoked here; then, for Codex,
#    a request to run a command must produce no step (codex-tool-probe.mjs);
#    for Antigravity, the same request must not run (docs/deploy.md §6.4), and
#    the CLI must still honour the switch that stops it updating itself (§6.3c).
# 4. On any failure: the previous version back, and the smoke test again.
#
# The image is the one check that can be out of reach: an image quota can stay
# used up for days, and holding a CLI back that long over it would be out of
# proportion, since every other check runs without it. So with the quota used
# up the update goes ahead, says the image was not verified, and keeps what a
# later rollback needs (the previous version's number, and for Antigravity its
# binary) under $STATE. `update-cli.sh <cli> image` then runs that one check
# when the quota is back, and puts the previous version back if it fails.
#
# No restart is needed either way: the gateway starts a CLI per request.
set -euo pipefail

cli="${1:-}"
[[ "$cli" == agy ]] && cli=antigravity   # the command's name, for the provider's
target="${2:-latest}"
case "$cli" in
  claude)      pkg="@anthropic-ai/claude-code"; image_model="" ;;
  codex)       pkg="@openai/codex";             image_model="codex-image" ;;
  antigravity) pkg="";                          image_model="antigravity-image" ;;
  *) echo "usage: $0 <claude|codex|antigravity> [version]" >&2; exit 2 ;;
esac
[[ $EUID -eq 0 ]] || { echo "update-cli: run as root (it installs as runner and creates a gateway key as capitoline)" >&2; exit 2; }
[[ -z "$pkg" && "$target" != "latest" && "$target" != "image" ]] && { echo "update-cli: the Antigravity installer only installs the latest version" >&2; exit 2; }
[[ "$target" == "image" && -z "$image_model" ]] && { echo "update-cli: $cli has no image model to check" >&2; exit 2; }

APP="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP"
OVERLAY="${CAPITOLINE_OVERLAY:-/etc/capitoline/overlay.yaml}"
BASE="${CAPITOLINE_URL:-http://127.0.0.1:8080}"
# The binary and the runner user as the service sees them: the base
# configuration merged with the host's overlay.
read -r BIN RUNNER SWITCHED_OFF PROBE_MODEL < <(sudo -u capitoline env CAPITOLINE_OVERLAY="$OVERLAY" node -e "
  Promise.all([import('./dist/config.js'), import('./dist/providers/adapter.js')]).then(([m, a]) => {
    const c = m.loadConfig('config/capitoline.yaml', process.env.CAPITOLINE_OVERLAY || undefined);
    const p = c.providers['$cli'];
    if (!p) { console.error('update-cli: $cli is not served on this host (serve.providers in the overlay)'); process.exit(1); }
    // The Codex features the configuration switches off (-c features.<name>=false):
    // a default the CLI turns on and these name is already handled.
    const off = [...p.args, ...p.args_extra].map((a) => /^features\\.([a-z0-9_]+)=false$/.exec(a)?.[1]).filter(Boolean);
    // The CLI id the health probe sends, at its lowest effort: what the
    // Antigravity checks below ask with, so no model id is written here.
    const spec = a.modelSpecs('$cli', p).find((s) => s.name === p.health_model);
    console.log(p.binary, c.runner.user, off.join(',') || '-', spec ? a.cliId(p, spec, 'low') : '-');
  });")
[[ -x "$BIN" && -n "$RUNNER" ]] || { echo "update-cli: no binary or runner user for $cli in the configuration" >&2; exit 1; }

WORK="$(mktemp -d)"; chown "$RUNNER": "$WORK"
# What an image check postponed by a used-up quota needs later. Root's, not the
# runner's: the binary kept here is one that may be put back and run.
STATE="${CAPITOLINE_UPDATE_STATE:-/var/lib/capitoline/update-cli}"
PREV_VERSION_FILE="$STATE/$cli.previous-version"
PREV_BINARY_FILE="$STATE/$cli.previous-binary"
PREV_BINARY="$WORK/previous-binary"
image_skip=0
KEY_NAME="update-${cli}-$$"
# A check that fails calls rollback(). This is for the script itself failing
# after the install and before the end, on something no check foresaw: the new
# version must not stay in place unchecked while the copy of the old one goes
# with $WORK (it did once, 2026-10-03). No smoke test here: the script is
# already going down, and what it leaves must be the version that was verified.
installed=0; finished=0
cleanup() {
  local rc=$?
  set +e
  if [[ "$installed" == 1 && "$finished" != 1 && $rc -ne 0 ]]; then
    echo "update-cli: stopped unexpectedly (exit $rc) after installing; putting $cli ${before:-the previous version} back." >&2
    if [[ -n "$pkg" ]]; then install_version "$before"
    elif [[ -f "$WORK/previous-binary" ]]; then install -o "$RUNNER" -g "$RUNNER" -m 0755 "$WORK/previous-binary" "$BIN"; fi
    echo "update-cli: $cli is $(version_of) again." >&2
  fi
  [[ -n "${KEY:-}" ]] && keys revoke "$KEY_NAME" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

as_runner() { (cd "$WORK" && sudo -u "$RUNNER" -H "$@"); }
version_of() { as_runner "$BIN" --version 2>/dev/null | grep -o -E '[0-9]+\.[0-9]+\.[0-9]+' | sed -n 1p; }
enabled_features() { as_runner "$BIN" features list 2>/dev/null | awk '$NF == "true" { print $1 }' | sort; }
keys() {
  # The usage database can be busy for a moment after a restart: retried.
  local out
  for _ in 1 2 3 4 5 6; do
    if out=$(sudo -u capitoline env CAPITOLINE_OVERLAY="$OVERLAY" npm run -s keys -- "$@" 2>&1); then printf '%s\n' "$out"; return 0; fi
    grep -q "database is locked" <<< "$out" || { printf '%s\n' "$out" >&2; return 1; }
    sleep 5
  done
  return 1
}

install_version() {  # $1: npm version, or "latest"
  if [[ -n "$pkg" ]]; then
    as_runner npm install -g --no-fund --no-audit --loglevel=error "$pkg@$1"
  else
    # The installer refuses to overwrite an installed binary ("delete the binary
    # first"), so the binary goes — its copy is in $WORK — and comes back if
    # the installer fails.
    rm -f "$BIN"
    if ! as_runner bash -c 'curl -fsSL https://antigravity.google/cli/install.sh | bash' > "$WORK/install.log" 2>&1 || [[ ! -x "$BIN" ]]; then
      cat "$WORK/install.log" >&2
      install -o "$RUNNER" -g "$RUNNER" -m 0755 "$WORK/previous-binary" "$BIN"
      echo "update-cli: the Antigravity installer failed; the previous binary is back" >&2
      return 1
    fi
  fi
}

smoke() {
  if [[ -z "${KEY:-}" ]]; then
    KEY=$(keys create "$KEY_NAME" | grep -o 'cap_[A-Za-z0-9_-]*' | sed -n 1p)
    [[ -n "$KEY" ]] || { echo "update-cli: could not create a temporary gateway key" >&2; return 1; }
  fi
  local image=0
  [[ -n "$image_model" && "$image_skip" != 1 ]] && image=1
  # Three images, not one: an agent that takes the right path one run in two
  # passes a single image half the time (Antigravity 1.2.16, 2026-10-03).
  CAPITOLINE_API_KEY="$KEY" SMOKE_IMAGE="$image" SMOKE_IMAGE_COUNT=3 SMOKE_IMAGE_MODEL="$image_model" bash scripts/smoke.sh "$BASE"
}

# Whether the image model's quota is used up, and until when if /health says.
image_quota_out() {
  node -e "
    fetch('$BASE/health').then((r) => r.json()).then((h) => {
      const m = (h.models || []).find((x) => x.name === '$image_model');
      if (m && m.available === false && m.reason === 'rate_limited') {
        const at = m.quota && m.quota.resetAt ? new Date(m.quota.resetAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '';
        console.log(at ? 'it reopens around ' + at : 'no reset time is known');
      }
    }).catch(() => {});" 2>/dev/null || true
}

rollback() {
  echo "update-cli: FAILED: $1. Putting $cli $before back." >&2
  if [[ -n "$pkg" ]]; then
    install_version "$before"
  else
    install -o "$RUNNER" -g "$RUNNER" -m 0755 "$PREV_BINARY" "$BIN"
  fi
  rm -f "$PREV_VERSION_FILE" "$PREV_BINARY_FILE"
  finished=1   # the previous version is back: nothing left for cleanup to restore
  echo "update-cli: $cli is $(version_of) again; smoke test of the restored version:" >&2
  smoke || echo "update-cli: the restored version fails the smoke test too: the fault is not the update" >&2
  exit 1
}

# The image check alone, for a version installed while the quota was used up.
if [[ "$target" == image ]]; then
  out=$(image_quota_out)
  if [[ -n "$out" ]]; then
    echo "update-cli: $image_model is still out of quota ($out). Nothing was checked; run this again later." >&2
    exit 3
  fi
  echo "update-cli: image check of $cli $(version_of)"
  rc=0; smoke || rc=$?
  if [[ "$rc" == 3 ]]; then
    echo "update-cli: the image quota ran out during the check. Nothing was verified; run this again later." >&2
    exit 3
  fi
  if [[ "$rc" == 0 ]]; then
    rm -f "$PREV_VERSION_FILE" "$PREV_BINARY_FILE"
    echo "update-cli: $cli $(version_of) draws an image. Add \"image verified $(date -u +%F)\" to its row in docs/update-clis.md."
    exit 0
  fi
  before=$(cat "$PREV_VERSION_FILE" 2>/dev/null || true)
  PREV_BINARY="$PREV_BINARY_FILE"
  if [[ -z "$before" || ( -z "$pkg" && ! -f "$PREV_BINARY" ) ]]; then
    echo "update-cli: the image check failed and no previous version was kept to put back (docs/update-clis.md, by hand)." >&2
    exit 1
  fi
  rollback "image check"
fi

if [[ -n "$image_model" ]]; then
  out=$(image_quota_out)
  if [[ -n "$out" ]]; then
    image_skip=1
    echo "update-cli: $image_model is out of quota ($out): updating without the image check." >&2
  fi
fi

before=$(version_of)
echo "update-cli: $cli $before installed"
if [[ -z "$pkg" ]]; then
  cp -p "$BIN" "$WORK/previous-binary"
fi
[[ "$cli" == codex ]] && enabled_features > "$WORK/features-before"

echo "update-cli: installing $cli ${target}"
install_version "$target"
after=$(version_of)
if [[ "$after" == "$before" ]]; then
  echo "update-cli: $cli is still $after; nothing to check, nothing changed."
  exit 0
fi
installed=1
echo "update-cli: $cli $before -> $after"

if [[ "$cli" == codex ]]; then
  enabled_features > "$WORK/features-after"
  # `features list` shows the CLI's defaults, not the -c overrides the gateway
  # passes, so a feature the configuration already switches off is not news.
  tr ',' '\n' <<< "$SWITCHED_OFF" | sort > "$WORK/switched-off"
  new=$(comm -13 "$WORK/features-before" "$WORK/features-after" | comm -23 - "$WORK/switched-off")
  if [[ -n "$new" ]]; then
    echo "update-cli: Codex $after enables features $before did not:" >&2
    sed 's/^/  /' <<< "$new" >&2
    echo "  Check each against providers.codex.args (docs/update-clis.md, the tool surface); switch off what is a tool, then update again." >&2
    rollback "new Codex features enabled"
  fi
fi

echo "update-cli: smoke test of $cli $after"
rc=0; smoke || rc=$?
if [[ "$rc" == 3 ]]; then
  # The quota was not known to be out before the update and ran out during the
  # check (the gateway learns of it from the refusal): the same case as a
  # quota known to be out, found later. The update stays, the image is owed.
  image_skip=1
  echo "update-cli: the image quota ran out during the check: keeping $cli $after, the image check is still owed." >&2
elif [[ "$rc" != 0 ]]; then
  rollback "smoke test"
fi

if [[ "$cli" == codex ]]; then
  # What the new version lets the model do, read from the stream rather than
  # asked of the model (scripts/codex-tool-probe.mjs says why).
  node scripts/codex-tool-probe.mjs || rollback "Codex acted on a request to run a command"
fi

if [[ "$cli" == antigravity ]]; then
  # Asked to run a command, agy must refuse it (1.2.8 and later end the run with
  # it in denied_actions) or stall until the timeout; the output of `id` is the
  # one thing that must never appear (docs/deploy.md §6.4).
  out=$(as_runner timeout 60 "$BIN" -p "run the command: id" --model "$PROBE_MODEL" --output-format json --print-timeout 30s < /dev/null 2>&1 || true)
  if grep -q 'uid=' <<< "$out"; then rollback "Antigravity ran a command it was asked to run"; fi
  echo "update-cli: antigravity $after did not run a command when asked to"
  # The switch that stops it updating itself (docs/deploy.md §6.3c), read from
  # its own log. It checks only when its timestamp is gone, so that goes first:
  # without it the check is skipped and proves nothing.
  agy_home="$(getent passwd "$RUNNER" | cut -d: -f6)/.gemini/antigravity-cli"
  rm -f "$agy_home/last_check.timestamp"
  as_runner "$BIN" -p "Reply with the single word: ok" --model "$PROBE_MODEL" --output-format json < /dev/null > /dev/null 2>&1 || true
  # sed, not head: head leaves at the first line, and with a few hundred logs
  # ls is still writing, takes a SIGPIPE, and pipefail turns that into the end
  # of this script (2026-10-03, at 472 logs, after the update was in place).
  newest=$(ls -t "$agy_home"/log/cli-*.log 2>/dev/null | sed -n 1p)
  if [[ -z "$newest" ]] || ! grep -q "Auto-update disabled via environment variable" "$newest"; then
    rollback "Antigravity no longer reports its self-update switched off (AGY_CLI_DISABLE_AUTO_UPDATE)"
  fi
  echo "update-cli: antigravity $after still has its self-update switched off"
fi

note="smoke test passed"
if [[ "$image_skip" == 1 ]]; then
  # Kept for the image check still owed, and for the rollback it may call for.
  install -d -o root -g root -m 0755 "$STATE"
  printf '%s\n' "$before" > "$PREV_VERSION_FILE"
  [[ -z "$pkg" ]] && install -o root -g root -m 0755 "$WORK/previous-binary" "$PREV_BINARY_FILE"
  note="smoke test passed, image not verified (quota used up)"
else
  rm -f "$PREV_VERSION_FILE" "$PREV_BINARY_FILE"
fi

finished=1

echo
echo "update-cli: $cli $after is in place and passed. Add to docs/update-clis.md, Versions in use:"
case "$cli" in
  claude)      name='Claude Code (`claude`)' ;;
  codex)       name='Codex CLI (`codex`)' ;;
  antigravity) name='Antigravity CLI (`agy`)' ;;
esac
echo "| $name | $after | $(date -u +%F) | updated from $before with scripts/update-cli.sh; $note |"
echo "set providers.$cli.version.verified to $after in config/capitoline.yaml (and, for claude or codex, the"
echo "npm install line of docs/deploy.md §4: a test keeps the three in step), and refresh the model lists"
echo "the tests read (docs/update-clis.md, \"The model lists\")."
