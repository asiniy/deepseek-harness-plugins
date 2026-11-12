/**
 * A fake Playwright MCP server for the tests.
 *
 * It speaks the same newline-delimited JSON-RPC as the real server over stdio,
 * keeps a tiny in-memory browser (tabs, current page), and records every call
 * so the tests can assert what the plugin did.
 *
 * @module @local/chrome/test/fake-mcp-server
 */

import { createInterface } from 'node:readline'

/** The in-memory browser. */
const state = {
  tabs: [],
  current: -1,
  calls: [],
  clientName: '',
}

/**
 * Render the tab list the way the real server does.
 * @returns {string[]} the lines.
 */
function tabLines() {
  return state.tabs.map((tab, index) => `- ${index}: ${tab.current ? '(current) ' : ''}[${tab.title}](${tab.url})`)
}

/**
 * Answer one tool call.
 * @param {string} name - the tool name.
 * @param {object} args - the arguments.
 * @returns {{ content: Array<object>, isError?: boolean }} the result.
 */
function callTool(name, args) {
  state.calls.push({ name, args })
  switch (name) {
    case 'browser_tabs': {
      if (args.action === 'new') {
        state.tabs.forEach((tab) => {
          tab.current = false
        })
        state.tabs.push({ url: 'about:blank', title: '', current: true })
        state.current = state.tabs.length - 1
      } else if (args.action === 'close') {
        const index = Number(args.index)
        if (Number.isInteger(index) && index >= 0 && index < state.tabs.length) {
          state.tabs.splice(index, 1)
          state.current = state.tabs.length - 1
        }
      } else if (args.action === 'select') {
        const index = Number(args.index)
        if (!Number.isInteger(index) || index < 0 || index >= state.tabs.length) {
          return { content: [{ type: 'text', text: `No tab ${args.index}` }], isError: true }
        }
        state.tabs.forEach((tab, position) => {
          tab.current = position === index
        })
        state.current = index
      }
      return { content: [{ type: 'text', text: ['### Open tabs', ...tabLines()].join('\n') }] }
    }
    case 'browser_navigate': {
      const tab = state.tabs[state.current]
      if (tab === undefined) return { content: [{ type: 'text', text: 'no tab' }], isError: true }
      tab.url = String(args.url ?? '')
      tab.title = `Title of ${tab.url}`
      return { content: [{ type: 'text', text: `### Page\n- Page URL: ${tab.url}\n- Page Title: ${tab.title}` }] }
    }
    case 'browser_snapshot': {
      const tab = state.tabs[state.current]
      return {
        content: [{ type: 'text', text: `### Page\n- Page URL: ${tab?.url ?? ''}\n- Page Title: ${tab?.title ?? ''}` }],
      }
    }
    case 'browser_close': {
      if (state.current >= 0) state.tabs.splice(state.current, 1)
      state.current = state.tabs.length - 1
      return { content: [{ type: 'text', text: 'closed' }] }
    }
    case 'browser_take_screenshot': {
      return {
        content: [
          { type: 'text', text: 'screenshot' },
          {
            type: 'image',
            mimeType: 'image/png',
            data: Buffer.from('fake-png-bytes').toString('base64'),
          },
        ],
      }
    }
    case 'browser_test_state': {
      return { content: [{ type: 'text', text: JSON.stringify(state) }] }
    }
    default:
      return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true }
  }
}

/**
 * The tool descriptors the fake server advertises.
 * @returns {Array<object>} the tools.
 */
const tools = [
  {
    name: 'browser_tabs',
    description: 'List, open, close or select tabs.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { action: { type: 'string' }, index: { type: 'integer' }, url: { type: 'string' } },
    },
  },
  {
    name: 'browser_navigate',
    description: 'Navigate the current tab.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
  {
    name: 'browser_snapshot',
    description: 'Snapshot the current page.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'browser_close',
    description: 'Close the current tab.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'browser_take_screenshot',
    description: 'Take a screenshot.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'browser_test_state',
    description: 'Test-only: dump the fake browser state.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
]

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.id === undefined) return
  const respond = (result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`)
  switch (message.method) {
    case 'initialize':
      state.clientName = message.params?.clientInfo?.name ?? ''
      respond({
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-playwright-mcp', version: '1.0.0' },
      })
      return
    case 'tools/list':
      respond({ tools })
      return
    case 'tools/call':
      // FAKE_MCP_HANG makes the server never answer, so the client's timeout
      // path can be tested.
      if (process.env.FAKE_MCP_HANG === '1') return
      // A protocol-level error, as opposed to a tool that reports isError.
      if (message.params?.name === 'browser_protocol_error') {
        process.stdout.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32000, message: 'the server refused the call' },
        })}\n`)
        return
      }
      respond(callTool(message.params?.name, message.params?.arguments ?? {}))
      return
    default:
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      })}\n`)
  }
})

process.on('SIGTERM', () => process.exit(0))
