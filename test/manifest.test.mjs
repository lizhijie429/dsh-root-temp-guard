import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * DSH reads the plugin manifest and source with strict JSON/ESM parsers; a
 * UTF-8 BOM that editors add silently breaks the profile loader ("Unexpected
 * token '\uFEFF'"). Keep every text file BOM-free.
 */
const TEXT_FILES = [
  'package.json',
  'index.mjs',
  'lib/guard.mjs',
  'lib/quarantine.mjs',
  'README.md',
  'LICENSE',
  '.gitattributes',
  '.gitignore',
  'test/guard.test.mjs',
  'test/apply.test.mjs',
  'test/quarantine.test.mjs',
  'test/manifest.test.mjs',
]

test('package.json parses as strict JSON (no BOM)', () => {
  const raw = readFileSync(`${ROOT}/package.json`, 'utf8')
  assert.equal(raw.charCodeAt(0) === 0xfeff, false)
  const pkg = JSON.parse(raw)
  assert.equal(pkg.name, 'dsh-root-temp-guard')
  assert.equal(typeof pkg.version, 'string')
})

test('all repository text files are BOM-free', () => {
  for (const relative of TEXT_FILES) {
    const bytes = readFileSync(`${ROOT}/${relative}`)
    const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    assert.equal(hasBom, false, `${relative} starts with a UTF-8 BOM`)
  }
})
