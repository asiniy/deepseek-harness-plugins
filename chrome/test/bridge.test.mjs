/**
 * Tests for the MCP tool → harness tool bridge.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createToolDefinition, projectContent, extractText } from '../lib/bridge.js'
import { fakeAgentContext } from './helpers.mjs'

/**
 * Build a definition over a stub server.
 * @param {object} [options] - the bridge options.
 * @returns {object} the definition and the fake context.
 */
function build(options = {}) {
  const fake = fakeAgentContext(options)
  const calls = []
  const definition = createToolDefinition({
    tool: {
      name: 'browser_navigate',
      description: 'Navigate the current tab.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
    call: async (name, args) => {
      calls.push({ name, args })
      return options.result ?? { content: [{ type: 'text', text: '### Page\n- Page URL: https://example.test/' }] }
    },
    ctx: fake.ctx,
    serverName: 'playwright',
    ...options.definition,
  })
  return { definition, fake, calls }
}

test('names the tool with the server namespace', () => {
  const { definition } = build()
  assert.equal(definition.name, 'mcp__playwright__browser_navigate')
  assert.equal(definition.description, 'Navigate the current tab.')
})

test('carries the server schema as the parameters', () => {
  const { definition } = build()
  assert.equal(definition.parameters.required[0], 'url')
  assert.equal(definition.parameters.properties.url.type, 'string')
})

test('execute returns the canonical content value', async () => {
  const { definition, calls } = build()
  const value = await definition.execute({ url: 'https://example.test/' }, fakeExecution())
  assert.match(value.content[0].text, /Page URL/)
  assert.deepEqual(calls, [{ name: 'browser_navigate', args: { url: 'https://example.test/' } }])
})

test('execute refuses when the before-call hook says so', async () => {
  const { definition } = build({
    definition: { beforeCall: () => 'Navigation refused: origin not allowed.' },
  })
  const value = await definition.execute({ url: 'https://example.test/' }, fakeExecution())
  assert.match(value.content[0].text, /Navigation refused/)
})

test('render flattens the content into text blocks', async () => {
  const { definition } = build()
  const value = await definition.execute({}, fakeExecution())
  const rendered = definition.output.render({}, value)
  assert.equal(rendered.length, 1)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /Page URL/)
})

test('projectContent stores images and returns attachment blocks', async () => {
  const png = Buffer.from('fake-png-bytes').toString('base64')
  const { definition, fake } = build({
    result: {
      content: [
        { type: 'text', text: 'screenshot' },
        { type: 'image', mimeType: 'image/png', data: png },
      ],
    },
  })
  const execution = fakeExecution()
  const value = await definition.execute({}, execution)
  const projected = definition.projectContent(execution, value)
  assert.equal(projected[0].type, 'text')
  assert.equal(projected[1].type, 'image')
  assert.equal(projected[1].attachment.mediaType, 'image/png')
  assert.equal(fake.savedImages.length, 1)
  assert.equal(fake.savedImages[0].data.toString('utf8'), 'fake-png-bytes')
})

test('projectContent explains an image the route cannot take', async () => {
  const png = Buffer.from('fake-png-bytes').toString('base64')
  const { definition } = build({
    imageCapable: false,
    result: {
      content: [
        { type: 'text', text: 'screenshot' },
        { type: 'image', mimeType: 'image/png', data: png },
      ],
    },
  })
  const execution = fakeExecution()
  const value = await definition.execute({}, execution)
  const projected = definition.projectContent(execution, value)
  assert.equal(projected[1].type, 'text')
  assert.match(projected[1].text, /image not attached/)
})

test('projectContent rejects an image with a bad encoding', () => {
  const projected = projectContent(
    [{ type: 'image', mimeType: 'image/png', data: 'not base64!!' }],
    'test',
  )
  assert.match(projected[0].text, /image not attached/)
})

test('extractText joins the text blocks', () => {
  const text = extractText([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }], 'test')
  assert.equal(text, 'one\ntwo')
})

/**
 * A tool execution stub.
 * @returns {object} the execution.
 */
function fakeExecution() {
  return {
    signal: new AbortController().signal,
    agent: {
      session: { requestHeader: () => ({ config: { provider: 'test', model: 'test-model' } }) },
      options: { provider: 'test', model: 'test-model' },
    },
  }
}
