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
# The request streams, as docs/deploy.md §9 tells every client to do through
# the tunnel: a deliberation sends nothing for the length of its silent
# stages, and Cloudflare's edge closes a connection that has sent nothing for
# 100 s with a 524 while the calls run on for nobody — which cost nine calls
# on 2026-09-27, when this script still asked without streaming. The raw
# stream is kept next to the result (<file>.sse) and the result itself is
# assembled from it in the shape a non-streaming answer has, so score.py and
# every reader of these files see one shape whichever way the answer came.
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

# The streamed chunks, assembled into one completion: the text is the
# concatenation of every delta, and the final chunk — the one with a
# finish_reason — carries the usage and the whole `capitoline` field, the
# deliberation included (src/server/openai.ts, sseChunk). Progress chunks
# carry an empty delta and a `capitoline` of their own, which is why only the
# last chunk's is kept.
assemble() {
  grep '^data: ' "$1" | grep -v '^data: \[DONE\]' | sed 's/^data: //' \
    | jq -s '{
        id: .[0].id, object: "chat.completion", created: .[0].created, model: .[0].model,
        choices: [{ index: 0, message: { role: "assistant", content: (map(.choices[0].delta.content // "") | add) }, finish_reason: (last.choices[0].finish_reason) }],
        usage: last.usage, capitoline: last.capitoline
      }'
}

for qid in $(jq -r '.questions[].id' "$QUESTIONS"); do
  question=$(jq -r --arg id "$qid" '.questions[] | select(.id == $id) | .question' "$QUESTIONS")
  for council in "$@"; do
    file="$OUT/${council}__${qid}.json"
    raw="$OUT/${council}__${qid}.sse"
    started=$(date +%s)
    code=$(jq -n --arg m "$council" --arg q "$question" '{model: $m, stream: true, messages: [{role: "user", content: $q}]}' \
      | curl -sS --no-buffer --max-time 1200 ${HDR[@]+"${HDR[@]}"} -o "$raw" -w '%{http_code}' \
          -H 'content-type: application/json' -d @- "$BASE/v1/chat/completions" || echo 000)
    seconds=$(( $(date +%s) - started ))
    if [[ "$code" == "200" ]] && grep -q '^data: \[DONE\]' "$raw"; then
      assemble "$raw" > "$file"
      jq -r --arg c "$council" --arg q "$qid" --arg s "$seconds" \
        '"\($c)  \($q)  \($s)s  calls=\(.capitoline.council.calls)  tokens=\(.usage.total_tokens)  judge=\(.capitoline.council.judge.model)"' "$file" \
        | tee -a "$OUT/run.log"
    else
      # An error answer is a JSON body, not a stream: kept as it came, under
      # the result's own name, so run.log and the file agree on what happened.
      cp "$raw" "$file"
      printf '%s  %s  %ss  HTTP %s  %s\n' "$council" "$qid" "$seconds" "$code" "$(jq -r '.error.message // empty' "$file" 2>/dev/null)" \
        | tee -a "$OUT/run.log"
    fi
  done
done
