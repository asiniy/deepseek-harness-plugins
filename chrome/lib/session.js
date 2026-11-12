/**
 * One browser session per harness agent.
 *
 * Each session owns its own MCP server process, its own relay connection to
 * the browser extension, its own Chrome tab and therefore its own tab group in
 * the user's tab strip. The session closes its tab when the turn ends and
 * tears the server down when the agent is disposed.
 *
 * @module @local/chrome/session
 */

import { McpStdioClient } from './mcp-client.js'
import { createToolDefinition } from './bridge.js'

/**
 * @param {string} url - the URL the agent wants to open.
 * @param {string[]} allowedOrigins - the allowed origins; empty allows all.
 * @returns {string | undefined} a refusal message, or undefined when allowed.
 */
export function checkOrigin(url, allowedOrigins) {
  if (allowedOrigins.length === 0) return undefined
  let origin
  try {
    origin = new URL(url).origin
  } catch {
    return `Navigation refused: "${url}" is not a valid URL.`
  }
  if (origin === '' || origin === 'null') return undefined
  if (allowedOrigins.includes(origin)) return undefined
  return `Navigation refused: origin ${origin} is not allowed. Allowed origins: ${allowedOrigins.join(', ')}`
}

/**
 * A browser session bound to one agent.
 */
export class BrowserSession {
  /**
   * @param {object} options - session options.
   * @param {object} options.agent - the agent this session serves.
   * @param {object} options.settings - the plugin settings.
   * @param {{ warn: Function, error: Function, info: Function }} [options.logger] - logger.
   */
  constructor({ agent, settings, logger }) {
    this.agent = agent
    this.settings = settings
    this.logger = logger ?? { warn() {}, error() {}, info() {} }
    this.client = null
    this.label = ''
    this.mark = 'none'
    this.ownsTab = false
    /** The URL of the tab this session owns; only such a tab is ever closed. */
    this.agentTabUrl = ''
    this.lastActivity = Date.now()
    this.disposed = false
    /** @type {Array<() => void>} */
    this.disposers = []
  }

  /**
   * Start the MCP server and register the browser tools in the agent's scope.
   * @returns {Promise<void>} resolves once the tools are registered.
   */
  async start() {
    try {
      await this.#start()
    } catch (error) {
      await this.dispose()
      throw error
    }
  }

  /**
   * Connect the server and register the tools.
   * @returns {Promise<void>} resolves once the tools are registered.
   */
  async #start() {
    await this.#connect()
    const tools = await this.client.listTools()
    const scope = this.agent.ctx
    for (const tool of tools) {
      const definition = createToolDefinition({
        tool,
        call: (name, args) => this.call(name, args),
        ctx: scope,
        serverName: this.settings.serverName,
        beforeCall: (args) => this.#beforeCall(tool.name, args),
      })
      this.disposers.push(scope.tools.register(definition))
    }
    // Session-only tools: the name the tab group carries, and the mark that
    // keeps a tab open across turns.
    this.disposers.push(scope.tools.register(this.#nameSessionTool()))
    this.disposers.push(scope.tools.register(this.#markTabTool()))
    // The agent's tab belongs to this session: close it when the turn ends.
    this.disposers.push(scope.on('session/event', (_session, event) => {
      if (event?.type === 'turn/end') void this.closeTab()
    }))
    await this.ensureOwnTab()
  }

  /**
   * Call one MCP tool, keeping the activity clock fresh.
   * @param {string} name - the tool name.
   * @param {object} args - the arguments.
   * @returns {Promise<object>} the MCP result.
   */
  async call(name, args) {
    this.lastActivity = Date.now()
    const result = await this.client.callTool(name, args)
    if (name === 'browser_navigate' && typeof args.url === 'string') {
      this.agentTabUrl = args.url
    }
    return result
  }

  /**
   * Find the index of the tab this session owns.
   *
   * The tab is identified by its URL, never by position: indices shift when
   * other tabs open, and the MCP server's own "current page" may be a tab the
   * user opened.
   * @returns {Promise<number | null>} the index, or null when the tab is gone.
   */
  async #findAgentTabIndex() {
    if (this.agentTabUrl === '') return null
    const result = await this.call('browser_tabs', { action: 'list' })
    const text = (result?.content ?? []).map((part) => part.text ?? '').join('')
    const lines = text.split('\n').filter((line) => line.startsWith('- '))
    for (const line of lines) {
      const index = Number(line.match(/^- (\d+):/)?.[1] ?? Number.NaN)
      const url = line.match(/\]\(([^)]*)\)/)?.[1]
      if (Number.isInteger(index) && url === this.agentTabUrl) return index
    }
    return null
  }

  /**
   * Make sure the session works in a tab of its own.
   *
   * The MCP server adopts an arbitrary existing page when it connects, so the
   * session opens a tab and selects it explicitly.
   * @returns {Promise<void>} resolves once the tab exists.
   */
  async ensureOwnTab() {
    if (this.ownsTab) return
    await this.call('browser_tabs', { action: 'new' })
    const result = await this.call('browser_tabs', { action: 'list' })
    const text = (result?.content ?? []).map((part) => part.text ?? '').join('')
    const index = Number(text.match(/^- (\d+): \(current\) \[\]\(about:blank\)/m)?.[1] ?? Number.NaN)
    if (!Number.isInteger(index)) {
      throw new Error('the browser session could not find the tab it opened')
    }
    await this.call('browser_tabs', { action: 'select', index })
    this.agentTabUrl = 'about:blank'
    this.ownsTab = true
  }

  /**
   * Close the session's tab, unless it is marked for keeping.
   * @returns {Promise<void>} resolves once the tab is closed.
   */
  async closeTab() {
    if (!this.ownsTab || this.mark !== 'none') return
    // Close *this session's* tab, identified by its URL. Never call
    // browser_close: that closes whatever page the server currently holds,
    // which may be a tab the user opened.
    const index = await this.#findAgentTabIndex()
    if (index !== null) {
      try {
        await this.call('browser_tabs', { action: 'close', index })
      } catch {
        // The tab may already be gone.
      }
    }
    this.ownsTab = false
    this.agentTabUrl = ''
  }

  /**
   * Rename the session: reconnect under the new client name, which is the
   * name the browser extension puts in the tab group.
   * @param {string} label - the new label.
   * @returns {Promise<void>} resolves once the server is connected again.
   */
  async rename(label) {
    this.label = label
    await this.#connect(true)
    await this.ensureOwnTab()
  }

  /**
   * Stop the session and its MCP server.
   * @returns {Promise<void>} resolves once everything is closed.
   */
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const dispose of this.disposers) {
      try {
        dispose()
      } catch {
        // The scope is gone already.
      }
    }
    this.disposers = []
    await this.closeTab()
    try {
      await this.client?.close()
    } catch {
      // The server is gone already.
    }
    this.client = null
  }

  /**
   * Start (or restart) the MCP server.
   * @param {boolean} [reconnect] - close the previous connection first.
   * @returns {Promise<void>} resolves once the server is connected.
   */
  async #connect(reconnect = false) {
    if (reconnect && this.client !== null) {
      try {
        await this.client.close()
      } catch {
        // The server is gone already.
      }
      this.client = null
      this.ownsTab = false
    }
    if (this.client !== null) return
    const client = new McpStdioClient({
      command: this.settings.serverCommand,
      args: this.settings.serverArgs,
      env: this.settings.serverEnv,
      cwd: this.settings.cwd,
      clientName: this.label === '' ? this.settings.defaultClientName : this.label,
      timeoutMs: this.settings.toolCallTimeoutMs,
    })
    await client.connect()
    this.client = client
  }

  /**
   * Guard the calls that would break the session's rules.
   * @param {string} name - the tool name.
   * @param {object} args - the call arguments.
   * @returns {string | undefined} a refusal message, or undefined when allowed.
   */
  #beforeCall(name, args) {
    if (name === 'browser_navigate' && typeof args.url === 'string') {
      const refusal = checkOrigin(args.url, this.settings.allowedOrigins)
      if (refusal !== undefined) return refusal
    }
    if (name === 'browser_tabs' && args.action === 'new' && typeof args.url === 'string') {
      const refusal = checkOrigin(args.url, this.settings.allowedOrigins)
      if (refusal !== undefined) return refusal
    }
    if (name === 'browser_tabs' && args.action === 'select' && args.index !== undefined) {
      return 'The agent works in its own tab. Open a new one with browser_tabs action="new" instead of taking over an existing tab.'
    }
    return undefined
  }

  /**
   * The tool that names the session.
   * @returns {object} the tool definition.
   */
  #nameSessionTool() {
    return {
      name: `mcp__${this.settings.serverName}__browser_name_session`,
      description:
        'Name this browser session. The name shows on the tab the agent controls (an emoji plus a short task name, e.g. "🌐 Google 30s").',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { name: { type: 'string', description: 'Short emoji-prefixed session name.' } },
        required: ['name'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
        render: (_args, value) => [{ type: 'text', text: `Session named "${value.name}".` }],
      },
      execute: async (args) => {
        const name = String(args.name ?? '').trim()
        await this.rename(name)
        return { name }
      },
    }
  }

  /**
   * The tool that marks the tab, so the idle cleaner leaves it alone.
   * @returns {object} the tool definition.
   */
  #markTabTool() {
    return {
      name: `mcp__${this.settings.serverName}__browser_mark_tab`,
      description:
        'Mark the tab the agent controls so it is not closed when the turn ends: "deliverable" (a result the user wants open) or "handoff" (work continues from it later). Use "none" to release it.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { mark: { type: 'string', description: 'deliverable, handoff, or none.' } },
        required: ['mark'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { mark: { type: 'string' } },
          required: ['mark'],
        },
        render: (_args, value) => [{ type: 'text', text: `The tab is marked "${value.mark}".` }],
      },
      execute: async (args) => {
        const mark = String(args.mark ?? 'none').trim()
        this.mark = ['deliverable', 'handoff'].includes(mark) ? mark : 'none'
        return { mark: this.mark }
      },
    }
  }
}
