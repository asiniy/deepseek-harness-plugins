/**
 * Run every check of the chrome plugin.
 *
 * The repository's test.sh runs one file per plugin; this is the entry point
 * for that runner, and it also works on its own:
 *
 *     node chrome/test-all.mjs
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readdirSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEST_DIR = join(HERE, 'test')

const files = readdirSync(TEST_DIR)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => join(TEST_DIR, name))

if (files.length === 0) {
  console.error('no test files found')
  process.exit(1)
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })
process.exit(result.status ?? 1)
