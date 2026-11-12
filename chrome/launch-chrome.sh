#!/usr/bin/env bash
# Open the Chrome the DeepSeek Harness drives.
#
# There is only one Chrome and it is a stock browser: the profile lives at
# ~/.config/google-chrome, there is no debugging port, and the Playwright
# extension relays DevTools traffic. Running the icon, `google-chrome` in a
# shell, or this script all end up in the same browser.
set -euo pipefail

export DISPLAY="${DISPLAY:-:1}"

if pgrep -x chrome >/dev/null 2>&1; then
  echo "Chrome is already running."
  exit 0
fi

setsid nohup /usr/bin/google-chrome --profile-directory=Default --no-first-run \
  >"${CHROME_CDP_LOG:-/tmp/chrome.log}" 2>&1 </dev/null &
echo "Chrome starting…"
