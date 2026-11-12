#!/usr/bin/env bash
# Seed the agent's Chrome profile from the everyday Chrome profile.
#
# Chrome >= 136 refuses --remote-debugging-port against the default
# user-data-dir, so the agent needs its own directory. Copying the profile
# (cookies, passwords, extensions) once carries the logged-in session over.
# Close Chrome before running this.
set -euo pipefail

SOURCE="${CHROME_SOURCE_PROFILE:-$HOME/.config/google-chrome}"
TARGET="${CHROME_CDP_PROFILE_DIR:-$HOME/.dsh/chrome-profile}"

if pgrep -x chrome >/dev/null 2>&1; then
  echo "Close Chrome first: the profile cannot be copied while it is running." >&2
  exit 1
fi

mkdir -p "${TARGET}"
rsync -a \
  --exclude='Service Worker/' --exclude='IndexedDB/' --exclude='Shared Dictionary/' \
  --exclude='Cache/' --exclude='Code Cache/' --exclude='GPUCache/' --exclude='ShaderCache/' \
  --exclude='component_crx_cache/' --exclude='extensions_crx_cache/' --exclude='screen_ai/' \
  --exclude='optimization_guide_model_store/' --exclude='CertificateRevocation/' \
  --exclude='WasmTtsEngine/' --exclude='Safe Browsing/' --exclude='GPUPersistentCache/' \
  --exclude='GrShaderCache/' --exclude='OnDeviceHeadSuggestModel/' --exclude='Crash Reports/' \
  "${SOURCE}/" "${TARGET}/"

rm -f "${TARGET}/SingletonLock" "${TARGET}/SingletonSocket" "${TARGET}/SingletonCookie"
rm -rf "${TARGET}"/.com.google.Chrome.*

echo "Seeded ${TARGET} from ${SOURCE}"
du -sh "${TARGET}"
