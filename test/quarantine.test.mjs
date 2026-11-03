import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeConfig } from '../lib/guard.mjs'
import { createQuarantineWatcher } from '../lib/quarantine.mjs'

const IS_WIN = process.platform === 'win32'

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'guard-q-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

function makeWatcher(root, { mode = 'deny', config = {} } = {}) {
  const logs = []
  const cfg = normalizeConfig({ logFile: path.join(root, 'state.log'), ...config }, path.join(root, 'plugin'))
  const watcher = createQuarantineWatcher({
    config: cfg,
    mode,
    log: line => logs.push(line),
    resolveRoot: () => root,
  })
  const session = { id: 'session-test', header: { cwd: root } }
  return { watcher, logs, session }
}

const event = type => ({ type })

test('quarantine: new root temp entries are moved at turn end, pre-existing ones are not', async t => {
  const root = await fixture(t)
  await mkdir(path.join(root, 'tmp'), { recursive: true })
  await mkdir(path.join(root, '_tmp_old'), { recursive: true })
  await mkdir(path.join(root, 'docs'), { recursive: true })

  const { watcher, logs, session } = makeWatcher(root)
  await watcher.onSessionEvent(session, event('turn/start'))
  await mkdir(path.join(root, '_tmp_new'))
  await writeFile(path.join(root, 'build.log'), 'x')

  await watcher.onSessionEvent(session, event('turn/end'))

  assert.equal(await exists(path.join(root, '_tmp_new')), false)
  assert.equal(await exists(path.join(root, 'build.log')), false)
  assert.equal(await exists(path.join(root, '_tmp_old')), true)
  assert.equal(await exists(path.join(root, 'docs')), true)

  const quarantine = path.join(root, 'tmp', '_quarantine')
  const moved = await readdir(quarantine)
  assert.equal(moved.length, 2)
  assert.equal(moved.some(name => name.endsWith('_tmp_new')), true)
  assert.equal(moved.some(name => name.endsWith('build.log')), true)
  assert.equal(logs.some(line => line.startsWith('quarantine.moved')), true)
  assert.equal(logs.some(line => line.startsWith('quarantine.done')), true)
})

test('quarantine: warn mode logs would-move without touching entries', async t => {
  const root = await fixture(t)
  const { watcher, logs, session } = makeWatcher(root, { mode: 'warn' })
  await watcher.onSessionEvent(session, event('turn/start'))
  await mkdir(path.join(root, '_tmp_new'))

  await watcher.onSessionEvent(session, event('turn/end'))

  assert.equal(await exists(path.join(root, '_tmp_new')), true)
  assert.equal(logs.some(line => line.startsWith('quarantine.would-move')), true)
})

test('quarantine: allow-listed root entries and the unified temp dir are never swept', async t => {
  const root = await fixture(t)
  const { watcher, session } = makeWatcher(root, { config: { allowRootNames: ['work'] } })
  await watcher.onSessionEvent(session, event('turn/start'))
  await mkdir(path.join(root, 'work'))
  await mkdir(path.join(root, 'tmp'))

  await watcher.onSessionEvent(session, event('turn/end'))

  assert.equal(await exists(path.join(root, 'work')), true)
  assert.equal(await exists(path.join(root, 'tmp')), true)
})

test('quarantine: a missing baseline skips the sweep instead of moving everything', async t => {
  const root = await fixture(t)
  const { watcher, session } = makeWatcher(root)
  // Simulate a turn/end without a matching turn/start (e.g. resumed session).
  await mkdir(path.join(root, '_tmp_new'))
  await watcher.onSessionEvent(session, event('turn/end'))
  assert.equal(await exists(path.join(root, '_tmp_new')), true)
})

test('quarantine: dispose clears pending turns', async t => {
  const root = await fixture(t)
  const { watcher, session } = makeWatcher(root)
  await watcher.onSessionEvent(session, event('turn/start'))
  watcher.dispose()
  await mkdir(path.join(root, '_tmp_new'))
  await watcher.onSessionEvent(session, event('turn/end'))
  assert.equal(await exists(path.join(root, '_tmp_new')), true)
})

async function exists(target) {
  try {
    const { stat } = await import('node:fs/promises')
    await stat(target)
    return true
  } catch {
    return false
  }
}
