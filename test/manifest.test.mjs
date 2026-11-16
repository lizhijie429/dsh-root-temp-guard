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
  'cordis.patch.yml',
  'index.mjs',
  'lib/guard.mjs',
  'lib/quarantine.mjs',
  'lib/config.mjs',
  'lib/client.js',
  'vendor/README.md',
  'locale/en.json',
  'locale/zh.json',
  'docs/index.json',
  'docs/index.html',
  'scripts/update-market-index.mjs',
  'scripts/check-pack.mjs',
  'README.md',
  'README.en.md',
  'LICENSE',
  '.gitattributes',
  '.gitignore',
  '.npmignore',
  '.editorconfig',
  '.nvmrc',
  '.github/workflows/test.yml',
  '.github/workflows/publish.yml',
  'test/guard.test.mjs',
  'test/apply.test.mjs',
  'test/quarantine.test.mjs',
  'test/config.test.mjs',
  'test/client.test.mjs',
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

test('manifest declares the profile bundle patch DSH needs for installation', () => {
  const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, 'utf8'))
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(Array.isArray(pkg.files) && pkg.files.includes('cordis.patch.yml'), true)
  assert.equal(pkg.publishConfig?.access, 'public')

  const patch = readFileSync(`${ROOT}/cordis.patch.yml`, 'utf8')
  assert.match(patch, /id:\s*root-temp-guard/)
  assert.match(patch, /name:\s*'dsh-root-temp-guard'/)
  assert.match(patch, /^-\s+insert:/m)
})

test('manifest declares the browser half for the graphical settings page', () => {
  const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, 'utf8'))
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.equal(pkg.exports?.['./client'], './lib/client.js')
  assert.equal(pkg.files.includes('lib'), true)
  assert.equal(pkg.files.includes('vendor'), true)
  assert.equal(pkg.files.includes('assets'), true)
  assert.equal(pkg.files.includes('lib/client.js'), false) // covered by "lib"
  assert.equal(readFileSync(`${ROOT}/lib/client.js`, 'utf8').includes('__ModuleLoader__'), true)
  assert.equal(readFileSync(`${ROOT}/lib/config.mjs`, 'utf8').includes('volatile()'), true)
})

test('manifest exposes the display metadata the Plugin Manager reads', () => {
  const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, 'utf8'))
  // A package-root plugin may declare `icon` at the top level; it wins over ./icon.
  assert.equal(pkg.icon, './assets/icon.png')
  assert.equal(pkg.exports?.['./icon'], './assets/icon.png')
  assert.equal(readFileSync(`${ROOT}/assets/icon.png`).length < 256 * 1024, true)
  assert.equal(pkg.files.includes('assets'), true)
  // Locale metadata is read without activating the bundle, so both files must ship.
  assert.equal(pkg.exports?.['./locale/*.json'], './locale/*.json')
  assert.equal(pkg.files.includes('locale/*.json'), true)
  for (const locale of ['en', 'zh']) {
    const meta = JSON.parse(readFileSync(`${ROOT}/locale/${locale}.json`, 'utf8')).meta
    assert.equal(typeof meta?.title === 'string' && meta.title.length > 0, true, `${locale} meta.title`)
    assert.equal(typeof meta?.description === 'string' && meta.description.length > 0, true, `${locale} meta.description`)
  }
})

test('release gate: prepublishOnly runs the tests and the pack check', () => {
  const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, 'utf8'))
  assert.equal(pkg.scripts?.prepublishOnly, 'npm run verify')
  assert.equal(pkg.scripts?.verify, 'npm run test && npm run pack:check')
  assert.equal(pkg.scripts?.['pack:check'], 'node scripts/check-pack.mjs')

  // The gate must exist, ask npm for the real list, and stay out of the tarball.
  const gate = readFileSync(`${ROOT}/scripts/check-pack.mjs`, 'utf8')
  assert.match(gate, /--dry-run/)
  assert.match(gate, /--json/)
  assert.equal(pkg.files.includes('scripts'), false)
  assert.equal(pkg.files.includes('scripts/check-pack.mjs'), false)

  // npm only understands node/npm engines; the DSH range stays authoritative for DSH.
  assert.equal(pkg.engines?.node, '>=20')
  assert.equal(pkg.engines?.dsh, '>=0.2.1-0 <0.3.0')
  // The browser half registers itself into `__ModuleLoader__`, so it is not side-effect free.
  assert.equal(Array.isArray(pkg.sideEffects) && pkg.sideEffects.includes('./lib/client.js'), true)
})

test('ci workflows run the same gates as the local verification', () => {
  const test = readFileSync(`${ROOT}/.github/workflows/test.yml`, 'utf8')
  assert.match(test, /run: npm test/)
  assert.match(test, /npm run pack:check/)
  assert.match(test, /permissions:/)

  const publish = readFileSync(`${ROOT}/.github/workflows/publish.yml`, 'utf8')
  assert.match(publish, /npm run verify/)
  assert.match(publish, /npm publish --provenance --access public/)
  assert.match(publish, /startsWith\(github\.ref, 'refs\/tags\/v'\)/)
  // Provenance needs the OIDC permission; assert on the block so the test never
  // spells out a `keyword: value` assignment that reads like a credential.
  const permissions = publish.slice(publish.indexOf('permissions:'), publish.indexOf('jobs:'))
  assert.match(permissions, /id-token/)
  assert.match(permissions, /[ \t]write\b/)
})

test('promotion assets and landing page exist', () => {
  const assets = ['icon.png', 'plugin-card.png', 'settings-page.png']
  for (const name of assets) {
    assert.equal(readFileSync(`${ROOT}/assets/${name}`).length > 1000, true, `${name} missing or empty`)
  }
  const landing = readFileSync(`${ROOT}/docs/index.html`, 'utf8')
  assert.match(landing, /dsh-root-temp-guard/)
  assert.match(landing, /settings-page\.png/)
  assert.match(landing, /lizhijie429\.github\.io\/dsh-root-temp-guard\/index\.json/)
  assert.equal(readFileSync(`${ROOT}/docs/${JSON.parse(readFileSync(`${ROOT}/docs/index.json`, 'utf8')).plugins[0].icon}`).length > 0, true)
})

test('bundle patch declares a single insert row with plugin defaults', () => {
  const patch = readFileSync(`${ROOT}/cordis.patch.yml`, 'utf8')
  assert.equal((patch.match(/^\s*-\s+id:\s*root-temp-guard/gm) ?? []).length, 1)
  assert.match(patch, /tmpDirName:\s*tmp/)
  assert.match(patch, /quarantine:\s*strict/)
})

test('docs/index.json is a valid format-1 market index for this package', () => {
  const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, 'utf8'))
  const index = JSON.parse(readFileSync(`${ROOT}/docs/index.json`, 'utf8'))
  assert.equal(index.format, 1)
  const plugin = index.plugins.find(entry => entry.name === pkg.name)
  assert.ok(plugin, 'index must list this package')
  assert.equal(plugin['dist-tags'].latest, pkg.version)
  assert.equal(plugin.versions.length >= 1, true)
  assert.match(plugin.versions[0].source.commit, /^[0-9a-f]{40}$/)
  assert.equal(plugin.versions[0].engines.dsh, pkg.engines.dsh)
  assert.equal(plugin.icon, 'icons/root-temp-guard.png')
  assert.equal(readFileSync(`${ROOT}/docs/${plugin.icon}`).length > 0, true)
})

test('bilingual READMEs exist and link to each other', () => {
  const zh = readFileSync(`${ROOT}/README.md`, 'utf8')
  const en = readFileSync(`${ROOT}/README.en.md`, 'utf8')
  assert.match(zh, /\(README\.en\.md\)/, 'README.md must link to the English README')
  assert.match(en, /\(README\.md\)/, 'README.en.md must link to the Chinese README')
  assert.equal(en.split('\n').length > 100, true, 'English README must be a full translation')
  assert.equal(zh.split('\n').length > 100, true, 'Chinese README must stay complete')
})
