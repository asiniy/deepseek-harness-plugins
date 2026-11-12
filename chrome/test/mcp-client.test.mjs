/**
 * Tests for the minimal MCP stdio client.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { McpStdioClient } from '../lib/mcp-client.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, 'fake-mcp-server.mjs')

/**
 * Start a client against the fake server.
 * @param {object} [options] - client options.
 * @returns {Promise<McpStdioClient>} the connected client.
 */
async function connect(options = {}) {
  const client = new McpStdioClient({ command: process.execPath, args: [SERVER], ...options })
  await client.connect()
  return client
}

test('connects and reports the server identity', async () => {
  const client = await connect({ clientName: '🌐 test' })
  try {
    assert.equal(client.serverInfo.serverInfo.name, 'fake-playwright-mcp')
    assert.ok(client.serverInfo.protocolVersion.length > 0)
  } finally {
    await client.close()
  }
})

test('lists the tools the server advertises', async () => {
  const client = await connect()
  try {
    const tools = await client.listTools()
    assert.ok(tools.length > 0)
    assert.ok(tools.some((tool) => tool.name === 'browser_navigate'))
  } finally {
    await client.close()
  }
})

test('calls a tool and returns the MCP result', async () => {
  const client = await connect()
  try {
    const result = await client.callTool('browser_tabs', { action: 'new' })
    assert.ok(Array.isArray(result.content))
    assert.match(result.content[0].text, /Open tabs/)
  } finally {
    await client.close()
  }
})

test('sends the client name the server sees', async () => {
  const client = await connect({ clientName: 'dsh-session-42' })
  try {
    const result = await client.callTool('browser_test_state', {})
    const state = JSON.parse(result.content[0].text)
    assert.equal(state.clientName, 'dsh-session-42')
  } finally {
    await client.close()
  }
})

test('a tool that fails comes back as an error result, not a rejection', async () => {
  const client = await connect()
  try {
    const result = await client.callTool('does_not_exist', {})
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /unknown tool/)
  } finally {
    await client.close()
  }
})

test('rejects when the server reports a protocol error', async () => {
  const client = await connect()
  try {
    await assert.rejects(
      () => client.callTool('browser_protocol_error', {}),
      /the server refused the call/,
    )
  } finally {
    await client.close()
  }
})

test('rejects a call that never answers', async () => {
  const client = new McpStdioClient({
    command: process.execPath,
    args: [SERVER],
    env: { FAKE_MCP_HANG: '1' },
    timeoutMs: 800,
  })
  await client.connect()
  try {
    await assert.rejects(() => client.callTool('browser_tabs', {}), /timed out/)
  } finally {
    await client.close()
  }
})

test('closing stops the server process', async () => {
  const client = await connect()
  await client.close()
  assert.equal(client.child, null)
})
