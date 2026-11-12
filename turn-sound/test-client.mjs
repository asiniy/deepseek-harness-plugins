#!/usr/bin/env node
/**
 * Headless check of the turn-sound browser half.
 *
 * The plugin's `client.js` is a browser bundle, so it is exercised here
 * against a fake `window`, a fake `require`, and a fake plugin context: the
 * sounds that play, the ones that do not, the debounce, the mute, and the
 * unlock listeners. The last check compares the built bundle with the
 * packaged sound, so a source edit without a rebuild is caught.
 *
 * Usage:
 *     node turn-sound/test-client.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const STORAGE_KEY = 'dsh.turn-sound.enabled'

/** The source of the browser half, with the sound placeholder filled in. */
const source = readFileSync(new URL('./client.source.js', import.meta.url), 'utf8')
  // The placeholder appears in the comment as well; the constant is the one
  // that matters, so every occurrence is replaced.
  .replaceAll('__SOUND_DATA_URI__', 'data:audio/mpeg;base64,QUJD')

/**
 * Build a plugin instance with its own window, context and state.
 * @param {{ muted?: boolean }} options - whether the plugin starts muted.
 * @returns {object} the instance and its handles.
 */
function createInstance(options = {}) {
  const storage = new Map()
  if (options.muted === true) storage.set(STORAGE_KEY, '0')
  const listeners = new Map()
  const played = []
  const subscribed = { status: [], list: [], event: [], remote: [] }
  let sessionStatus = new Map()
  let sessionEvents = []

  class FakeAudioContext {
    constructor() {
      this.state = 'running'
      this.destination = { name: 'destination' }
    }

    resume() {
      this.state = 'running'
      return Promise.resolve()
    }

    async decodeAudioData(bytes) {
      return { name: 'buffer', bytes }
    }

    createBufferSource() {
      return {
        buffer: null,
        connect() {},
        start: () => { played.push('sound') },
      }
    }

    createGain() {
      return { gain: { value: 1 }, connect() {} }
    }
  }

  const windowMock = {
    localStorage: {
      getItem: key => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
    },
    AudioContext: FakeAudioContext,
    addEventListener: (type, listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(listener)
    },
    removeEventListener: (type, listener) => {
      listeners.get(type)?.delete(listener)
    },
  }

  let registration
  windowMock.__ModuleLoader__ = { load: entry => { registration = entry } }
  new Function('window', 'require', source)(windowMock, () => {
    throw new Error('unexpected require')
  })

  const binding = {
    eventSource: {
      getSnapshot: () => ({ change: { kind: 'append', entries: sessionEvents } }),
      subscribe: callback => {
        subscribed.event.push(callback)
        return () => {}
      },
    },
  }

  const context = {
    effect: body => { instance.dispose = body() },
    sessions: {
      list: {
        getSnapshot: () => ({ ids: ['session-1'] }),
        subscribe: callback => {
          subscribed.list.push(callback)
          return () => {}
        },
      },
      binding: () => binding,
    },
    uiSession: {
      sessionStatus: {
        getSnapshot: () => sessionStatus,
        subscribe: callback => {
          subscribed.status.push(callback)
          return () => {}
        },
      },
    },
    remote: {
      $on: (event, callback) => {
        subscribed.remote.push(callback)
        return () => {}
      },
    },
  }

  const instance = { window: windowMock, context, subscribed, played, listeners, dispose: () => {} }
  instance.plugin = registration.factory()
  instance.plugin.apply(context)
  instance.setStatus = statuses => { sessionStatus = statuses }
  instance.setEvents = events => { sessionEvents = events }
  instance.fireStatus = () => { for (const callback of subscribed.status) callback() }
  instance.fireEvents = () => { for (const callback of subscribed.event) callback() }
  instance.fireRemote = (sessionId, running) => { for (const callback of subscribed.remote) callback(sessionId, running) }
  return instance
}

/**
 * Let the plugin's promise chain settle: the sound is decoded and started
 * over a few microtasks.
 */
async function settle() {
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
}

const checks = []
/**
 * @param {string} name - what is checked.
 * @param {Function} body - the check.
 */
async function check(name, body) {
  await body()
  checks.push(name)
  console.log(`ok  ${name}`)
}

await check('the plugin registers itself and asks for its services', () => {
  const instance = createInstance()
  assert.equal(instance.plugin.inject.length, 3, 'the plugin asks for the wrong services')
  assert.ok(instance.plugin.inject.includes('remote'), 'the plugin does not ask for the remote service')
  assert.ok(instance.plugin.inject.includes('sessions'), 'the plugin does not ask for the sessions service')
  assert.ok(instance.plugin.inject.includes('uiSession'), 'the plugin does not ask for the session UI service')
})

await check('the unlock listeners are attached', () => {
  const instance = createInstance()
  for (const type of ['pointerdown', 'keydown', 'touchstart']) {
    assert.ok((instance.listeners.get(type)?.size ?? 0) > 0, `${type} is not watched`)
  }
})

await check('an approval rings', async () => {
  const instance = createInstance()
  instance.setStatus(new Map([['session-1', { pendingInteraction: { key: 'i-1', kind: 'approval' } }]]))
  instance.fireStatus()
  await settle()
  assert.equal(instance.played.length, 1, 'the approval did not ring')
})

await check('a pending interaction of another kind does not ring', async () => {
  const instance = createInstance()
  instance.setStatus(new Map([['session-1', { pendingInteraction: { key: 'i-2', kind: 'question' } }]]))
  instance.fireStatus()
  await settle()
  assert.equal(instance.played.length, 0, 'a question rang')
})

await check('the same approval does not ring twice', async () => {
  const instance = createInstance()
  instance.setStatus(new Map([['session-1', { pendingInteraction: { key: 'i-1', kind: 'approval' } }]]))
  instance.fireStatus()
  instance.fireStatus()
  await settle()
  assert.equal(instance.played.length, 1, 'the approval rang twice')
})

await check('changed files ring', async () => {
  const instance = createInstance()
  instance.setEvents([{ event: { type: 'workspace/changes' } }])
  instance.fireEvents()
  await settle()
  assert.equal(instance.played.length, 1, 'the file change did not ring')
})

await check('an asked approval rings', async () => {
  const instance = createInstance()
  instance.setEvents([{ event: { type: 'approval/asked' } }])
  instance.fireEvents()
  await settle()
  assert.equal(instance.played.length, 1, 'the approval request did not ring')
})

await check('another event does not ring', async () => {
  const instance = createInstance()
  instance.setEvents([{ event: { type: 'turn/completed' } }])
  instance.fireEvents()
  await settle()
  assert.equal(instance.played.length, 0, 'an unrelated event rang')
})

await check('a finished turn rings', async () => {
  const instance = createInstance()
  instance.fireRemote('session-1', false)
  await settle()
  assert.equal(instance.played.length, 1, 'the finished turn did not ring')
})

await check('a running turn does not ring', async () => {
  const instance = createInstance()
  instance.fireRemote('session-1', true)
  await settle()
  assert.equal(instance.played.length, 0, 'a running turn rang')
})

await check('repeats inside the debounce window ring once', async () => {
  const instance = createInstance()
  instance.fireRemote('session-1', false)
  instance.fireRemote('session-1', false)
  await settle()
  assert.equal(instance.played.length, 1, 'the debounce did not hold')
})

await check('the mute setting silences the plugin', async () => {
  const instance = createInstance({ muted: true })
  instance.fireRemote('session-1', false)
  await settle()
  assert.equal(instance.played.length, 0, 'the muted plugin rang')
})

await check('the unlock listeners are detached on dispose', () => {
  const instance = createInstance()
  instance.dispose()
  for (const type of ['pointerdown', 'keydown', 'touchstart']) {
    assert.equal((instance.listeners.get(type)?.size ?? 0), 0, `${type} is still watched`)
  }
})

await check('the built bundle carries the packaged sound', () => {
  const built = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
  // The comment names the placeholder, the constant holds the sound.
  assert.ok(!built.includes("'__SOUND_DATA_URI__'"), 'the built bundle still has the placeholder')
  const sound = readFileSync(new URL('./assets/aoe2-attack.mp3', import.meta.url))
  const expected = Buffer.from(sound).toString('base64')
  assert.ok(built.includes(expected), 'the built bundle carries another sound than the packaged one')
  assert.equal(built.split('data:audio/mpeg;base64,').length - 1, 1, 'the sound is embedded more than once')
})

console.log(`\n${checks.length} checks passed`)
