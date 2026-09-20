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
MODELS=$(yq -r '.providers[].health_model' "$CFG" 2>/dev/null || grep -E '^\s+health_model:' "$CFG" | awk '{print $2}' || true)
[[ -n "${MODELS// /}" ]] || { echo "smoke: no health_model found in $CFG" >&2; exit 1; }
fail=0
for m in $MODELS; do
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
exit $fail
