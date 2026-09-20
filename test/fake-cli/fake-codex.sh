#!/usr/bin/env bash
# Fake `codex`: ignores flags, replays a recorded fixture.
exec node "$(dirname "$0")/fake-cli.mjs" --mode replay --file "$(dirname "$0")/../fixtures/codex/exec-json-locked.jsonl"
