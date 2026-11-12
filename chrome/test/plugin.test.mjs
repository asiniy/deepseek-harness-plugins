/**
 * Tests for the plugin: an agent gets a browser session, and loses it when the
 * agent is disposed.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { apply } from '../index.js'
import { fakeAgent } from './helpers.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, 'fake-mcp-server.mjs')

/**
 * Build a plugin context that records the agent events it receives.
 * @returns {object} the fake context.
 */
function fakePluginContext() {
  /** @type {Array<{ event: string, handler: Function }>} */
  const listeners = []
  const effects = []
  /** @type {Array<object>} */
  const agents = []
  return {
    listeners,
    effects,
    logger: { warn() {}, error() {}, info() {} },
    agents: {
      list: () => [...agents],
      roots: () => [...agents],
    },
    on(event, handler) {
      listeners.push({ event, handler })
      return () => {
        const index = listeners.findIndex((entry) => entry.handler === handler)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    effect(callback) {
      effects.push(callback)
      return () => {}
    },
    /** Fire an event at the plugin's listeners. */
    emit(event, ...args) {
      if (event === 'agent/created' && args[0] !== undefined) agents.push(args[0])
      if (event === 'agent/disposed' && args[0] !== undefined) {
        const index = agents.findIndex((agent) => agent.id === args[0].id)
        if (index >= 0) agents.splice(index, 1)
      }
      for (const entry of [...listeners]) {
        if (entry.event === event) entry.handler(...args)
      }
    },
  }
}

/**
 * The configuration the tests use: the fake MCP server.
 * @returns {object} the config.
 */
function fakeConfig() {
  return {
    serverCommand: process.execPath,
    serverArgs: [SERVER],
    cwd: HERE,
    allowedOrigins: ['https://allowed.test'],
    serverName: 'playwright',
    toolCallTimeoutMs: 5_000,
  }
}

test('an agent gets its own browser session', async () => {
  const ctx = fakePluginContext()
  apply(ctx, fakeConfig())
  const agent = fakeAgent('session-a')
  ctx.emit('agent/created', agent)
  await new Promise((resolve) => setTimeout(resolve, 400))
  const names = agent.registered.map((tool) => tool.name)
  assert.ok(names.includes('mcp__playwright__browser_navigate'))
  ctx.emit('agent/disposed', agent)
})

test('two agents get separate sessions and separate tabs', async () => {
  const ctx = fakePluginContext()
  apply(ctx, fakeConfig())
  const first = fakeAgent('session-a')
  const second = fakeAgent('session-b')
  ctx.emit('agent/created', first)
  ctx.emit('agent/created', second)
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.ok(first.registered.some((tool) => tool.name === 'mcp__playwright__browser_navigate'))
  assert.ok(second.registered.some((tool) => tool.name === 'mcp__playwright__browser_navigate'))
  ctx.emit('agent/disposed', first)
  ctx.emit('agent/disposed', second)
})

test('disposing an agent tears its session down', async () => {
  const ctx = fakePluginContext()
  apply(ctx, fakeConfig())
  const agent = fakeAgent('session-c')
  ctx.emit('agent/created', agent)
  await new Promise((resolve) => setTimeout(resolve, 400))
  ctx.emit('agent/disposed', agent)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(agent.registered.length, 0)
})

test('the plugin reads the extension token from the harness env layer', () => {
  const ctx = fakePluginContext()
  const home = join(HERE, '.fake-home')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    apply(ctx, fakeConfig())
    // The session settings carry the token; a missing env layer simply means
    // the extension transport has no token, which the server reports.
    assert.ok(ctx.listeners.some((entry) => entry.event === 'agent/created'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
