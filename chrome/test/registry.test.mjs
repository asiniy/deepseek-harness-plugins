/**
 * Integration test: the bridge against the *real* tool registry.
 *
 * The registry is what the harness uses: it validates the schema, executes the
 * tool and materialises the durable result. A definition that the registry
 * rejects never reaches the model — the harness reports "tool result must be
 * losslessly JSON-serializable" — so this test pins that contract.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import SystemPromptService from '@deepseek-ai/dsh-system-prompt'
import { apply as nativeExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import { createToolDefinition } from '../lib/bridge.js'
import { fakeAgentContext } from './helpers.mjs'

/**
 * Mount the real tool registry and register one definition.
 * @param {object} definition - the tool definition.
 * @returns {Promise<{ tools: any, ctx: any }>} the registry and the context.
 */
async function mount(definition) {
  const ctx = new Context()
  await ctx.plugin(SystemPromptService)
  await ctx.plugin(ToolsService)
  await ctx.plugin({ inject: ['tools'], apply: nativeExecutor })
  ctx.tools.register(definition)
  return { tools: ctx.tools, ctx }
}

/**
 * A definition over a stub server.
 * @param {object} [options] - the bridge options.
 * @returns {object} the definition and the fake context.
 */
function build(options = {}) {
  const fake = fakeAgentContext()
  const definition = createToolDefinition({
    tool: {
      name: 'browser_tabs',
      description: 'List tabs.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { action: { type: 'string' } },
      },
    },
    call: async () => options.result ?? { content: [{ type: 'text', text: '### Open tabs\n- 0: [x](https://x.test/)' }] },
    ctx: fake.ctx,
  })
  return { definition, fake }
}

test('the real registry accepts the definition and executes it', async () => {
  const { definition } = build()
  const { tools, ctx } = await mount(definition)
  try {
    const result = await tools.execute({
      calls: [{
        id: 'call-1',
        name: 'mcp__playwright__browser_tabs',
        arguments: { action: 'list' },
      }],
      signal: new AbortController().signal,
    })
    const outcome = result.results?.[0]?.result ?? result
    const text = (outcome.content ?? []).map((block) => block.text ?? '').join('\n')
    assert.match(text, /Open tabs/)
  } finally {
    await ctx[Symbol.dispose]?.()
  }
})

test('the real registry materialises an image result', async () => {
  const png = Buffer.from('fake-png-bytes').toString('base64')
  const { definition, fake } = build({
    result: {
      content: [
        { type: 'text', text: 'screenshot' },
        { type: 'image', mimeType: 'image/png', data: png },
      ],
    },
  })
  const { tools, ctx } = await mount(definition)
  try {
    const result = await tools.execute({
      calls: [{
        id: 'call-2',
        name: 'mcp__playwright__browser_tabs',
        arguments: {},
      }],
      signal: new AbortController().signal,
      agent: {
        session: { requestHeader: () => ({ config: { provider: 'test', model: 'test-model' } }) },
        options: { provider: 'test', model: 'test-model' },
      },
    })
    const outcome = result.results?.[0]?.result ?? result
    const blocks = outcome.content ?? []
    assert.equal(blocks[0].type, 'text')
    assert.equal(blocks[1].type, 'image')
    assert.equal(fake.savedImages.length, 1)
  } finally {
    await ctx[Symbol.dispose]?.()
  }
})
