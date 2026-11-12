/**
 * A minimal Model Context Protocol client over a child process's stdio.
 *
 * The harness profile cannot reach the npm registry, so this implements the
 * slice of MCP the browser tools need: initialize, tools/list, tools/call.
 * Messages are newline-delimited JSON-RPC 2.0, as the MCP stdio transport
 * specifies.
 *
 * @module @local/chrome/mcp-client
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

/** Protocol revision the client asks for; the server may answer with its own. */
export const DEFAULT_PROTOCOL_VERSION = '2025-06-18'

/**
 * A connected MCP server.
 */
export class McpStdioClient {
  /**
   * @param {object} options - connection options.
   * @param {string} options.command - the executable to run.
   * @param {string[]} [options.args] - its arguments.
   * @param {Record<string, string>} [options.env] - environment overrides.
   * @param {string} [options.cwd] - working directory.
   * @param {string} [options.clientName] - identity the server sees; Playwright's
   *   extension titles its tab group "Playwright · <client name>".
   * @param {string} [options.clientVersion] - client version.
   * @param {number} [options.timeoutMs] - per-request timeout.
   */
  constructor({
    command,
    args = [],
    env = {},
    cwd = process.cwd(),
    clientName = 'dsh-browser',
    clientVersion = '1.0.0',
    timeoutMs = 120_000,
  }) {
    this.command = command
    this.args = args
    this.env = env
    this.cwd = cwd
    this.clientName = clientName
    this.clientVersion = clientVersion
    this.timeoutMs = timeoutMs
    /** @type {import('node:child_process').ChildProcessWithoutNullStreams | null} */
    this.child = null
    /** @type {Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
    this.pending = new Map()
    this.nextId = 1
    this.closed = false
    /** @type {{ protocolVersion?: string, serverInfo?: object } | null} */
    this.serverInfo = null
  }

  /**
   * Spawn the server and complete the MCP handshake.
   * @returns {Promise<{ protocolVersion: string, serverInfo: object }>} the server's identity.
   */
  async connect() {
    if (this.child !== null) return this.serverInfo ?? {}
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    // A leaked client must not keep the process alive.
    this.child.unref()
    this.child.on('error', (error) => this.#failAll(error))
    this.child.on('close', () => {
      this.closed = true
      this.#failAll(new Error('the MCP server exited'))
    })
    createInterface({ input: this.child.stdout }).on('line', (line) => this.#onLine(line))

    const result = await this.#request('initialize', {
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: this.clientName, version: this.clientVersion },
    })
    this.serverInfo = {
      protocolVersion: result?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
      serverInfo: result?.serverInfo ?? {},
    }
    this.#notify('notifications/initialized')
    return this.serverInfo
  }

  /**
   * List the tools the server publishes.
   * @returns {Promise<Array<object>>} the tool descriptors.
   */
  async listTools() {
    const result = await this.#request('tools/list', {})
    const tools = result?.tools
    if (!Array.isArray(tools)) throw new Error('the MCP server did not return a tool list')
    return tools
  }

  /**
   * Call one tool.
   * @param {string} name - the tool name.
   * @param {object} args - the tool arguments.
   * @returns {Promise<object>} the raw MCP result.
   */
  async callTool(name, args = {}) {
    return await this.#request('tools/call', { name, arguments: args })
  }

  /**
   * Stop the server.
   * @returns {Promise<void>} resolves once the process is gone.
   */
  async close() {
    if (this.child === null) return
    const child = this.child
    this.child = null
    this.closed = true
    this.#failAll(new Error('the MCP client was closed'))
    try {
      child.stdin.end()
    } catch {
      // The pipe is already gone.
    }
    child.kill('SIGTERM')
    await new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
        resolve()
      }, 2_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /**
   * Handle one line from the server.
   * @param {string} line - the JSON-RPC frame.
   * @returns {void}
   */
  #onLine(line) {
    if (line.trim() === '') return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id)
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error !== undefined) {
        entry.reject(new Error(message.error?.message ?? 'the MCP call failed'))
      } else {
        entry.resolve(message.result ?? {})
      }
      return
    }
    // A server-to-client request: we implement no client features, so decline it.
    if (message.id !== undefined && message.method !== undefined) {
      this.#send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unsupported client method' } })
    }
  }

  /**
   * Send one request and await its reply.
   * @param {string} method - the RPC method.
   * @param {object} params - the method parameters.
   * @returns {Promise<any>} the result.
   */
  #request(method, params) {
    if (this.child === null) return Promise.reject(new Error('the MCP client is not connected'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`the MCP call ${method} timed out after ${this.timeoutMs} ms`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.#send({ jsonrpc: '2.0', id, method, params })
    })
  }

  /**
   * Send one notification.
   * @param {string} method - the RPC method.
   * @returns {void}
   */
  #notify(method) {
    this.#send({ jsonrpc: '2.0', method })
  }

  /**
   * Write one frame to the server.
   * @param {object} message - the message.
   * @returns {void}
   */
  #send(message) {
    if (this.child === null) return
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`)
    } catch {
      // The pipe is closed; the close handler rejects the pending calls.
    }
  }

  /**
   * Reject every in-flight request.
   * @param {Error} error - the reason.
   * @returns {void}
   */
  #failAll(error) {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id)
      clearTimeout(entry.timer)
      entry.reject(error)
    }
  }
}
