#!/usr/bin/env node
/**
 * Headless check of the session-unread browser half.
 *
 * The plugin's `client.js` is a browser bundle, so it is exercised here
 * against a fake `window`, a fake `require`, and a fake plugin context. That
 * covers the behaviour the sidebar depends on: the menu entry and its label,
 * the persisted marked set, the row marker, the float-to-top pin, and the
 * rules that clear a mark (the session was opened, the session left the
 * catalog).
 *
 * Usage:
 *     node session-unread/test-client.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const STORAGE_KEY = 'dsh.session-unread.v1'
const PINNED_KEY = 'dsh.session-unread.pinned.v1'

// --------------------------------------------------------------- fake window

const storage = new Map()
globalThis.window = {
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
  },
}

let registration
globalThis.window.__ModuleLoader__ = {
  load: (entry) => {
    registration = entry
  },
}

// ---------------------------------------------------------------- fake react

const React = {
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props, children }),
}
const StateDot = (props) => ({ type: 'StateDot', props })

const requireModule = (specifier) => {
  if (specifier === 'react') return React
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return { StateDot }
  throw new Error(`unexpected require: ${specifier}`)
}

// ------------------------------------------------------------------- load

const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
new Function('window', 'require', source)(globalThis.window, requireModule)
assert.equal(registration.id, '@local/session-unread')
const plugin = registration.factory(requireModule)

// ------------------------------------------------------------- fake context

const dictionaries = new Map()
const contributions = []
const entries = []
const subscribers = []

/** The Host-side pin set, as the workspace controller publishes it. */
let pinnedSessionIds = []
/** Every pin and unpin the plugin asked the Host for. */
const pinCalls = []

let listSnapshot = { phase: 'pending', ids: [], byId: {} }
/** The unified Session UI status, as the Session plugin publishes it. */
let sessionStatus = new Map()

const ctx = {
  locale: {
    register: (ns, dicts) => {
      dictionaries.set(ns, dicts)
      return () => dictionaries.delete(ns)
    },
    bind: (ns) => (key, params) => {
      const table = dictionaries.get(ns)?.en ?? {}
      const template = table[key] ?? key
      if (!params) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    },
  },
  contextMenus: {
    register: (contribution) => {
      contributions.push(contribution)
      return () => contributions.splice(contributions.indexOf(contribution), 1)
    },
  },
  slots: {
    inject: (key, callback) => {
      // The slot system accepts one disposer or an iterable of them, so a
      // generator callback is drained here the way the renderer drains it.
      const result = callback()
      const disposers = []
      if (typeof result === 'function') disposers.push(result)
      else if (result !== undefined && typeof result[Symbol.iterator] === 'function') {
        for (const disposer of result) disposers.push(disposer)
      }
      return () => {
        for (const disposer of disposers.reverse()) {
          if (typeof disposer === 'function') disposer()
        }
      }
    },
    register: (options, component) => {
      entries.push({ options, component })
      return () => entries.splice(entries.indexOf({ options, component }), 1)
    },
  },
  sessions: {
    list: {
      getSnapshot: () => listSnapshot,
      subscribe: (listener) => {
        subscribers.push(listener)
        return () => subscribers.splice(subscribers.indexOf(listener), 1)
      },
    },
  },
  workspaces: {
    list: {
      getSnapshot: () => ({ pinnedSessionIds }),
    },
  },
  uiSession: {
    sessionStatus: {
      getSnapshot: () => sessionStatus,
    },
  },
  uiWorkspace: {
    pinSession: async (sessionId) => {
      pinCalls.push(`pin:${sessionId}`)
      pinnedSessionIds = [...new Set([...pinnedSessionIds, sessionId])]
    },
    unpinSession: async (sessionId) => {
      pinCalls.push(`unpin:${sessionId}`)
      pinnedSessionIds = pinnedSessionIds.filter((id) => id !== sessionId)
    },
  },
  effect: (callback) => callback(),
}

plugin.apply(ctx)

// ------------------------------------------------------------------ checks

const menu = contributions.find((contribution) => contribution.id === 'local.session.unread')
assert.ok(menu, 'the session menu contribution is registered')
assert.equal(menu.target, 'session')
assert.equal(menu.order, 460)

const leading = entries.find((entry) => entry.options.name === 'sidebar.session.row.leading')
assert.ok(leading, 'the marker occupies the leading seat')
const trailing = entries.find((entry) => entry.options.name === 'sidebar.session.row.trailing')
assert.ok(trailing, 'the fallback marker occupies the trailing seat')

const resolve = (sessionId) => menu.resolve({ sessionId, displayTitle: 'x' }, new AbortController().signal)
const mark = async (sessionId) => {
  await resolve(sessionId)[0].run()
}
const shown = (entry, sessionId) => entry.component({ sessionId, t: (key) => key }) !== null

// A fresh session offers "Mark as unread".
assert.equal(resolve('s1')[0].label, 'Mark as unread')
assert.equal(resolve('s1').length, 1)

// The entry carries a glyph, and the glyph is registered in the context
// menu's own icon slot — the way the shipped Pin, Rename and Archive
// entries carry theirs.
const glyphFor = (sessionId) => {
  const key = resolve(sessionId)[0].icon?.key
  if (key === undefined) return undefined
  return entries.find((entry) => entry.options.name === 'contextMenu.icon' && entry.options.key === key)
}
assert.ok(glyphFor('s1'), 'the menu glyph is registered for the action')

// Marking it persists the identity, offers "Mark as read", and floats the
// session to the top of the list.
await mark('s1')
assert.deepEqual(JSON.parse(storage.get(STORAGE_KEY)), ['s1'])
assert.equal(resolve('s1')[0].label, 'Mark as read')
assert.notEqual(
  resolve('s1')[0].icon.key,
  resolve('s2')[0].icon.key,
  'the read and unread entries carry different glyphs',
)
assert.ok(glyphFor('s1'), 'the read glyph is registered too')
assert.deepEqual(pinCalls, ['pin:s1'])
assert.deepEqual(JSON.parse(storage.get(PINNED_KEY)), ['s1'])
assert.deepEqual(pinnedSessionIds, ['s1'])

// The marker appears for the marked session, and for no other session.
assert.ok(shown(leading, 's1'), 'the marker shows')
assert.equal(shown(leading, 's2'), false, 'a read session shows no marker')
assert.equal(shown(trailing, 's1'), false, 'an idle row keeps the marker on the left')

// While the Session runs, the spinner owns the status cell, so the marker
// moves to the time label.
sessionStatus = new Map([['s1', { running: true, pendingInteraction: undefined, completionUnread: false }]])
assert.equal(shown(trailing, 's1'), true, 'a running row carries the marker beside the time')
sessionStatus = new Map([['s1', { running: false, pendingInteraction: undefined, completionUnread: true }]])
assert.equal(shown(trailing, 's1'), false, "DSH's own completion dot already marks the cell")
sessionStatus = new Map([['s1', { running: false, pendingInteraction: undefined, completionUnread: false }]])

// The main view tells which session is open; opening it clears the marker
// and releases the pin.
listSnapshot = {
  phase: 'ready',
  ids: ['s1', 's2'],
  byId: {
    s1: { retainedBy: { mainView: 1 } },
    s2: { retainedBy: {} },
  },
}
for (const listener of subscribers) listener()
assert.deepEqual(JSON.parse(storage.get(STORAGE_KEY)), [], 'opening the marked session clears the marker')
assert.equal(shown(leading, 's1'), false, 'the marker goes')
assert.deepEqual(pinCalls, ['pin:s1', 'unpin:s1'], 'opening the session releases the pin')
assert.deepEqual(pinnedSessionIds, [])

// Marking the open session shows the marker at once, and keeps the mark
// while the view stays there.
await mark('s1')
assert.deepEqual(JSON.parse(storage.get(STORAGE_KEY)), ['s1'])
assert.ok(shown(leading, 's1'), 'the marker shows for the open session')
assert.deepEqual(pinCalls, ['pin:s1', 'unpin:s1', 'pin:s1'])

listSnapshot = {
  phase: 'ready',
  ids: ['s1', 's2'],
  byId: {
    s1: { retainedBy: {} },
    s2: { retainedBy: { mainView: 1 } },
  },
}
for (const listener of subscribers) listener()
assert.deepEqual(JSON.parse(storage.get(STORAGE_KEY)), ['s1'], 'the mark survives leaving the session')
assert.ok(shown(leading, 's1'), 'the left-behind session shows the marker')
assert.equal(shown(leading, 's2'), false, 'the newly opened session shows no marker')
assert.deepEqual(pinCalls, ['pin:s1', 'unpin:s1', 'pin:s1'], 'leaving the session keeps the pin')

// Opening the marked session again clears it for good.
listSnapshot = {
  phase: 'ready',
  ids: ['s1', 's2'],
  byId: {
    s1: { retainedBy: { mainView: 1 } },
    s2: { retainedBy: {} },
  },
}
for (const listener of subscribers) listener()
assert.deepEqual(JSON.parse(storage.get(STORAGE_KEY)), [], 'opening it again clears the mark')
assert.deepEqual(pinCalls, ['pin:s1', 'unpin:s1', 'pin:s1', 'unpin:s1'])

// A pin the user placed by hand is never released by the plugin.
pinnedSessionIds = ['s2']
let callsBefore = pinCalls.length
await mark('s2')
assert.equal(pinCalls.length, callsBefore, 'a session the user pinned is not pinned again')
await mark('s2')
assert.equal(
  pinCalls.filter((call) => call === 'unpin:s2').length,
  0,
  'the user pin survives',
)

// A session that left the catalog is forgotten.
pinnedSessionIds = []
await mark('s2')
listSnapshot = { phase: 'ready', ids: ['s1'], byId: { s1: { retainedBy: { mainView: 1 } } } }
for (const listener of subscribers) listener()
assert.deepEqual(JSON.parse(storage.get(STORAGE_KEY)), [], 'a deleted session is forgotten')
assert.deepEqual(pinCalls.slice(-1), ['unpin:s2'], 'a deleted session releases the pin')

console.log('session-unread: all checks passed')
