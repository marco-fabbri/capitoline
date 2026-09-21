#!/usr/bin/env bash
# Fake `capitoline-collect-image <conversation-uuid>` for tests: same contract as the real helper
# (image bytes on stdout, exit 2 on a malformed id, exit 4 when the run produced no image) but
# reads committed fixtures instead of the runner's home. FAKE_COLLECT selects the outcome:
#   (unset)    prints test/fixtures/images/sample.jpg (1376x768 JPEG, > 250 KB)
#   tiny       prints test/fixtures/images/tiny.png (valid PNG far below min_bytes)
#   none       exit 4 with nothing on stdout (quota exhausted or the agent never called the tool)
#   image-run  as (unset), but only for the conversation id recorded in
#              fixtures/antigravity/image-run.jsonl; any other id exits 4. End-to-end runs use
#              this so that a dispatch falling back to the chat recording fails loudly instead
#              of being handed an image the run never produced.
set -euo pipefail
cid="${1:-}"
[[ "$cid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || { echo "bad conversation id" >&2; exit 2; }
fixtures="$(cd "$(dirname "$0")/../fixtures/images" && pwd)"
recorded="40fc0b5c-042f-453a-9eaf-6162913de55e"
case "${FAKE_COLLECT:-sample}" in
  none) echo "no image produced" >&2; exit 4 ;;
  tiny) cat "$fixtures/tiny.png" ;;
  image-run)
    [[ "$cid" == "$recorded" ]] || { echo "no image produced for conversation $cid" >&2; exit 4; }
    cat "$fixtures/sample.jpg" ;;
  *)    cat "$fixtures/sample.jpg" ;;
esac
