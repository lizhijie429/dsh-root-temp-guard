#!/usr/bin/env node
/**
 * Release gate for the published tarball.
 *
 * `package.json` declares a `files` whitelist, and a root `.npmignore` only
 * takes over when that whitelist is absent — so this script does not restate
 * either list. It asks npm for the **actual** packed file list
 * (`npm pack --dry-run --json`) and checks the three invariants that matter:
 *
 *   1. every runtime file that must ship is present;
 *   2. nothing dev-only, repository-local or secret-shaped is included;
 *   3. no `files` entry has gone stale (an entry that matches nothing).
 *
 * Run it through npm so `npm_execpath` resolves the same npm that runs the
 * lifecycle:  npm run pack:check   (or `npm run verify`)
 *
 * @module dsh-root-temp-guard/check-pack
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Runtime files that must be in the tarball for the plugin to work. */
const REQUIRED = [
  'package.json',
  'index.mjs',
  'cordis.patch.yml',
  'lib/client.js',
  'lib/config.mjs',
  'lib/guard.mjs',
  'lib/quarantine.mjs',
  'locale/en.json',
  'locale/zh.json',
  'assets/icon.png',
  'vendor/schemastery/index.mjs',
  'vendor/cosmokit/index.mjs',
  'README.md',
  'README.en.md',
  'LICENSE',
]

/** Directory prefixes that must never be published. */
const FORBIDDEN_PREFIXES = ['state/', 'docs/', 'test/', 'scripts/', '.github/', 'node_modules/', 'tmp/']

/** Exact repository/tool files that must never be published. */
const FORBIDDEN_NAMES = [
  '.gitignore',
  '.gitattributes',
  '.npmignore',
  '.editorconfig',
  '.nvmrc',
  '.dsh/privacy-guard-whitelist.json',
]

/** Name shapes that must never be published (logs, packs, credentials). */
const FORBIDDEN_PATTERNS = [
  /\.log$/i,
  /\.tgz$/i,
  /\.tar\.gz$/i,
  /(^|\/)\.env/i,
  /(^|\/)\.npmrc$/i,
]

/**
 * Locate the npm CLI without ever needing a shell: `npm run` exports
 * `npm_execpath`, and a standard Node installation keeps npm beside the binary.
 * @returns {string | undefined}
 */
function npmCliPath() {
  const fromEnv = process.env.npm_execpath
  // npm_execpath is set by every package manager (pnpm/yarn too), so only trust
  // a path that is actually npm's own CLI.
  if (typeof fromEnv === 'string' && fromEnv.length > 0 && /npm/i.test(basename(fromEnv))) {
    return fromEnv
  }
  const beside = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return existsSync(beside) ? beside : undefined
}

/**
 * The real packed file list, straight from npm.
 * @returns {string[]} tarball-relative paths, `/`-separated.
 */
function packedFiles() {
  const cli = npmCliPath()
  if (cli === undefined) {
    throw new Error('cannot locate the npm CLI; run this check through npm: npm run pack:check')
  }
  const result = spawnSync(process.execPath, [cli, 'pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = String(result.stderr ?? result.stdout ?? '').trim().split('\n').slice(-3).join(' ')
    throw new Error(`npm pack exited with ${result.status}: ${detail.slice(0, 400)}`)
  }

  const parsed = JSON.parse(result.stdout)
  const entry = Array.isArray(parsed) ? parsed[0] : parsed
  if (!Array.isArray(entry?.files)) throw new Error('npm pack --json returned no file list')
  return entry.files.map(item => String(item.path).replace(/\\/g, '/'))
}

/** Whether one `files` entry of the manifest matches a packed path. */
function matchesEntry(path, entry) {
  if (!entry.includes('*')) return path === entry || path.startsWith(`${entry}/`)
  const source = entry
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*')
  return new RegExp(`^${source}$`).test(path)
}

const problems = []
let files
try {
  files = packedFiles()
} catch (error) {
  console.error(`pack:check  FAILED to read the packed list: ${error?.message ?? error}`)
  process.exit(1)
}

const present = new Set(files)
for (const path of REQUIRED) {
  if (!present.has(path)) problems.push(`missing from the tarball: ${path}`)
}
for (const path of files) {
  if (FORBIDDEN_PREFIXES.some(prefix => path.startsWith(prefix))) {
    problems.push(`dev-only path would be published: ${path}`)
  }
  if (FORBIDDEN_NAMES.includes(path)) problems.push(`repository file would be published: ${path}`)
  if (FORBIDDEN_PATTERNS.some(pattern => pattern.test(path))) {
    problems.push(`log/pack/credential-shaped path would be published: ${path}`)
  }
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
for (const entry of Array.isArray(manifest.files) ? manifest.files : []) {
  if (!files.some(path => matchesEntry(path, entry))) {
    problems.push(`package.json "files" entry matches nothing: ${entry}`)
  }
}

console.log(`pack:check  ${manifest.name}@${manifest.version} → ${files.length} files`)
for (const path of [...files].sort()) console.log(`  ${path}`)

if (problems.length > 0) {
  console.error(`pack:check  ${problems.length} problem(s):`)
  for (const problem of problems) console.error(`  ✗ ${problem}`)
  process.exit(1)
}
console.log('pack:check  ok')
