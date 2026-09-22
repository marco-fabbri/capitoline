#!/usr/bin/env bash
# Fake `codex`: ignores flags and replays a recorded fixture, chosen from the
# prompt on stdin (see fake-claude.sh for why). Only the ranking stage is here:
# the judge's chain is Anthropic-only, so this CLI is never asked to
# synthesize. Its ranking comes back inside a ```json fence, which is one of
# the three shapes parseRanking tolerates and the one Codex actually favours.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
stdin="$(cat)"
case "$stdin" in
  *"Reply with JSON only"*) fixture="$dir/../fixtures/codex/council-ranking.jsonl" ;;
  *)                        fixture="$dir/../fixtures/codex/exec-json-locked.jsonl" ;;
esac
exec node "$dir/fake-cli.mjs" --mode replay --file "$fixture" <<<"$stdin"
