#!/usr/bin/env bash
# Updates one CLI on the host, checks it, and puts the previous version back if
# a check fails. Run as root from the clone (docs/update-clis.md, "Procedure").
#
#   scripts/update-cli.sh <claude|codex|antigravity|agy> [version]
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
#    smoke test, with one image from this CLI's own image model if it has one,
#    through a temporary gateway key created and revoked here; then, for Codex,
#    a request to run a command must produce no step (codex-tool-probe.mjs);
#    for Antigravity, the same request must not run (docs/deploy.md §6.4), and
#    the CLI must still honour the switch that stops it updating itself (§6.3c).
# 4. On any failure: the previous version back, and the smoke test again.
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
[[ -z "$pkg" && "$target" != "latest" ]] && { echo "update-cli: the Antigravity installer only installs the latest version" >&2; exit 2; }

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
KEY_NAME="update-${cli}-$$"
cleanup() {
  [[ -n "${KEY:-}" ]] && keys revoke "$KEY_NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

as_runner() { (cd "$WORK" && sudo -u "$RUNNER" -H "$@"); }
version_of() { as_runner "$BIN" --version 2>/dev/null | grep -o -E '[0-9]+\.[0-9]+\.[0-9]+' | head -1; }
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
    KEY=$(keys create "$KEY_NAME" | grep -o 'cap_[A-Za-z0-9_-]*' | head -1)
    [[ -n "$KEY" ]] || { echo "update-cli: could not create a temporary gateway key" >&2; return 1; }
  fi
  local image=0
  [[ -n "$image_model" ]] && image=1
  CAPITOLINE_API_KEY="$KEY" SMOKE_IMAGE="$image" SMOKE_IMAGE_MODEL="$image_model" bash scripts/smoke.sh "$BASE"
}

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
echo "update-cli: $cli $before -> $after"

rollback() {
  echo "update-cli: FAILED: $1. Putting $cli $before back." >&2
  if [[ -n "$pkg" ]]; then
    install_version "$before"
  else
    install -o "$RUNNER" -g "$RUNNER" -m 0755 "$WORK/previous-binary" "$BIN"
  fi
  echo "update-cli: $cli is $(version_of) again; smoke test of the restored version:" >&2
  smoke || echo "update-cli: the restored version fails the smoke test too: the fault is not the update" >&2
  exit 1
}

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
smoke || rollback "smoke test"

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
  newest=$(ls -t "$agy_home"/log/cli-*.log 2>/dev/null | head -1)
  if [[ -z "$newest" ]] || ! grep -q "Auto-update disabled via environment variable" "$newest"; then
    rollback "Antigravity no longer reports its self-update switched off (AGY_CLI_DISABLE_AUTO_UPDATE)"
  fi
  echo "update-cli: antigravity $after still has its self-update switched off"
fi

echo
echo "update-cli: $cli $after is in place and passed. Add to docs/update-clis.md, Versions in use:"
case "$cli" in
  claude)      name='Claude Code (`claude`)' ;;
  codex)       name='Codex CLI (`codex`)' ;;
  antigravity) name='Antigravity CLI (`agy`)' ;;
esac
echo "| $name | $after | $(date -u +%F) | updated from $before with scripts/update-cli.sh; smoke test passed |"
echo "set providers.$cli.version.verified to $after in config/capitoline.yaml (and, for claude or codex, the"
echo "npm install line of docs/deploy.md §4: a test keeps the three in step), and refresh the model lists"
echo "the tests read (docs/update-clis.md, \"The model lists\")."
