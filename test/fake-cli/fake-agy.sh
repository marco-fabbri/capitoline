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
# CLI seats two of the four members of the panels and all three rungs of the
# Gemini ladder (docs/measure-a-model.md), and it wraps the array in an
# object, the third shape parseRanking tolerates. It is never asked to synthesize: every judge chain
# reaches an Anthropic model first.
#
# Two ranking recordings, because parseRanking refuses a ballot that names a
# label it was not shown and one that leaves a shown label out: a four-seat
# panel is ranked over Response A..D, the three-rung ladder over A..C. The
# presence of "Response D" in the prompt is what tells them apart — the prompt
# lists exactly the labels on the table — so a ladder deliberation produces
# three parsed ballots instead of three silent parse failures, and a rung lost
# in stage 2 shows up as a missing ranking rather than as nothing at all.
case "$stdin" in
  *"generate_image tool exactly once"*) fixture="$dir/../fixtures/antigravity/image-run.jsonl" ;;
  *"Reply with JSON only"*)
    case "$stdin" in
      *"Response D"*) fixture="$dir/../fixtures/antigravity/council-ranking.jsonl" ;;
      *)              fixture="$dir/../fixtures/antigravity/council-ranking-3.jsonl" ;;
    esac ;;
  *)                                    fixture="$dir/../fixtures/antigravity/stream-json.jsonl" ;;
esac
exec node "$dir/fake-cli.mjs" --mode replay --file "$fixture" <<<"$stdin"
