#!/usr/bin/env bash
# Fake `claude`: ignores flags and replays a recorded fixture, chosen from the
# prompt it is handed on stdin exactly as fake-agy.sh chooses between chat and
# image. One binary serves all three council stages and only the text tells
# them apart: stage 2 has to come back as JSON or every ranking would fail to
# parse, and the judge's synthesis has to be distinguishable from the members'
# answers. The selectors are phrases of the production prompts
# (src/council/prompts.ts), and test/e2e.test.ts feeds those very prompts
# through here, so rewording one breaks that test instead of silently sending a
# stage back to the chat recording.
#
# The council fixtures are the chat recording with the answer text swapped and
# nothing else, so what each adapter parses is still the envelope the real CLI
# produced. This one answers the ranking as a bare JSON array.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
stdin="$(cat)"
case "$stdin" in
  *"Reply with JSON only"*)            fixture="$dir/../fixtures/claude/council-ranking.jsonl" ;;
  *"You are writing the final answer"*) fixture="$dir/../fixtures/claude/council-synthesis.jsonl" ;;
  *)                                   fixture="$dir/../fixtures/claude/stream-json-locked.jsonl" ;;
esac
exec node "$dir/fake-cli.mjs" --mode replay --file "$fixture" <<<"$stdin"
