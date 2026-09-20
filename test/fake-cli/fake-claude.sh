#!/usr/bin/env bash
# Fake `claude`: ignores flags, replays a recorded fixture.
exec node "$(dirname "$0")/fake-cli.mjs" --mode replay --file "$(dirname "$0")/../fixtures/claude/stream-json-locked.jsonl"
