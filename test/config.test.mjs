import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Config, currentConfigValue } from '../lib/config.mjs'
import { DEFAULTS } from '../lib/guard.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

test('Config schema validates with defaults and exposes volatile meta for settings forms', () => {
  assert.equal(typeof Config['~standard']?.validate, 'function')
  assert.equal(Config.meta?.volatile, true)

  const result = Config['~standard'].validate({})
  assert.equal(result.issues, undefined)
  const value = currentConfigValue(result.value)
  assert.equal(value.enabled, DEFAULTS.enabled)
  assert.equal(value.mode, DEFAULTS.mode)
  assert.equal(value.tmpDirName, DEFAULTS.tmpDirName)
  assert.deepEqual(value.denyFileExtensions, DEFAULTS.denyFileExtensions)
  assert.equal(value.quarantine, DEFAULTS.quarantine)

  const json = Config.toJSON()
  assert.match(JSON.stringify(json), /"volatile":true/)
  assert.match(JSON.stringify(json), /"enabled"/)
})

test('Config accepts a legacy partial/odd value without failing the loader', () => {
  const result = Config['~standard'].validate({ enabled: 'false', tmpDirName: 'tmp.', unknownKey: 1 })
  assert.equal(result.issues, undefined)
})
