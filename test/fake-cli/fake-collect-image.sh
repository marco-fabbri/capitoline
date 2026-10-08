#!/usr/bin/env bash
# Fake `capitoline-collect-image <conversation-uuid>` for tests: same contract as the real helper
# (image bytes on stdout, exit 2 on a malformed id, exit 4 when the run produced no image) but
# reads committed fixtures instead of the runner's home. FAKE_COLLECT selects the outcome:
#   (unset)    prints test/fixtures/images/sample.jpg (1376x768 JPEG, > 250 KB)
#   tiny       prints test/fixtures/images/tiny.png (valid PNG far below min_bytes)
#   none       exit 4 with nothing on stdout (quota exhausted or the agent never called the tool)
#   image-run  as (unset), but only for the conversation id recorded in
#              fixtures/antigravity/image-subagent.jsonl; any other id exits 4. End-to-end runs use
#              this so that a dispatch falling back to the chat recording fails loudly instead
#              of being handed an image the run never produced.
#
# `codex <thread-uuid>` selects the Codex mode, as with the real helper: the
# recorded thread is the one in fixtures/codex/image-run.jsonl, and its image is
# fixtures/images/sample-codex.png (512x512 PNG, a downscaled real generation).
set -euo pipefail
provider=antigravity
if [[ "${1:-}" == "codex" ]]; then provider=codex; shift; fi
cid="${1:-}"
[[ "$cid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || { echo "bad conversation id" >&2; exit 2; }
fixtures="$(cd "$(dirname "$0")/../fixtures/images" && pwd)"
if [[ "$provider" == "codex" ]]; then
  recorded="01a0ccba-58c9-7980-9b15-63528791112c"; sample="$fixtures/sample-codex.png"
else
  recorded="e0405ad8-9fe1-45e8-9eea-b05629b4c775"; sample="$fixtures/sample.jpg"
fi
case "${FAKE_COLLECT:-sample}" in
  none) echo "no image produced" >&2; exit 4 ;;
  tiny) cat "$fixtures/tiny.png" ;;
  image-run)
    [[ "$cid" == "$recorded" ]] || { echo "no image produced for conversation $cid" >&2; exit 4; }
    cat "$sample" ;;
  # The image only under the subagent's conversation of fixtures/antigravity/image-subagent.jsonl.
  subagent)
    [[ "$cid" == "d42fca3a-f043-4234-a505-30dd1099c02a" ]] || { echo "no image produced for conversation $cid" >&2; exit 4; }
    cat "$sample" ;;
  # No image anywhere, and the subagent's conversation holds the refusal, as the real helper reports it.
  subagent-quota)
    if [[ "$cid" == "d42fca3a-f043-4234-a505-30dd1099c02a" ]]; then
      echo "no image produced; the conversation held: .system_generated/logs/transcript.jsonl ; quota: RESOURCE_EXHAUSTED Your quota will reset after 58h29m15s. gemini-3.1-flash-image" >&2
    else
      echo "no image produced; the conversation held: .system_generated/logs/transcript.jsonl" >&2
    fi
    exit 4 ;;
  *)    cat "$sample" ;;
esac
