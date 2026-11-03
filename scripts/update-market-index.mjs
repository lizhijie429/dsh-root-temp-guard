#!/usr/bin/env node
/**
 * Regenerate the plugin market index (format 1) served by GitHub Pages.
 *
 * The index pins one Git commit per version, so run this after committing a
 * plugin change and before publishing the docs/ folder:
 *
 *   npm run market:index
 *   git add docs && git commit -m "chore: refresh market index"
 *
 * The pinned commit must contain the plugin manifest the index describes; it
 * does not have to be the commit that adds this generated file.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DOCS = join(ROOT, 'docs')
const REPO_URL = 'https://github.com/lizhijie429/dsh-root-temp-guard'
const INDEX_URL = 'https://lizhijie429.github.io/dsh-root-temp-guard/index.json'

function git(...args) {
  return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim()
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const commit = git('rev-parse', 'HEAD')
const publishTimestamp = Number(git('log', '-1', '--format=%ct'))
const status = git('status', '--porcelain')
if (status !== '') {
  console.warn('warning: working tree is dirty; the index pins HEAD and ignores uncommitted files')
}
if (!/^[0-9a-f]{40}$/.test(commit)) {
  throw new Error(`unexpected commit id: ${commit}`)
}
const enginesDsh = manifest.engines?.dsh
if (typeof enginesDsh !== 'string' || enginesDsh.trim() === '') {
  throw new Error('package.json must declare engines.dsh')
}
if (manifest.dsh?.bundle?.patch === undefined) {
  throw new Error('package.json must declare dsh.bundle.patch for market installation')
}

const index = {
  format: 1,
  title: {
    en: 'lizhijie429 DSH plugins',
    zh: 'lizhijie429 的 DSH 插件',
  },
  description: {
    en: 'Bundles published by lizhijie429 for DeepSeek Harness.',
    zh: 'lizhijie429 发布给 DeepSeek Harness 使用的组合包。',
  },
  plugins: [
    {
      name: manifest.name,
      title: {
        en: 'DSH Root Temp Guard',
        zh: 'DSH 根目录临时文件守卫',
      },
      description: {
        en: 'Blocks tool calls that create temporary files or directories in the workspace root, and moves new root-level temp entries into tmp/_quarantine at turn end.',
        zh: '拦截在仓库根目录创建临时文件或目录的工具调用，并在回合结束时把新增的根目录临时项移入 tmp/_quarantine。',
      },
      icon: 'icons/root-temp-guard.png',
      author: 'lizhijie429',
      homepage: `${REPO_URL}#readme`,
      repository: {
        url: REPO_URL,
      },
      metadata: {
        keywords: manifest.keywords ?? [],
      },
      'dist-tags': {
        latest: manifest.version,
      },
      versions: [
        {
          version: manifest.version,
          publishTimestamp,
          source: {
            type: 'git',
            url: REPO_URL,
            commit,
          },
          engines: {
            dsh: enginesDsh,
          },
        },
      ],
    },
  ],
}

mkdirSync(join(DOCS, 'icons'), { recursive: true })
copyFileSync(join(ROOT, 'assets', 'icon.png'), join(DOCS, 'icons', 'root-temp-guard.png'))
writeFileSync(join(DOCS, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
writeFileSync(join(DOCS, '.nojekyll'), '', 'utf8')

console.log(`wrote docs/index.json (${manifest.name}@${manifest.version} -> ${commit})`)
console.log(`serve it over https and subscribe to ${INDEX_URL}`)
