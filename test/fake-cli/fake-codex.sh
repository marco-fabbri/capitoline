#!/usr/bin/env bash
# Fake `codex`: ignores flags and replays a recorded fixture, chosen from the
# prompt on stdin (see fake-claude.sh for why). All three stages are here: the
# ladder's judge chain opens on codex-gpt-6-astra, so this CLI does synthesize.
# Its ranking comes back inside a ```json fence, which is one of the three
# shapes parseRanking tolerates and the one Codex actually favours.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
# The model listing is a command, not a prompt: answered from argv, before
# stdin is read, with a trimmed capture of the real `codex debug models`.
if [[ "${1:-}" == debug && "${2:-}" == models ]]; then exec cat "$dir/../fixtures/codex/debug-models.json"; fi
stdin="$(cat)"
case "$stdin" in
  # The image run: a real capture (2026-09-23) of Codex's built-in image
  # generation, whose thread id the fake collect helper recognises.
  *"Use the image generation tool exactly once"*) fixture="$dir/../fixtures/codex/image-run.jsonl" ;;
  *"Reply with JSON only"*)             fixture="$dir/../fixtures/codex/council-ranking.jsonl" ;;
  *"You are writing the final answer"*) fixture="$dir/../fixtures/codex/council-synthesis.jsonl" ;;
  *)                                    fixture="$dir/../fixtures/codex/exec-json-locked.jsonl" ;;
esac
exec node "$dir/fake-cli.mjs" --mode replay --file "$fixture" <<<"$stdin"
