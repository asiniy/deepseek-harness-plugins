#!/usr/bin/env node
/**
 * Live check of the composer-code browser half.
 *
 * The plugin decorates the Lexical editor of the Web UI composer, so the
 * only faithful test is against a running DSH. This script drives the
 * composer of the open Web UI tab through the Chrome DevTools Protocol,
 * types with real key events, and asserts what the user sees.
 *
 * It needs:
 *   - `dsh web` running (the harness serves the Web UI on 127.0.0.1:3080),
 *   - the Chrome instance the harness drives (127.0.0.1:9222),
 *   - the @local/composer-code bundle installed in the web profile.
 *
 * Usage:
 *     node composer-code/test-live.mjs
 *
 * Exit code 0 means every check passed.
 */

import assert from 'node:assert/strict'

const CHROME = 'http://127.0.0.1:9222'
const UI = '127.0.0.1:3080'

// --------------------------------------------------------------- chrome cdp

const targets = await (await fetch(`${CHROME}/json/list`)).json()
const target = targets.find(t => (t.url || '').includes(UI))
assert.ok(target, `no ${UI} tab in Chrome`)

const ws = new WebSocket(target.webSocketDebuggerUrl)
let messageId = 0
const pending = new Map()
ws.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  const resolve = pending.get(message.id)
  if (resolve === undefined) return
  pending.delete(message.id)
  resolve(message)
})
await new Promise(resolve => ws.addEventListener('open', resolve))

/**
 * @param {string} method - the CDP method.
 * @param {object} params - the CDP parameters.
 * @returns {Promise<object>} the CDP result.
 */
function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++messageId
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP timeout: ${method}`))
    }, 20000)
    pending.set(id, message => {
      clearTimeout(timer)
      resolve(message)
    })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

/**
 * @param {string} expression - the expression to run in the page.
 * @returns {Promise<any>} the value of the expression.
 */
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (result.result?.exceptionDetails) {
    throw new Error(result.result.exceptionDetails.exception?.description ?? 'evaluation failed')
  }
  return result.result?.result?.value
}

// ------------------------------------------------------------------ helpers

/**
 * @param {number} ms - how long to wait.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * The app replaces the composer element when the session mounts, so the
 * focus has to be taken again before every keystroke.
 */
async function focusComposer() {
  await evaluate(`(() => {
    const el = document.querySelector('[data-composer-input]')
    if (el !== null && document.activeElement !== el) el.focus()
    return true
  })()`)
}

/**
 * @param {string} text - the text to type, one key at a time.
 */
async function type(text) {
  await focusComposer()
  for (const character of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: character, text: character, unmodifiedText: character })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: character })
    await sleep(90)
  }
}

/** Shift+Enter: the composer's line break. */
async function lineBreak() {
  await focusComposer()
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 8, text: '\r' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 8 })
  await sleep(150)
}

/** Backspace. */
async function backspace() {
  await focusComposer()
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
  await sleep(130)
}

/** Empty the composer. */
async function clearComposer() {
  await evaluate(`(() => {
    const el = document.querySelector('[data-composer-input]')
    el.focus()
    const ed = el.__lexicalEditor
    ed.update(() => {
      const state = ed._pendingEditorState ?? ed._editorState
      state._nodeMap.get('root').clear()
    }, { discrete: true })
    return true
  })()`)
  await sleep(400)
}

/**
 * @returns {Promise<object>} the composer's html, text and blocks.
 */
async function composer() {
  return await evaluate(`(() => {
    const el = document.querySelector('[data-composer-input]')
    const ed = el.__lexicalEditor
    return {
      html: el.innerHTML,
      text: el.textContent,
      blocks: ed.getEditorState().read(() => {
        const root = ed._editorState._nodeMap.get('root')
        return root.getChildren().map(c => c.getTextContent())
      }),
    }
  })()`)
}

// --------------------------------------------------------------------- boot

await send('Page.enable')
await send('Page.reload', { ignoreCache: true })
let ready = false
for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
  await sleep(1000)
  ready = await evaluate(`(() => { const el = document.querySelector('[data-composer-input]'); return !!(el && el.__lexicalEditor) })()`)
}
assert.ok(ready, 'the composer never showed up')
await sleep(1500)

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

// --------------------------------------------------------------- the checks

await check('inline code opens a chip, backticks stay plain', async () => {
  await clearComposer()
  await type('run `npm test` here')
  const state = await composer()
  assert.match(state.html, /class="dsh-inline-code"[^>]*>npm test</, 'the code is not in a chip')
  assert.doesNotMatch(state.html, /dsh-inline-code[^>]*>[^<]*`/, 'the backticks are inside the chip')
  assert.equal(state.text, 'run `npm test` here', 'the message lost its markdown')
})

await check('the caret stays behind the closing backtick', async () => {
  await type('X')
  const state = await composer()
  assert.equal(state.text, 'run `npm test` hereX', 'the text did not land after the chip')
})

await check('the code inside the chip is editable', async () => {
  const before = await composer()
  // The chip starts after "run `": walk the caret back into it.
  const steps = before.text.length - 'run `'.length
  for (let step = 0; step < steps; step += 1) {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 })
    await sleep(70)
  }
  await type('Z')
  const state = await composer()
  assert.equal(state.text, 'run `Znpm test` hereX', 'the chip did not take the edit')
  assert.match(state.html, /class="dsh-inline-code"[^>]*>Znpm test</, 'the chip lost its shape')
})

await check('a fence opens a grey box with a line for the rest of the message', async () => {
  await clearComposer()
  await type('```')
  await type('echo hi')
  const state = await composer()
  assert.match(state.html, /class="dsh-code-block"/, 'the code box is not painted')
  assert.match(state.html, /class="dsh-code-fence"[^>]*>.*?font-size: 0/, 'the fence line is not hidden')
  assert.equal(state.blocks.length, 3, 'the line for the rest of the message is missing')
  assert.equal(state.blocks[1], 'echo hi', 'the code did not land in the box')
  assert.equal(state.text, '```echo hi', 'the message lost its markdown')
})

await check('the code stays in the box over several lines', async () => {
  await lineBreak()
  await type('echo there')
  const state = await composer()
  assert.equal(state.blocks[1], 'echo hi\necho there', 'the second line left the box')
})

await check('backspacing the code keeps the keystrokes visible', async () => {
  for (let step = 0; step < 20; step += 1) await backspace()
  await sleep(500)
  await type('Q')
  const state = await composer()
  assert.match(state.text, /Q/, 'the keystroke did not reach the message')
  const visible = await evaluate(`(() => {
    const el = document.querySelector('[data-composer-input]')
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode()) !== null) {
      if (!node.textContent.includes('Q')) continue
      const style = getComputedStyle(node.parentElement)
      return parseFloat(style.fontSize) > 0 && style.display !== 'none' && style.visibility !== 'hidden'
    }
    return false
  })()`)
  assert.equal(visible, true, 'the keystroke went into text that is not drawn')
})

await check('a closing backtick does not open a second span', async () => {
  await clearComposer()
  await type('`abcde`, `')
  const state = await composer()
  const chips = (state.html.match(/dsh-inline-code/g) || []).length
  assert.equal(chips, 1, 'the closing backtick opened a second span')
  assert.equal(state.text, '`abcde`, `', 'the message lost its markdown')
})

await check('an empty code box is removed with backspace', async () => {
  await clearComposer()
  await type('```')
  await sleep(300)
  const opened = await composer()
  assert.equal(opened.blocks.length, 3, 'the fence did not open a box')
  await backspace()
  await sleep(400)
  const state = await composer()
  assert.equal(state.blocks.length, 1, 'the empty code box is still there')
  assert.equal(state.text, '', 'the fence stayed in the message')
  await type('X')
  const after = await composer()
  assert.equal(after.text, 'X', 'the keystroke did not land')
})

await clearComposer()
console.log(`\n${checks.length} checks passed`)
ws.close()
process.exit(0)
