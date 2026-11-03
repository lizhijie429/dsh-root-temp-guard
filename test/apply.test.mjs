import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { apply } from '../index.mjs'

/** Platform-neutral fixture root, so the suite also runs on POSIX. */
const ROOT = process.platform === 'win32' ? 'D:\\work\\repo' : '/home/user/repo'

/**
 * Capture the guard registered by apply() with a mocked context.
 * `options.get` overrides service lookup; `options.cwd` sets the current working
 * directory returned by the workingDirectory service.
 */
function mount(options = {}) {
  const captured = { guard: undefined, disposed: false }
  const ctx = {
    tools: {
      guard(guard) {
        captured.guard = guard
        return () => {
          captured.disposed = true
        }
      },
    },
    get:
      options.get ??
      (service => {
        if (service === 'sandboxPolicy') return { resolve: () => ({ workspaceRoot: ROOT }) }
        if (service === 'workingDirectory') return { get: () => options.cwd ?? ROOT }
        return undefined
      }),
    on: () => {},
  }
  apply(ctx, { logFile: 'state/apply-test.log', ...(options.config ?? {}) })
  return captured
}

function exec(name, args) {
  return { name, arguments: args, agent: { session: { header: { cwd: ROOT } } } }
}

test('apply registers one global guard that denies root temp paths', () => {
  const { guard } = mount()
  assert.equal(typeof guard, 'function')
  assert.match(guard(exec('write', { file_path: '_tmp_probe/x.txt', content: 'x' })), /_tmp_probe/)
  assert.match(guard(exec('pwsh', { command: 'mkdir _tmp_probe' })), /_tmp_probe/)
})

test('apply guard allows tmp/ and ordinary repository paths', () => {
  const { guard } = mount()
  assert.equal(guard(exec('write', { file_path: 'tmp/20261103-x/a.txt' })), undefined)
  assert.equal(guard(exec('write', { file_path: 'AGENTS.md' })), undefined)
  assert.equal(guard(exec('pwsh', { command: 'mkdir tmp/20261103-x' })), undefined)
})

test('guard falls back to session.header.cwd when services are absent', () => {
  const { guard } = mount({ get: () => undefined })
  assert.match(guard(exec('write', { file_path: '_tmp_probe/x.txt' })), /_tmp_probe/)
})

test('C1: workingDirectory cwd is used as the relative-path base', () => {
  const { guard } = mount({ cwd: path.join(ROOT, 'tmp') })
  assert.match(guard(exec('write', { file_path: '../_tmp_x/a.txt' })), /_tmp_x/)
  assert.equal(guard(exec('write', { file_path: '20261103-x/out.txt' })), undefined)
})

test('config.workspaceRoot overrides the session-resolved root', () => {
  const pinned = process.platform === 'win32' ? 'D:\\other\\ws' : '/home/user/other-ws'
  const { guard } = mount({ get: () => undefined, config: { workspaceRoot: pinned } })
  assert.match(guard(exec('write', { file_path: path.join(pinned, '_tmp_x', 'a.txt') })), /_tmp_x/)
  // The session cwd is no longer the boundary in pinned-root mode.
  assert.equal(guard(exec('write', { file_path: 'tmp/20261103-x/a.txt' })), undefined)
})

test('guard fails open when the evaluator throws', () => {
  const { guard } = mount()
  const hostile = {
    get name() {
      throw new Error('boom')
    },
    arguments: { file_path: '_tmp_x/a.txt' },
    agent: { session: { header: { cwd: ROOT } } },
  }
  assert.equal(guard(hostile), undefined)
})

test('lifecycle: registers through ctx.effect and disposes the guard with the plugin', () => {
  const events = []
  let fiberDisposer
  const ctx = {
    tools: {
      guard() {
        events.push('guard')
        return () => {
          events.push('unregistered')
        }
      },
    },
    get: () => undefined,
    effect(execute) {
      events.push('effect')
      fiberDisposer = execute()
      return () => {}
    },
  }
  apply(ctx, { logFile: 'state/apply-test.log' })
  assert.deepEqual(events, ['effect', 'guard'])
  assert.equal(typeof fiberDisposer, 'function')
  fiberDisposer()
  fiberDisposer() // idempotent: the disposer must not run twice
  assert.deepEqual(events, ['effect', 'guard', 'unregistered'])
})
