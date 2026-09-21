#!/usr/bin/env bash
# Fake `capitoline-collect-image <conversation-uuid>` for tests: same contract as the real helper
# (image bytes on stdout, exit 2 on a malformed id, exit 4 when the run produced no image) but
# reads committed fixtures instead of the runner's home. FAKE_COLLECT selects the outcome:
#   (unset)  prints test/fixtures/images/sample.jpg (1376x768 JPEG, > 250 KB)
#   tiny     prints test/fixtures/images/tiny.png (valid PNG far below min_bytes)
#   none     exit 4 with nothing on stdout (quota exhausted or the agent never called the tool)
set -euo pipefail
cid="${1:-}"
[[ "$cid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || { echo "bad conversation id" >&2; exit 2; }
fixtures="$(cd "$(dirname "$0")/../fixtures/images" && pwd)"
case "${FAKE_COLLECT:-sample}" in
  none) echo "no image produced" >&2; exit 4 ;;
  tiny) cat "$fixtures/tiny.png" ;;
  *)    cat "$fixtures/sample.jpg" ;;
esac
