#!/usr/bin/env bash
# Install @playwright/mcp without the npm registry.
#
# The corporate proxy (Cato) blocks registry.npmjs.org and the mirrors, but
# allows cdn.jsdelivr.net, unpkg.com and github.com. The published package is
# tiny — a four-line wrapper around `playwright-core/lib/coreBundle` — and a
# matching `playwright-core` already ships with the Codex runtime on this
# machine, so the whole thing can be assembled offline.
#
#   ./install-playwright-mcp.sh            # install
#   ./install-playwright-mcp.sh --check    # report what is in place
set -euo pipefail

VERSION="${PLAYWRIGHT_MCP_VERSION:-0.0.85}"
DEST="${PLAYWRIGHT_MCP_DIR:-$HOME/.local/share/dsh-playwright-mcp}"
CDN="https://cdn.jsdelivr.net/npm/@playwright/mcp@${VERSION}"
FILES=(cli.js index.js index.d.ts config.d.ts package.json README.md LICENSE)

# Prefer the newest playwright-core that exposes the MCP server (coreBundle).
find_playwright_core() {
  local candidates=(
    "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core"
    "$HOME/.vscode/extensions/kilocode.kilo-code-7.8.27-linux-x64/dist/node_modules/playwright-core"
  )
  for candidate in "${candidates[@]}"; do
    if [[ -f "$candidate/lib/coreBundle.js" ]] && \
       node -e "const {tools}=require('$candidate/lib/coreBundle.js');process.exit(typeof tools.decorateMCPCommand==='function'?0:1)" 2>/dev/null; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

if [[ "${1:-}" == "--check" ]]; then
  echo "install dir:   $DEST"
  echo "package:       $([[ -f "$DEST/package.json" ]] && node -p "require('$DEST/package.json').version" || echo '(not installed)')"
  echo "playwright-core: $(readlink "$DEST/node_modules/playwright-core" 2>/dev/null || echo '(missing)')"
  exit 0
fi

CORE="$(find_playwright_core)" || {
  echo "No local playwright-core with the MCP server was found." >&2
  exit 1
}
echo "using playwright-core: $CORE"

mkdir -p "$DEST/node_modules"
for file in "${FILES[@]}"; do
  curl -sf --max-time 30 "$CDN/$file" -o "$DEST/$file" || {
    echo "failed to download $file" >&2
    exit 1
  }
done
ln -sfn "$CORE" "$DEST/node_modules/playwright-core"
# The 'playwright' wrapper package is not needed for --cdp-endpoint, but link the
# local one so any lazy require still resolves.
if [[ -d "${CORE%/playwright-core}/playwright" ]]; then
  ln -sfn "${CORE%/playwright-core}/playwright" "$DEST/node_modules/playwright"
fi

# The navigation gate (this directory's gate.mjs) fronts the MCP server and
# enforces the origin allowlist on navigation only.
cp "${BASH_SOURCE[0]%/*}/gate.mjs" "$DEST/gate.mjs"

# The gate speaks MCP through the client SDK; link it from the same store the
# harness uses.
MCP_STORE="$(dirname "$(dirname "$(command -v dsh)")")/node_modules"
if [[ -d "$MCP_STORE/@modelcontextprotocol" ]]; then
  mkdir -p "$DEST/node_modules/@modelcontextprotocol"
  ln -sfn "$MCP_STORE/@modelcontextprotocol/client" "$DEST/node_modules/@modelcontextprotocol/client"
  ln -sfn "$MCP_STORE/@modelcontextprotocol/core" "$DEST/node_modules/@modelcontextprotocol/core"
fi

echo "installed @playwright/mcp@$VERSION in $DEST"
node "$DEST/cli.js" --help 2>&1 | head -12
