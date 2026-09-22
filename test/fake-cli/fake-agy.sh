#!/usr/bin/env bash
# Fake `agy`: ignores flags and replays a recorded fixture. The real CLI serves
# text and images from the same binary and decides what to do from the prompt,
# so the fixture is chosen the same way: the image prompt built by
# src/providers/antigravity.ts (IMAGE_PROMPT) replays the recorded image run
# (tool steps and all), anything else the ordinary chat stream. The selector is
# the distinctive phrase of that prompt rather than the bare tool name, so a
# chat prompt that happens to mention generate_image is still served the chat
# recording. stdin is read here and handed back to the replayer, which expects
# to consume it before printing.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
stdin="$(cat)"
# The council's ranking stage is chosen the same way (see fake-claude.sh): this
# CLI seats two of the four members, so its ranking recording is asked for
# twice per deliberation, and it wraps the array in an object, the third shape
# parseRanking tolerates. It is never asked to synthesize: the judge's chain is
# Anthropic-only.
case "$stdin" in
  *"generate_image tool exactly once"*) fixture="$dir/../fixtures/antigravity/image-run.jsonl" ;;
  *"Reply with JSON only"*)             fixture="$dir/../fixtures/antigravity/council-ranking.jsonl" ;;
  *)                                    fixture="$dir/../fixtures/antigravity/stream-json.jsonl" ;;
esac
exec node "$dir/fake-cli.mjs" --mode replay --file "$fixture" <<<"$stdin"
