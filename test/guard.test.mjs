import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, evaluateTarget, applyPatchPaths, normalizeConfig } from '../lib/guard.mjs'

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const IS_WIN = process.platform === 'win32'
/** Platform-neutral fixture roots, so the suite also runs on POSIX. */
const ROOT = IS_WIN ? 'D:\\work\\repo' : '/home/user/repo'
const OTHER_ROOT = IS_WIN ? 'D:\\work\\other' : '/home/user/other'
const config = normalizeConfig({ logFile: 'state/test.log' }, PLUGIN_DIR)

const inRepo = (...parts) => path.join(ROOT, ...parts)
const exec = (name, args) => ({ name, arguments: args, agent: { session: { header: { cwd: ROOT } } } })

/** Evaluate against ROOT with a configurable cwd / platform. */
function check(name, args, cwd = ROOT, cfg = config, platform = process.platform) {
  return evaluate(exec(name, args), cfg, { root: ROOT, cwd, platform })
}

test('default config: root is the session workspace, temp dir name is tmp/', () => {
  const other = evaluate(exec('write', { file_path: '_tmp_probe/x.txt' }), config, { root: OTHER_ROOT, cwd: OTHER_ROOT })
  assert.match(other, /_tmp_probe/)
  assert.match(check('write', { file_path: '_tmp_probe/x.txt' }), /_tmp_probe/)
  assert.match(check('write', { file_path: inRepo('_tmp_probe', 'x.txt') }), /_tmp_probe/)
  assert.equal(check('write', { file_path: 'tmp/20261103-x/a.txt' }), undefined)
})

test('default config: denies root-level temp names and temp extensions', () => {
  assert.match(check('write', { file_path: 'tmp_lead/log.txt' }), /tmp_lead/)
  assert.match(check('write', { file_path: 'scratch/a.md' }), /scratch/)
  assert.match(check('write', { file_path: 'build.log' }), /build\.log/)
  assert.match(check('write', { file_path: 'scratch.tmp' }), /scratch\.tmp/)
})

test('default config: hidden (dot-prefixed) temp names and dotfiles are denied', () => {
  assert.match(check('write', { file_path: '.tmp_probe/a.txt' }), /\.tmp_probe/)
  assert.match(check('write', { file_path: '.scratch/a.txt' }), /\.scratch/)
  assert.match(check('write', { file_path: '.temp/a.txt' }), /\.temp/)
  assert.match(check('write', { file_path: '.log' }), /\.log/)
})

test('default config: allows normal repository paths', () => {
  assert.equal(check('write', { file_path: 'AGENTS.md' }), undefined)
  assert.equal(check('write', { file_path: path.join('docs', '01-方案.md') }), undefined)
  assert.equal(check('write', { file_path: path.join('backend', 'pom.xml') }), undefined)
})

test('default denial text is project-agnostic and names the configured temp dir', () => {
  const reason = check('write', { file_path: '_tmp_probe/x.txt' })
  assert.match(reason, /_tmp_probe/)
  assert.match(reason, /tmp\/<任务名>\//)
})

test('paths outside the workspace root are not our business', () => {
  assert.equal(check('write', { file_path: path.join(OTHER_ROOT, '_tmp_x.txt') }), undefined)
  assert.equal(check('write', { file_path: '../other/_tmp_x.txt' }), undefined)
})

test('regression: dot-dot-prefixed temp names in the root are still denied', () => {
  assert.match(check('write', { file_path: '.._tmp_probe/x.txt' }), /\.\._tmp_probe/)
  assert.match(check('write', { file_path: '..temp_probe/x.txt' }), /\.\.temp_probe/)
  assert.match(check('pwsh', { command: 'mkdir .._tmp_probe' }), /\.\._tmp_probe/)
})

test('C1: relative paths resolve against the CURRENT working directory, not the root', () => {
  // Model first switched cwd to <root>/tmp, then wrote "../_tmp_x/a.txt"
  // → really <root>/_tmp_x/a.txt; the guard must deny it.
  const cwd = inRepo('tmp')
  assert.match(check('write', { file_path: '../_tmp_x/a.txt' }, cwd), /_tmp_x/)
  // A temp-looking path written inside a normal subdirectory stays legal.
  assert.equal(check('write', { file_path: '_tmp/y.txt' }, inRepo('sub')), undefined)
  // shell workdir is resolved against the current cwd too.
  assert.equal(check('pwsh', { command: 'mkdir _tmp_y', workdir: 'tmp' }), undefined)
})

test('C2: Windows extended-length / device prefixes cannot bypass the guard', { skip: !IS_WIN }, () => {
  const target = inRepo('_tmp_x', 'a.txt')
  assert.match(check('write', { file_path: `\\\\?\\${target}` }), /_tmp_x/)
  assert.match(check('write', { file_path: `\\\\.\\${target}` }), /_tmp_x/)
  assert.match(check('pwsh', { command: `New-Item -ItemType Directory \\\\?\\${inRepo('_tmp_y')}` }), /_tmp_y/)
})

test('I3: Windows trailing dots/spaces cannot hide a temp extension', { skip: !IS_WIN }, () => {
  assert.match(check('write', { file_path: 'build.log.' }), /build\.log/)
  assert.match(check('write', { file_path: 'x.tmp.' }), /x\.tmp/)
  assert.match(check('write', { file_path: 'x.bak. ' }), /x\.bak/)
})

test('I4: allow-list is exact on POSIX and case-insensitive on Windows', () => {
  assert.match(check('write', { file_path: 'TMP/a.txt' }, ROOT, config, 'linux'), /TMP/)
  assert.equal(check('write', { file_path: 'TMP/a.txt' }, ROOT, config, 'win32'), undefined)
})

test('I1: shell content values are not treated as paths (no false positives)', () => {
  assert.equal(check('pwsh', { command: 'Set-Content -Path docs/a.md -Value "console.log"' }), undefined)
  assert.equal(check('pwsh', { command: 'Out-File -FilePath tmp/20261103-x/out.log -InputObject "x"' }), undefined)
  assert.equal(check('pwsh', { command: 'mkdir "my scratch dir"' }), undefined)
})

test('I1/I2: shell path operands and POSIX verbs are covered', () => {
  assert.match(check('pwsh', { command: 'Out-File -FilePath build.log' }), /build\.log/)
  assert.match(check('pwsh', { command: 'Set-Content -Path _tmp_x.log -Value hi' }), /_tmp_x\.log/)
  assert.match(check('pwsh', { command: 'Add-Content -Path _tmp_y.log -Value hi' }), /_tmp_y\.log/)
  assert.match(check('pwsh', { command: 'Copy-Item a.txt _tmp_copy.txt' }), /_tmp_copy\.txt/)
  assert.match(check('bash', { command: 'cp a.txt _tmp_b.txt' }), /_tmp_b\.txt/)
  assert.match(check('bash', { command: 'tee _tmp_c.log' }), /_tmp_c\.log/)
  assert.equal(check('bash', { command: 'mv a.txt tmp/20261103-x/a.txt' }), undefined)
  assert.equal(check('bash', { command: 'echo hi > tmp/20261103-x/a.log' }), undefined)
  assert.match(check('bash', { command: 'echo hi > build.log' }), /build\.log/)
})

test('str_replace_editor: read-only view is allowed, create at root temp name is denied', () => {
  assert.equal(check('str_replace_editor', { command: 'view', path: '_tmp_old/x.md' }), undefined)
  assert.match(check('str_replace_editor', { command: 'create', path: '_tmp_new/x.md' }), /_tmp_new/)
})

test('custom tmpDirName: the unified temp dir becomes legal and the old name is denied', () => {
  const cfg = normalizeConfig({ tmpDirName: 'scratchpad' }, PLUGIN_DIR)
  assert.equal(check('write', { file_path: 'scratchpad/20261103-x/a.txt' }, ROOT, cfg), undefined)
  assert.match(check('write', { file_path: 'tmp/a.txt' }, ROOT, cfg), /tmp/)
  assert.match(check('write', { file_path: '_tmp_probe/a.txt' }, ROOT, cfg), /_tmp_probe/)
})

test('allowRootNames adds extra legal root-level names', () => {
  const cfg = normalizeConfig({ allowRootNames: ['.cache', 'work'] }, PLUGIN_DIR)
  assert.equal(check('write', { file_path: 'work/a.txt' }, ROOT, cfg), undefined)
  assert.equal(check('write', { file_path: '.cache/a.txt' }, ROOT, cfg), undefined)
  assert.match(check('write', { file_path: '_tmp_probe/a.txt' }, ROOT, cfg), /_tmp_probe/)
})

test('reasonTemplate is customizable with {name} and {tmpDir}', () => {
  const cfg = normalizeConfig({ tmpDirName: 'tmp', reasonTemplate: 'use {tmpDir}/ for {name}!' }, PLUGIN_DIR)
  assert.equal(check('write', { file_path: '_tmp_probe/a.txt' }, ROOT, cfg), 'use tmp/ for _tmp_probe!')
})

test('denial reason strips control characters from the entry name', () => {
  const cfg = normalizeConfig({}, PLUGIN_DIR)
  const reason = cfg.renderReason('a\r\nb\u001b[31m')
  assert.equal(reason.includes('\n'), false)
  assert.equal(reason.includes('\r'), false)
  assert.equal(reason.includes('\u001b'), false)
})

test('invalid tmpDirName falls back to the default instead of breaking the guard', () => {
  for (const bad of ['', '..', 'a/b', 'a\\b']) {
    const cfg = normalizeConfig({ tmpDirName: bad }, PLUGIN_DIR)
    assert.equal(check('write', { file_path: 'tmp/a.txt' }, ROOT, cfg), undefined)
    assert.match(check('write', { file_path: '_tmp_probe/a.txt' }, ROOT, cfg), /_tmp_probe/)
  }
})

test('config warnings are reported instead of silently disabling rules', () => {
  const cfg = normalizeConfig(
    { denyNamePatterns: ['['], enabled: 'false', workspaceRoot: 'relative/dir' },
    PLUGIN_DIR,
  )
  assert.equal(cfg.enabled, false)
  assert.equal(Array.isArray(cfg.warnings), true)
  assert.equal(cfg.warnings.length >= 3, true)
})

test('quarantine config is validated and defaults to strict', () => {
  const cfg = normalizeConfig({ quarantine: 'yes' }, PLUGIN_DIR)
  assert.equal(cfg.quarantine, 'strict')
  assert.equal(cfg.warnings.some(warning => warning.includes('quarantine')), true)
  assert.equal(normalizeConfig({}, PLUGIN_DIR).quarantine, 'strict')
  assert.equal(normalizeConfig({ quarantine: 'off' }, PLUGIN_DIR).quarantine, 'off')
})

test('guard is disabled by config and inert without a root', () => {
  const off = normalizeConfig({ enabled: false }, PLUGIN_DIR)
  assert.equal(evaluate(exec('write', { file_path: '_tmp_x/a.txt' }), off, { root: ROOT, cwd: ROOT }), undefined)
  assert.equal(evaluate(exec('write', { file_path: '_tmp_x/a.txt' }), config, {}), undefined)
  assert.equal(evaluate(exec('write', { file_path: '_tmp_x/a.txt' }), config, { root: '' }), undefined)
})

test('unrelated tools and malformed arguments are ignored', () => {
  assert.equal(check('read', { file_path: '_tmp_x/a.txt' }), undefined)
  assert.equal(check('grep', { pattern: 'x' }), undefined)
  assert.equal(check('write', { content: 'no path' }), undefined)
  assert.equal(check('pwsh', {}), undefined)
})

test('fs-intent: canonical target catches a junction under the allowed temp dir', () => {
  const target = {
    // Lexically inside tmp/ (legal), but its realpath identity is the root temp dir.
    displayPath: inRepo('tmp', 'link', '_tmp_x', 'a.txt'),
    targetKey: inRepo('_tmp_x', 'a.txt'),
  }
  const reason = evaluateTarget(target, config, { root: ROOT, canonicalRoot: ROOT, platform: process.platform })
  assert.match(reason, /_tmp_x/)
})

test('fs-intent: a normal tmp/ target and outside targets stay legal', () => {
  const inside = {
    displayPath: inRepo('tmp', '20261103-x', 'a.txt'),
    targetKey: inRepo('tmp', '20261103-x', 'a.txt'),
  }
  assert.equal(
    evaluateTarget(inside, config, { root: ROOT, canonicalRoot: ROOT, platform: process.platform }),
    undefined,
  )
  const outside = {
    displayPath: path.join(OTHER_ROOT, '_tmp_x', 'a.txt'),
    targetKey: path.join(OTHER_ROOT, '_tmp_x', 'a.txt'),
  }
  assert.equal(
    evaluateTarget(outside, config, { root: ROOT, canonicalRoot: ROOT, platform: process.platform }),
    undefined,
  )
})

test('fs-intent: displayPath is checked when targetKey is missing', () => {
  const target = { displayPath: inRepo('_tmp_y', 'a.txt') }
  assert.match(
    evaluateTarget(target, config, { root: ROOT, canonicalRoot: ROOT, platform: process.platform }),
    /_tmp_y/,
  )
})

test('shell: cd / Set-Location re-bases the following relative tokens', () => {
  // Inside tmp/ → legal (previously a false positive).
  assert.equal(check('pwsh', { command: 'Set-Location tmp/20261103-x; mkdir _tmp_y' }), undefined)
  assert.equal(check('bash', { command: 'cd tmp/20261103-x && mkdir sub' }), undefined)
  // Leaving a normal dir and going back to the root temp name → denied.
  assert.match(check('pwsh', { command: 'Set-Location docs; mkdir ../_tmp_z' }), /_tmp_z/)
  assert.match(check('bash', { command: 'cd docs && mkdir ../_tmp_w' }), /_tmp_w/)
  // Unknown expansion: stay deny-biased instead of pretending the base is known.
  assert.match(check('bash', { command: 'cd $UNKNOWN && mkdir _tmp_q' }), /_tmp_q/)
})

test('extraWriteTools / extraShellTools extend the covered tool set', () => {
  const cfg = normalizeConfig({ extraWriteTools: ['save_file'], extraShellTools: ['run_cmd'] }, PLUGIN_DIR)
  assert.match(check('save_file', { path: '_tmp_x/a.txt' }, ROOT, cfg), /_tmp_x/)
  assert.match(check('run_cmd', { command: 'mkdir _tmp_y' }, ROOT, cfg), /_tmp_y/)
})

test('very long names are still classified without unbounded regex cost', () => {
  const longName = '_tmp_' + 'a'.repeat(4096)
  assert.match(check('write', { file_path: `${longName}/x.txt` }), /_tmp_/)
})

test('apply_patch (DSH 0.2.2+): Add/Update/Move paths obey the same root rule', () => {
  const add = '*** Begin Patch\n*** Add File: _tmp_probe/a.txt\n+hi\n*** End Patch'
  assert.match(check('apply_patch', { input: add }), /_tmp_probe/)

  const update = '*** Begin Patch\n*** Update File: _tmp_x/f.txt\n@@\n-old\n+new\n*** End Patch'
  assert.match(check('apply_patch', { input: update }), /_tmp_x/)

  const move = '*** Begin Patch\n*** Update File: docs/a.md\n*** Move to: tmp_moved/b.md\n*** End Patch'
  assert.match(check('apply_patch', { input: move }), /tmp_moved/)

  const ok = '*** Begin Patch\n*** Add File: tmp/20261106-task/a.txt\n+hi\n*** End Patch'
  assert.equal(check('apply_patch', { input: ok }), undefined)
})

test('apply_patch: Delete File is not creation and stays allowed', () => {
  const del = '*** Begin Patch\n*** Delete File: build.log\n*** End Patch'
  assert.equal(check('apply_patch', { input: del }), undefined)
  assert.deepEqual(applyPatchPaths(del), [])
})

test('apply_patch: paths resolve against the current working directory', () => {
  const patch = '*** Begin Patch\n*** Add File: ../_tmp_x/a.txt\n+hi\n*** End Patch'
  assert.match(check('apply_patch', { input: patch }, path.join(ROOT, 'tmp')), /_tmp_x/)
})

test('apply_patch: path extraction keeps spaces/quotes and object-form input', () => {
  const patch =
    '*** Begin Patch\n*** Add File: "docs/with space.md"\n+x\n*** Update File: docs/a.md\n*** Move to: "tmp/_tmp_moved"\n*** End Patch'
  assert.deepEqual(applyPatchPaths(patch), ['docs/with space.md', 'docs/a.md', 'tmp/_tmp_moved'])
  assert.deepEqual(applyPatchPaths('*** Delete File: _tmp_x/a.txt\n*** End Patch'), [])
  assert.equal(check('apply_patch', { input: '' }), undefined)
  assert.equal(check('apply_patch', {}), undefined)
})

