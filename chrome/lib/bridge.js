/**
 * Turn an MCP tool into a harness tool definition.
 *
 * This mirrors what the harness's own `@deepseek-ai/dsh-mcp-client` does —
 * stable `mcp__<server>__<tool>` names, the raw JSON Schema as parameters, the
 * canonical `{content, structuredContent}` value, and durable image
 * projection — but it runs per agent, so each session gets its own bridge.
 *
 * @module @local/chrome/bridge
 */

/** Media types the attachment store accepts. */
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Canonical base64: the encoding the attachment store requires. */
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/**
 * @param {unknown} value - a candidate record.
 * @returns {value is Record<string, any>} whether it is a plain object.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Decode one MCP image block.
 * @param {Record<string, any>} block - the image block.
 * @returns {{ data: Buffer, mediaType: string }} the decoded image.
 */
function decodeImage(block) {
  const mediaType = block.mimeType
  if (!IMAGE_MEDIA_TYPES.includes(mediaType)) {
    throw new Error('the declared media type is not PNG, JPEG, WebP, or GIF')
  }
  if (typeof block.data !== 'string' || !CANONICAL_BASE64.test(block.data)) {
    throw new Error('the image data is not canonical base64')
  }
  const data = Buffer.from(block.data, 'base64')
  if (data.toString('base64') !== block.data) throw new Error('the image data is not canonical base64')
  return { data, mediaType }
}

/**
 * Text the model sees when an image could not be admitted.
 * @param {string} reason - why.
 * @returns {string} the diagnostic.
 */
function imageDiagnostic(reason) {
  return `[image not attached: ${reason}]`
}

/**
 * Project MCP content blocks into the harness's content vocabulary.
 * @param {Array<any>} content - the MCP content blocks.
 * @param {string} toolName - the tool, for diagnostics.
 * @param {(block: any, index: number) => any} [image] - how to project an image block.
 * @returns {Array<any>} the projected blocks.
 */
export function projectContent(content, toolName, image = (block) => ({
  type: 'text',
  text: imageDiagnostic('this result was not admitted to durable model context'),
})) {
  const projected = []
  const text = []
  const flush = () => {
    if (text.length === 0) return
    projected.push({ type: 'text', text: text.splice(0).join('\n') })
  }
  for (const [index, value] of content.entries()) {
    if (!isRecord(value)) {
      text.push('[unsupported MCP content block: expected an object]')
      continue
    }
    if (value.type === 'text') {
      text.push(String(value.text ?? ''))
      continue
    }
    if (value.type === 'image') {
      flush()
      projected.push(image(value, index))
      continue
    }
    if (value.type === 'audio' || value.type === 'resource') {
      text.push(`[${value.type} content omitted]`)
      continue
    }
    text.push(`[unsupported MCP content block: ${String(value.type)}]`)
  }
  flush()
  return projected
}

/**
 * Flatten MCP content into one string.
 * @param {Array<any>} content - the MCP content blocks.
 * @param {string} toolName - the tool, for diagnostics.
 * @returns {string} the text.
 */
export function extractText(content, toolName) {
  return projectContent(content, toolName)
    .map((block) => block.text ?? '')
    .join('\n')
}

/**
 * Resolve the attachment store and check that the current route accepts images.
 * @param {any} ctx - the agent context.
 * @param {any} exec - the tool execution.
 * @returns {Promise<any>} the attachment store.
 */
async function resolveImageAdmission(ctx, exec) {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('no attachment store is mounted')
  const routed = exec.agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec.agent?.options?.provider
  const model = routed?.model ?? exec.agent?.options?.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error('the current model route could not be resolved')
  }
  const info = await llm.resolveModelInfo(provider, model, exec.signal)
  if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
    throw new Error(`model "${model}" does not declare image input`)
  }
  return attachments
}

/**
 * Store the images of one MCP result and project them as durable attachments.
 * @param {any} ctx - the agent context.
 * @param {any} exec - the tool execution.
 * @param {Array<any>} content - the MCP content blocks.
 * @returns {Promise<Array<any>>} the projected blocks.
 */
export async function prepareImageProjection(ctx, exec, content) {
  const decoded = []
  const failures = new Map()
  const indexes = []
  for (const [index, value] of content.entries()) {
    if (!isRecord(value) || value.type !== 'image') continue
    indexes.push(index)
    try {
      decoded.push(decodeImage(value))
    } catch (error) {
      failures.set(index, error.message)
    }
  }
  if (failures.size > 0) {
    return projectContent(content, 'image', (block, index) => ({
      type: 'text',
      text: imageDiagnostic(failures.get(index) ?? 'another image in the same result was invalid'),
    }))
  }
  let attachments
  try {
    attachments = await resolveImageAdmission(ctx, exec)
  } catch (error) {
    return projectContent(content, 'image', () => ({ type: 'text', text: imageDiagnostic(error.message) }))
  }
  try {
    const refs = await attachments.saveImages(decoded)
    const byIndex = new Map(indexes.map((index, offset) => [index, refs[offset]]))
    return projectContent(content, 'image', (_block, index) => ({
      type: 'image',
      attachment: byIndex.get(index),
    }))
  } catch (error) {
    return projectContent(content, 'image', () => ({ type: 'text', text: imageDiagnostic(error.message) }))
  }
}

/**
 * Build the harness tool definition for one MCP tool.
 *
 * @param {object} options - the mapping options.
 * @param {object} options.tool - the MCP tool descriptor.
 * @param {(name: string, args: object) => Promise<object>} options.call - calls the MCP server.
 * @param {any} options.ctx - the agent context (for attachments and llm).
 * @param {string} [options.serverName] - namespace for the model-facing name.
 * @param {(args: object) => Promise<object> | object} [options.beforeCall] - hook before every call.
 * @returns {object} the harness tool definition.
 */
export function createToolDefinition({ tool, call, ctx, serverName = 'playwright', beforeCall }) {
  const publicName = `mcp__${serverName}__${tool.name}`
  // The harness calls the projector *synchronously*: an async projector would
  // hand it a Promise, and the durable result would fail the lossless-JSON
  // check. The image projection is therefore prepared during execute and
  // remembered per execution.
  /** @type {WeakMap<object, Array<any>>} */
  const projections = new WeakMap()
  return {
    name: publicName,
    description: tool.description ?? `The ${tool.name} tool of the Playwright MCP server.`,
    parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'array', items: {} },
          structuredContent: tool.outputSchema ?? {},
        },
        required: tool.outputSchema === undefined ? ['content'] : ['content', 'structuredContent'],
      },
      render: (_args, value) => [{ type: 'text', text: extractText(value?.content ?? [], publicName) }],
    },
    async execute(args, exec) {
      if (beforeCall !== undefined) {
        const refusal = await beforeCall(args)
        if (typeof refusal === 'string') {
          return { content: [{ type: 'text', text: refusal }], isError: true }
        }
      }
      const result = await call(tool.name, args)
      const content = result?.content ?? []
      const value = {
        content,
        ...(result?.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
      }
      if (exec !== undefined && content.some((block) => isRecord(block) && block.type === 'image')) {
        projections.set(exec, await prepareImageProjection(ctx, exec, content))
      }
      return value
    },
    projectContent(exec, value) {
      const prepared = exec === undefined ? undefined : projections.get(exec)
      if (prepared !== undefined) {
        projections.delete(exec)
        return prepared
      }
      return projectContent(value?.content ?? [], publicName)
    },
  }
}
