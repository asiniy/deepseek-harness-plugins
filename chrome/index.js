/**
 * Per-session browser control for the DeepSeek Harness.
 *
 * Every agent gets its own Playwright MCP server, its own relay connection to
 * the browser extension, its own Chrome tab and therefore its own tab group in
 * the user's tab strip. The session's tab closes when the turn ends, and the
 * server goes away with the agent.
 *
 * The package also carries the browser setup scripts (launch-chrome.sh,
 * seed-profile.sh, install-playwright-mcp.sh) and the optional companion
 * extension that recolours the tab group.
 *
 * @module @local/chrome
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BrowserSession } from './lib/session.js'

/** Cordis plugin name, used in loader diagnostics. */
export const name = 'chrome'

/** Services this plugin needs: the tool registry and the agent registry. */
export const inject = ['tools', 'agents']

/** Where the browser setup installs the MCP server. */
const DEFAULT_SERVER_DIR = join(homedir(), '.local', 'share', 'dsh-playwright-mcp')

/**
 * Read the harness-home environment layer.
 * @param {string} home - the harness home directory.
 * @returns {Record<string, string>} the variables it holds.
 */
function readEnvLayer(home) {
  const values = {}
  try {
    const text = readFileSync(join(home, '.env'), 'utf8')
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
      if (match !== null) values[match[1]] = match[2].trim().replace(/^["']|["']$/g, '')
    }
  } catch {
    // No env layer: the extension transport will not have its token.
  }
  return values
}

/**
 * Register the browser tools for every agent the Host creates.
 * @param {object} ctx - the plugin context.
 * @param {object} config - the row configuration.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const envLayer = readEnvLayer(home)
  const serverDir = config.serverDir ?? DEFAULT_SERVER_DIR
  const serverArgs = config.serverArgs ?? [
    join(serverDir, 'cli.js'),
    '--extension',
    '--timeout-action', '15000',
    '--timeout-navigation', '60000',
    '--output-dir', join(serverDir, 'artifacts'),
    '--output-max-size', String(50 * 1024 * 1024),
  ]
  const allowedOrigins = Array.isArray(config.allowedOrigins) ? config.allowedOrigins : []
  const serverName = config.serverName ?? 'playwright'

  /** @type {Map<string, BrowserSession>} */
  const sessions = new Map()

  /**
   * Start the browser session of one agent.
   * @param {object} agent - the agent.
   * @returns {BrowserSession | undefined} the session, when it was started.
   */
  function startSession(agent) {
    if (agent === undefined || agent === null) return undefined
    const id = String(agent.id ?? `agent-${sessions.size}`)
    if (sessions.has(id)) return sessions.get(id)
    // Only top-level sessions get a browser unless the deployment asks for
    // more: every session costs one MCP server and one tab group.
    if (config.includeSubagents !== true) {
      const roots = ctx.agents.roots()
      if (roots.length > 0 && !roots.some((root) => String(root.id) === id)) return undefined
    }
    const session = new BrowserSession({
      agent,
      settings: {
        serverCommand: config.serverCommand ?? 'node',
        serverArgs,
        serverEnv: {
          ...(envLayer.PLAYWRIGHT_MCP_EXTENSION_TOKEN === undefined
            ? {}
            : { PLAYWRIGHT_MCP_EXTENSION_TOKEN: envLayer.PLAYWRIGHT_MCP_EXTENSION_TOKEN }),
        },
        cwd: config.cwd ?? home,
        allowedOrigins,
        serverName,
        toolCallTimeoutMs: config.toolCallTimeoutMs ?? 120_000,
        // The extension titles the group "Playwright · <client name>", so the
        // default is unique per session; the model can rename it.
        defaultClientName: `dsh-${id}`,
      },
      logger: ctx.logger,
    })
    sessions.set(id, session)
    session.start().catch((error) => {
      ctx.logger.error(`chrome: the browser session for ${id} failed to start: ${error?.message ?? error}`)
    })
    return session
  }

  ctx.on('agent/created', (agent) => {
    startSession(agent)
  })

  // Sessions that already exist (a restart, a plugin reload) get theirs too.
  for (const agent of ctx.agents.list()) startSession(agent)

  ctx.on('agent/disposed', (agent) => {
    const id = String(agent?.id ?? '')
    const session = sessions.get(id)
    if (session === undefined) return
    sessions.delete(id)
    void session.dispose()
  })

  ctx.effect(() => () => {
    for (const session of sessions.values()) void session.dispose()
    sessions.clear()
  })
}
