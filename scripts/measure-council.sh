#!/usr/bin/env bash
# Runs a set of questions through one or more councils and keeps every full
# response, which is the evidence a measurement's table rests on.
#
#   scripts/measure-council.sh <base-url> <questions.json> <out-dir> <council>...
#
# Question-major on purpose: every council answers one question before the
# next question starts, so councils compared on the same question are seated
# within minutes of each other and meet the same quota state. Across a
# longer gap a model can run out of quota and a seat step down between two
# runs that are meant to differ only in their shape.
#
# Each run's one-line summary, wall time included, is also appended to
# run.log in the output directory: the response itself does not carry the
# time, and a measurement's reading counts it.
#
# The Cloudflare Access headers come from the same variables smoke.sh reads.
set -euo pipefail
[[ $# -ge 4 ]] || { echo "usage: $0 <base-url> <questions.json> <out-dir> <council>..." >&2; exit 2; }
BASE="$1"; QUESTIONS="$2"; OUT="$3"; shift 3
mkdir -p "$OUT"
HDR=()
if [[ -n "${CF_ACCESS_CLIENT_ID:-}" ]]; then
  HDR=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET:?set both}")
fi
# Which real model each Claude alias resolved to at the start of the run:
# the gateway names aliases, and a measurement read months later has to know
# which Opus it was taken against (docs/deploy.md §9).
curl -sS ${HDR[@]+"${HDR[@]}"} "$BASE/v1/usage" | jq '.models' > "$OUT/model-identities-$(date -u +%Y%m%dT%H%M%SZ).json"

for qid in $(jq -r '.questions[].id' "$QUESTIONS"); do
  question=$(jq -r --arg id "$qid" '.questions[] | select(.id == $id) | .question' "$QUESTIONS")
  for council in "$@"; do
    file="$OUT/${council}__${qid}.json"
    started=$(date +%s)
    code=$(jq -n --arg m "$council" --arg q "$question" '{model: $m, messages: [{role: "user", content: $q}]}' \
      | curl -sS --max-time 1200 ${HDR[@]+"${HDR[@]}"} -o "$file" -w '%{http_code}' \
          -H 'content-type: application/json' -d @- "$BASE/v1/chat/completions" || echo 000)
    seconds=$(( $(date +%s) - started ))
    if [[ "$code" == "200" ]]; then
      jq -r --arg c "$council" --arg q "$qid" --arg s "$seconds" \
        '"\($c)  \($q)  \($s)s  calls=\(.capitoline.council.calls)  tokens=\(.usage.total_tokens)  judge=\(.capitoline.council.judge.model)"' "$file" \
        | tee -a "$OUT/run.log"
    else
      printf '%s  %s  %ss  HTTP %s  %s\n' "$council" "$qid" "$seconds" "$code" "$(jq -r '.error.message // empty' "$file" 2>/dev/null)" \
        | tee -a "$OUT/run.log"
    fi
  done
done
