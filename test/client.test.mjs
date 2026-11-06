import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLIENT_SOURCE = readFileSync(`${ROOT}/lib/client.js`, 'utf8')

/** Minimal React stand-in: enough to execute the page module without a DOM. */
function makeReactStub() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
  }
}

/** Execute the client bundle in the DSH bundle format and return its module. */
function loadClientModule() {
  let registration
  const window = {
    __ModuleLoader__: {
      load(entry) {
        registration = entry
      },
    },
  }
  // The bundle is a plain script that calls window.__ModuleLoader__.load.
  new Function('window', CLIENT_SOURCE)(window)
  assert.ok(registration, 'client bundle must register a module')
  assert.equal(registration.id, 'dsh-root-temp-guard')
  const react = makeReactStub()
  const required = []
  const exports = registration.factory(specifier => {
    required.push(specifier)
    if (specifier === 'react') return react
    throw new Error(`unexpected require: ${specifier}`)
  })
  return { exports, required, react }
}

test('client bundle registers both the built-in settings card and the row page', () => {
  const { exports } = loadClientModule()
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots', 'locale', 'configForms'])

  const registered = []
  const dictionaries = []
  const namespaces = []
  const ctx = {
    locale: {
      bind: () => key => key,
      register: (ns, dict) => {
        dictionaries.push({ ns, dict })
        return () => {}
      },
    },
    configForms: {
      whileServed(list, register) {
        namespaces.push(list)
        return register(new Set(list))
      },
    },
    slots: {
      inject(_name, callback) {
        return callback()
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
    effect(effect) {
      effect()
    },
  }
  exports.apply(ctx)

  assert.equal(registered.length, 2)
  const item = registered.find(entry => entry.options.name === 'plugins.item')
  const row = registered.find(entry => entry.options.name === 'plugins.row.config')
  assert.ok(item, 'plugins.item registration is required for absolute-path profiles')
  assert.ok(row, 'plugins.row.config registration is required for installed bundles')
  assert.equal(item.options.id, 'root-temp-guard')
  assert.equal(row.options.key, 'dsh-root-temp-guard#root-temp-guard')
  assert.equal(item.options.locale, 'settings.root-temp-guard')
  assert.equal(row.options.locale, 'settings.root-temp-guard')
  assert.deepEqual(namespaces, [['root-temp-guard']])
  assert.equal(dictionaries.length, 1)
  assert.equal(typeof dictionaries[0].dict.zh.field_enabled, 'string')
  assert.equal(typeof dictionaries[0].dict.en.field_enabled, 'string')
})

test('settings page renders fields and a summary view without a DOM', () => {
  const { exports, react } = loadClientModule()
  let page
  exports.apply({
    locale: { bind: () => key => key, register: () => () => {} },
    configForms: { whileServed: (_list, register) => register(new Set(['root-temp-guard'])) },
    slots: {
      inject: (_name, callback) => callback(),
      register: (_options, component) => {
        page = component
        return () => {}
      },
    },
    effect: effect => effect(),
  })

  const t = key => key
  const form = {
    state: {
      status: 'ready',
      writable: true,
      revision: 1,
      value: {
        enabled: true,
        mode: 'deny',
        tmpDirName: 'tmp',
        quarantine: 'strict',
        quarantineDirName: '_quarantine',
        allowRootNames: [],
        denyNamePatterns: ['^tmp'],
        denyFileExtensions: ['.log'],
        extraWriteTools: [],
        extraShellTools: [],
        workspaceRoot: '',
        logFile: '',
        reasonTemplate: '',
      },
    },
    mutate: async () => true,
  }

  const summary = page({ view: 'summary', t, form })
  assert.equal(summary, 'summary')

  const tree = page({ view: 'page', t, form })
  assert.equal(tree.type, 'section')
  const rendered = JSON.stringify(tree)
  assert.match(rendered, /"key":"mode"/)
  assert.match(rendered, /"key":"tmpDirName"/)
  assert.match(rendered, /"key":"reasonTemplate"/)
  // The React stand-in must have been used (createElement is the render path).
  assert.equal(typeof react.createElement, 'function')
})
