/**
 * Tests for the per-agent browser session.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { BrowserSession, checkOrigin } from '../lib/session.js'
import { fakeAgent } from './helpers.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, 'fake-mcp-server.mjs')

/**
 * Build a session over the fake server.
 * @param {object} [options] - the session options.
 * @returns {Promise<{ session: BrowserSession, agent: object }>} the session.
 */
async function buildSession(options = {}) {
  const agent = fakeAgent(options.id ?? 'session-1')
  const session = new BrowserSession({
    agent,
    settings: {
      serverCommand: process.execPath,
      serverArgs: [SERVER],
      serverEnv: {},
      cwd: HERE,
      allowedOrigins: options.allowedOrigins ?? ['https://allowed.test'],
      serverName: 'playwright',
      toolCallTimeoutMs: 5_000,
      defaultClientName: `dsh-${agent.id}`,
    },
  })
  await session.start()
  return { session, agent }
}

/**
 * Read the fake browser's state through the session.
 * @param {BrowserSession} session - the session.
 * @returns {Promise<object>} the state.
 */
async function fakeState(session) {
  const result = await session.call('browser_test_state', {})
  return JSON.parse(result.content[0].text)
}

test('checkOrigin allows listed origins and refuses others', () => {
  assert.equal(checkOrigin('https://allowed.test/page', ['https://allowed.test']), undefined)
  assert.match(
    checkOrigin('https://other.test/page', ['https://allowed.test']),
    /not allowed/,
  )
  assert.equal(checkOrigin('about:blank', ['https://allowed.test']), undefined)
  assert.equal(checkOrigin('https://anything.test', []), undefined)
})

test('start registers the browser tools in the agent scope', async () => {
  const { session, agent } = await buildSession()
  try {
    const names = agent.registered.map((tool) => tool.name)
    assert.ok(names.includes('mcp__playwright__browser_navigate'))
    assert.ok(names.includes('mcp__playwright__browser_tabs'))
    assert.ok(names.includes('mcp__playwright__browser_name_session'))
    assert.ok(names.includes('mcp__playwright__browser_mark_tab'))
  } finally {
    await session.dispose()
  }
})

test('the session works in a tab of its own', async () => {
  const { session } = await buildSession()
  try {
    const state = await fakeState(session)
    assert.equal(state.tabs.length, 1)
    assert.equal(state.current, 0)
    assert.equal(state.tabs[0].url, 'about:blank')
  } finally {
    await session.dispose()
  }
})

test('navigation outside the allowlist is refused', async () => {
  const { session, agent } = await buildSession()
  try {
    const tool = agent.tool('mcp__playwright__browser_navigate')
    const value = await tool.execute({ url: 'https://blocked.test/' }, agent.execution())
    assert.match(value.content[0].text, /Navigation refused/)
    const state = await fakeState(session)
    assert.ok(!state.calls.some((call) => call.name === 'browser_navigate'))
  } finally {
    await session.dispose()
  }
})

test('taking over an existing tab is refused', async () => {
  const { session, agent } = await buildSession()
  try {
    const tool = agent.tool('mcp__playwright__browser_tabs')
    const value = await tool.execute({ action: 'select', index: 0 }, agent.execution())
    assert.match(value.content[0].text, /works in its own tab/)
  } finally {
    await session.dispose()
  }
})

test('naming the session reconnects under the new name', async () => {
  const { session, agent } = await buildSession()
  try {
    const tool = agent.tool('mcp__playwright__browser_name_session')
    const value = await tool.execute({ name: '🌐 Google 30s' }, agent.execution())
    assert.equal(value.name, '🌐 Google 30s')
    const state = await fakeState(session)
    assert.equal(state.clientName, '🌐 Google 30s')
  } finally {
    await session.dispose()
  }
})

test('a marked tab survives closeTab', async () => {
  const { session, agent } = await buildSession()
  try {
    const mark = agent.tool('mcp__playwright__browser_mark_tab')
    await mark.execute({ mark: 'deliverable' }, agent.execution())
    await session.closeTab()
    const state = await fakeState(session)
    assert.equal(state.tabs.length, 1)
  } finally {
    await session.dispose()
  }
})

test('the turn ending closes the tab', async () => {
  const { session, agent } = await buildSession()
  try {
    agent.emit('session/event', {}, { type: 'turn/end' })
    await new Promise((resolve) => setTimeout(resolve, 200))
    const state = await fakeState(session)
    assert.equal(state.tabs.length, 0)
  } finally {
    await session.dispose()
  }
})

test('disposing closes the tab and unregisters the tools', async () => {
  const { session, agent } = await buildSession()
  await session.dispose()
  assert.equal(agent.registered.length, 0)
})

test("closing the session's tab never touches a tab the user opened", async () => {
  const { session, agent } = await buildSession()
  try {
    // A tab the user opened, outside the session's own tracking.
    await session.client.callTool('browser_tabs', { action: 'new' })
    const before = await fakeState(session)
    assert.equal(before.tabs.length, 2)

    agent.emit('session/event', {}, { type: 'turn/end' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const after = await fakeState(session)
    // The user's tab is still there; only the session's own tab went away.
    assert.equal(after.tabs.length, 1)
    assert.equal(after.tabs[0].url, 'about:blank')
  } finally {
    await session.dispose()
  }
})
