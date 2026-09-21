#!/usr/bin/env bash
# Fake `agy`: ignores flags and replays a recorded fixture. The real CLI serves
# text and images from the same binary and decides what to do from the prompt,
# so the fixture is chosen the same way: a prompt asking for the generate_image
# tool replays the recorded image run (tool steps and all), anything else the
# ordinary chat stream. stdin is read here and handed back to the replayer,
# which expects to consume it before printing.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
stdin="$(cat)"
case "$stdin" in
  *generate_image*) fixture="$dir/../fixtures/antigravity/image-run.jsonl" ;;
  *)                fixture="$dir/../fixtures/antigravity/stream-json.jsonl" ;;
esac
exec node "$dir/fake-cli.mjs" --mode replay --file "$fixture" <<<"$stdin"
