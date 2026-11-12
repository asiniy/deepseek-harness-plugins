#!/usr/bin/env bash
# Run the headless checks of every plugin in this repository.
#
# The live check of composer-code is not part of this: it needs a running
# `dsh web` and the Chrome instance the harness drives (127.0.0.1:9222).
# Run it yourself with:
#
#     node composer-code/test-live.mjs
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for test in \
  "$ROOT/composer-code/test-scan.mjs" \
  "$ROOT/session-unread/test-client.mjs" \
  "$ROOT/turn-sound/test-client.mjs" \
  "$ROOT/chrome/test-all.mjs"
do
  echo "== $(basename "$(dirname "$test")")/$(basename "$test")"
  node "$test"
  echo
done
