#!/usr/bin/env bash
# Real-CLI smoke test: one minimal call per provider. Run by hand after any CLI update.
set -euo pipefail
BASE="${1:-http://127.0.0.1:8080}"
CFG="${CAPITOLINE_CONFIG:-config/capitoline.yaml}"
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
HDR=()
if [[ -n "${CF_ACCESS_CLIENT_ID:-}" || -n "${CF_ACCESS_CLIENT_SECRET:-}" ]]; then
  [[ -n "${CF_ACCESS_CLIENT_ID:-}" && -n "${CF_ACCESS_CLIENT_SECRET:-}" ]] || { echo "smoke: set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET" >&2; exit 2; }
  HDR=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")
fi
# A key the gateway issued (docs/connecting-an-application.md §2a): the identity that works with
# no Access in front, and, through the tunnel, together with the headers above.
if [[ -n "${CAPITOLINE_API_KEY:-}" ]]; then
  HDR+=(-H "Authorization: Bearer $CAPITOLINE_API_KEY")
fi
# What this gateway serves, from /health, which needs no key: a host whose
# overlay narrows `serve` (docs/deploy.md §7) has fewer providers than the
# repository file declares. When /health cannot be read, every model is tried.
HEALTH=$(curl -sS ${HDR[@]+"${HDR[@]}"} "$BASE/health" 2>/dev/null || true)
SERVED=$(jq -r '.models[].name' <<<"$HEALTH" 2>/dev/null || true)
served() { [[ -z "$SERVED" ]] || grep -qxF "$1" <<<"$SERVED"; }
MODELS=$(yq -r '.providers[].health_model' "$CFG" 2>/dev/null || grep -E '^\s+health_model:' "$CFG" | awk '{print $2}' || true)
[[ -n "${MODELS// /}" ]] || { echo "smoke: no health_model found in $CFG" >&2; exit 1; }
fail=0
for m in $MODELS; do
  if ! served "$m"; then printf '%-22s %s\n' "$m" "skipped (not served by this gateway)"; continue; fi
  : > "$TMP"
  resp=$(curl -sS ${HDR[@]+"${HDR[@]}"} -o "$TMP" -w '%{http_code}' -H 'content-type: application/json' \
    -d "{\"model\":\"$m\",\"reasoning_effort\":\"low\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with the single word: ok\"}]}" \
    "$BASE/v1/chat/completions" || true)
  [[ -n "$resp" ]] || resp=000
  if [[ "$resp" == "200" ]]; then
    printf '%-22s %s  %-40s tokens=%s\n' "$m" "$resp" "$(jq -r '.choices[0].message.content' "$TMP" | head -c 40 | tr '\n' ' ')" "$(jq -r '.usage.total_tokens' "$TMP")"
  else
    printf '%-22s %s  %s\n' "$m" "$resp" "$(jq -r '.error.message // empty' "$TMP" 2>/dev/null)"; fail=1
  fi
done

# Image models: one real generation, which is also the only end-to-end check of
# the sudoers entry (docs/deploy.md §5) and of the helper installed in §7.1.
# Off by default, because it spends one unit of a quota that is 12 per 5 hours
# and 58 per week, and this script is meant to be run after every CLI update.
# Turn it on with SMOKE_IMAGE=1 when the image path is what you are checking.
# A 429 is reported and does not fail the run: an exhausted quota says nothing
# about whether an update broke the gateway, which is what this script is for.
# SMOKE_IMAGE_MODEL names the image model to try (scripts/update-cli.sh sets
# it to the updated CLI's own); otherwise the first one the configuration declares.
IMG="${SMOKE_IMAGE_MODEL:-}"
[[ -n "${IMG// /}" ]] || IMG=$(jq -r '[.models[] | select(.kind == "image") | .name][0] // empty' <<<"$HEALTH" 2>/dev/null || true)
[[ -n "${IMG// /}" ]] || IMG=$(yq -r '.providers[].models | to_entries[] | select(.value.kind == "image") | .key' "$CFG" 2>/dev/null | head -1 || true)
[[ -n "${IMG// /}" ]] || IMG=$(grep -E 'kind:[[:space:]]*image' "$CFG" | grep -vE '^[[:space:]]*#' | head -1 | awk -F: '{print $1}' | tr -d ' ' || true)
# A host that serves no image model has no image line at all.
[[ -n "${IMG// /}" ]] && ! served "$IMG" && IMG=""
MIN=$(yq -r '[.providers[].image.min_bytes] | map(select(. != null)) | .[0] // ""' "$CFG" 2>/dev/null || true)
[[ -n "${MIN// /}" ]] || MIN=$(grep -E '^[[:space:]]+min_bytes:' "$CFG" | head -1 | awk '{print $2}' || true)
[[ "$MIN" =~ ^[0-9]+$ ]] || MIN=0
if [[ -n "${IMG// /}" && "${SMOKE_IMAGE:-0}" != "1" ]]; then
  printf '%-22s %s\n' "$IMG" "skipped (SMOKE_IMAGE=1 to spend one image of the quota)"
elif [[ -n "${IMG// /}" ]]; then
  : > "$TMP"
  resp=$(curl -sS --max-time 300 ${HDR[@]+"${HDR[@]}"} -o "$TMP" -w '%{http_code}' -H 'content-type: application/json' \
    -d "{\"model\":\"$IMG\",\"prompt\":\"a red fox in the snow, 16:9\"}" \
    "$BASE/v1/images/generations" || true)
  [[ -n "$resp" ]] || resp=000
  bytes=$(jq -r '.capitoline.bytes // 0' "$TMP" 2>/dev/null || echo 0)
  [[ "$bytes" =~ ^[0-9]+$ ]] || bytes=0
  code=$(jq -r '.error.code // empty' "$TMP" 2>/dev/null || true)
  if [[ "$resp" == "200" && "$bytes" -gt "$MIN" ]]; then
    printf '%-22s %s  %-40s bytes=%s\n' "$IMG" "$resp" "$(jq -r '"\(.capitoline.mime) \(.capitoline.width)x\(.capitoline.height)"' "$TMP")" "$bytes"
  elif [[ "$resp" == "429" && "$code" == "rate_limited" ]]; then
    printf '%-22s %s  %s\n' "$IMG" "$resp" "image quota exhausted, not a regression$(jq -r 'if .capitoline.quota.resetAt then " (reopens \(.capitoline.quota.resetAt))" else "" end' "$TMP" 2>/dev/null || true)"
  else
    printf '%-22s %s  %s\n' "$IMG" "$resp" "$(jq -r '.error.message // empty' "$TMP" 2>/dev/null) [bytes=$bytes min_bytes=$MIN; see docs/deploy.md §7.1]"; fail=1
  fi
fi
exit $fail
