/**
 * Test helpers: a fake agent context and a fake attachment store.
 *
 * @module @local/chrome/test/helpers
 */

/**
 * Build a stand-in for an agent's cordis context.
 *
 * @param {object} [options] - the fake's options.
 * @param {boolean} [options.imageCapable] - whether the route accepts images.
 * @returns {object} the fake context and the handles the tests assert on.
 */
export function fakeAgentContext({ imageCapable = true } = {}) {
  /** @type {Array<object>} */
  const registered = []
  /** @type {Array<{ event: string, handler: Function }>} */
  const listeners = []
  const savedImages = []

  const attachments = {
    async saveImages(inputs) {
      savedImages.push(...inputs)
      return inputs.map((input) => ({
        attachmentId: `att-${input.data.byteLength}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 1,
        height: 1,
      }))
    },
  }

  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {
          const index = registered.indexOf(definition)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    on(event, handler) {
      listeners.push({ event, handler })
      return () => {
        const index = listeners.findIndex((entry) => entry.handler === handler)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    get(name) {
      if (name === 'attachments') return attachments
      if (name === 'llm') {
        return {
          async resolveModelInfo() {
            return { inputModalities: imageCapable ? ['text', 'image'] : ['text'] }
          },
        }
      }
      return undefined
    },
  }

  return {
    ctx,
    registered,
    savedImages,
    /** Find a registered tool by name. */
    tool(name) {
      return registered.find((definition) => definition.name === name)
    },
    /** Fire an event at the listeners. */
    emit(event, ...args) {
      for (const entry of [...listeners]) {
        if (entry.event === event) entry.handler(...args)
      }
    },
    /** A stand-in for the tool execution the runtime passes to execute(). */
    execution() {
      return {
        signal: new AbortController().signal,
        agent: {
          session: { requestHeader: () => ({ config: { provider: 'test', model: 'test-model' } }) },
          options: { provider: 'test', model: 'test-model' },
        },
      }
    },
  }
}

/**
 * Build a stand-in for an agent handle.
 *
 * @param {string} id - the agent id (the harness uses the session id).
 * @param {object} [options] - the fake's options.
 * @returns {object} the agent handle.
 */
export function fakeAgent(id = 'session-1', options = {}) {
  const context = fakeAgentContext(options)
  return {
    id,
    ctx: context.ctx,
    ...context,
  }
}
