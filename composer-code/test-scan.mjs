#!/usr/bin/env node
/**
 * Headless check of the code span scan.
 *
 * The scan is the rule that decides which backticks pair up into a code
 * span. It is the part of the plugin that has to agree with CommonMark: a
 * backtick opens a span wherever it stands, and a backtick that closed a
 * span cannot open another one.
 *
 * Usage:
 *     node composer-code/test-scan.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8')

// The plugin registers itself with the client module loader; the loader is
// stubbed, and the scan is read back from the file's own scope.
const registrations = []
const window = { __ModuleLoader__: { load: entry => registrations.push(entry) } }
const scanInlineSpans = new Function('window', `${source}\nreturn scanInlineSpans`)(window)

assert.equal(registrations.length, 1, 'the plugin did not register itself')
assert.equal(registrations[0].id, '@local/composer-code', 'the plugin registered under the wrong id')

const checks = []
/**
 * @param {string} name - what is checked.
 * @param {Function} body - the check.
 */
function check(name, body) {
  body()
  checks.push(name)
  console.log(`ok  ${name}`)
}

check('a backtick pair is one span', () => {
  assert.deepEqual(scanInlineSpans('`code`', 0), [[0, 6]])
})

check('a span opens wherever the backtick stands', () => {
  assert.deepEqual(scanInlineSpans('abc`code`', 0), [[3, 9]])
  assert.deepEqual(scanInlineSpans('(`code`)', 0), [[1, 7]])
})

check('two spans on one line', () => {
  assert.deepEqual(scanInlineSpans('a `one` b `two`', 0), [[2, 7], [10, 15]])
})

check('an unmatched backtick stays literal', () => {
  assert.deepEqual(scanInlineSpans('`unclosed', 0), [])
})

check('the closing backtick of a span cannot open another one', () => {
  // The text that follows the span "`abcde`": the closing backtick, the
  // comma, the space and a new backtick. The closing backtick closed the
  // span, so the new one has no partner.
  assert.deepEqual(scanInlineSpans('`, `', 1), [])
})

check('a span after a closing backtick is still found', () => {
  // "`a` `b`": the second pair is a span of its own.
  assert.deepEqual(scanInlineSpans('`a` `b`', 0), [[0, 3], [4, 7]])
})

console.log(`\n${checks.length} checks passed`)
