/**
 * Guard logic for dsh-root-temp-guard.
 *
 * Pure functions only: no cordis, no ctx, no I/O. The plugin entry
 * (`index.mjs`) resolves the workspace root AND the session's current working
 * directory, then wires this evaluator into `ctx.tools.guard()`.
 *
 * Why two paths:
 *   - `root` is the workspace boundary (what counts as "the repository root");
 *   - `cwd`  is the base DSH's own file tools use to resolve relative paths
 *     (`workingDirectory.get(session)`, which changes when the model calls the
 *     `working_directory` tool). Resolving against `root` instead was a real
 *     bypass: `cd tmp` + `write ../_tmp_x/a` would create `<root>/_tmp_x` while
 *     the guard looked outside the root.
 *
 * Project-specific behavior is configuration: temp dir name(s), deny patterns,
 * denied extensions, denial text, pinned root, and log destination.
 *
 * @module dsh-root-temp-guard/guard
 */

import path from 'node:path'

/** Tools whose `file_path` / `path` argument targets the filesystem. */
export const FS_WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

/** Tools that run a shell command (command text is inspected heuristically). */
export const SHELL_TOOLS = new Set(['pwsh', 'bash', 'terminal_send'])

/** Creation verbs that can materialize a root-level entry (PowerShell + POSIX). */
const CREATE_VERB_RE =
  /(?:^|[\s;|&(`])(?:new-item|mkdir|\bmd\b|\bni\b|touch|set-content|add-content|out-file|tee-object|copy-item|move-item|xcopy|robocopy|\bcp\b|\bmv\b|\btee\b|\binstall\b|\bln\b)(?=$|[\s;|&)`\]])/i

/** PowerShell / bash redirection into a file. */
const REDIRECT_RE = /(?:^|[\s;|&])[0-9]?>>?\s*\S/

/**
 * Flags whose next token is free text / content, never a path. Without this,
 * `Set-Content -Path docs/a.md -Value "console.log"` would deny `console.log`.
 */
const VALUE_FLAGS = new Set([
  '-value', '-content', '-description', '-filter', '-include', '-exclude', '-inputobject', '-body',
  '-subject', '-comment', '-message', '-pattern', '-replace', '-encoding', '-delimiter', '-separator',
  '-title', '-append', '-confirm', '-whatif', '-verbose', '-debug', '-erroraction', '-warningaction',
  '-informationaction', '-outvariable', '-pipelinevariable', '-errorvariable', '-nonewline',
  '-foregroundcolor', '-backgroundcolor', '-valueonly',
])

/** Case-insensitive filesystems (Windows, default macOS) for allow-list equality. */
function isCaseInsensitivePlatform(platform) {
  return platform === 'win32' || platform === 'darwin'
}

/**
 * Defaults are deliberately narrow: only temp-looking names are denied, and the
 * unified temp directory name is an ordinary config value.
 */
export const DEFAULTS = {
  enabled: true,
  /** Name of the unified temporary directory at the workspace root. */
  tmpDirName: 'tmp',
  /** Extra root-level names that stay legal (e.g. `.tmp`, `worktmp`). */
  allowRootNames: [],
  /** Root-level names treated as temporary artifacts (leading dots allowed). */
  denyNamePatterns: ['^(?:\\.*_?tmp|\\.*temp|\\.*scratch|\\.*test[-_]?out)(?=$|[._-]|\\d)'],
  /** Root-level files with these extensions are temporary artifacts too. */
  denyFileExtensions: ['.log', '.tmp', '.bak', '.orig', '.rej'],
  /** Workspace root override; when empty the session sandbox root is used. */
  workspaceRoot: '',
  /** Denial log file; relative paths resolve against the plugin directory. */
  logFile: '',
  /**
   * Model-visible denial text. `{name}` / `{tmpDir}` are replaced.
   * Leave empty to use the generic default.
   */
  reasonTemplate: '',
}

/** Default denial text: project-agnostic, points at the configured temp dir. */
const DEFAULT_REASON_TEMPLATE =
  '禁止在仓库根目录创建临时项 "{name}"。临时产物请写入 {tmpDir}/<任务名>/ 下；具体约定见项目约定文件（如 AGENTS.md）中的临时文件规则。'

/**
 * Normalize and compile the loader config block.
 *
 * @param {unknown} raw - the `config:` block of the loader entry.
 * @param {string} pluginDir - absolute plugin directory (default log location).
 * @returns {object} compiled config consumed by {@link evaluate}; `warnings`
 *   holds human-readable config problems to log once at mount.
 */
export function normalizeConfig(raw, pluginDir) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const merged = { ...DEFAULTS, ...input }
  const warnings = []

  const tmpDirName = sanitizeDirName(merged.tmpDirName)
  if (tmpDirName === undefined) {
    warnings.push(`tmpDirName ${JSON.stringify(merged.tmpDirName)} is not a single path segment; falling back to "tmp"`)
  }

  let enabled = merged.enabled !== false
  if (typeof merged.enabled === 'string') {
    enabled = merged.enabled.toLowerCase() !== 'false'
    warnings.push(`enabled should be a boolean, got ${JSON.stringify(merged.enabled)}; interpreted as ${enabled}`)
  } else if (typeof merged.enabled !== 'boolean') {
    warnings.push(`enabled should be a boolean, got ${typeof merged.enabled}`)
  }

  const namePatterns =
    Array.isArray(merged.denyNamePatterns) && merged.denyNamePatterns.length > 0
      ? merged.denyNamePatterns
      : DEFAULTS.denyNamePatterns
  if (Array.isArray(merged.denyNamePatterns) && merged.denyNamePatterns.length === 0) {
    warnings.push('denyNamePatterns: [] means "keep defaults" (an empty name-pattern list cannot disable the name rule)')
  }
  const nameRes = []
  for (const source of namePatterns) {
    if (typeof source !== 'string') {
      warnings.push(`denyNamePatterns entry ${JSON.stringify(source)} is not a string; ignored`)
      continue
    }
    try {
      nameRes.push(new RegExp(source, 'i'))
    } catch {
      warnings.push(`denyNamePatterns entry ${JSON.stringify(source)} is not a valid RegExp; ignored`)
    }
  }

  const extensions = Array.isArray(merged.denyFileExtensions) ? merged.denyFileExtensions : DEFAULTS.denyFileExtensions
  const extraAllow = Array.isArray(merged.allowRootNames) ? merged.allowRootNames : []
  const allowedRoots = [tmpDirName ?? DEFAULTS.tmpDirName, ...extraAllow]
    .filter(name => typeof name === 'string' && name.trim().length > 0)
    .map(name => name.trim())
  const allowExact = new Set(allowedRoots)
  const allowLower = new Set(allowedRoots.map(name => name.toLowerCase()))

  let workspaceRoot = ''
  if (typeof merged.workspaceRoot === 'string' && merged.workspaceRoot.trim().length > 0) {
    workspaceRoot = merged.workspaceRoot.trim()
    if (!path.isAbsolute(workspaceRoot)) {
      warnings.push(`workspaceRoot ${JSON.stringify(workspaceRoot)} is not absolute; it will be resolved against the host process cwd`)
    }
  }

  let logFile = ''
  if (typeof merged.logFile === 'string' && merged.logFile.trim().length > 0) {
    logFile = merged.logFile.trim()
    if (!path.isAbsolute(logFile)) logFile = path.join(pluginDir, logFile)
  } else {
    logFile = path.join(pluginDir, 'state', 'root-temp-guard.log')
  }

  const reasonTemplate =
    typeof merged.reasonTemplate === 'string' && merged.reasonTemplate.trim().length > 0
      ? merged.reasonTemplate.trim()
      : DEFAULT_REASON_TEMPLATE

  return {
    enabled,
    tmpDirName: tmpDirName ?? DEFAULTS.tmpDirName,
    workspaceRoot,
    logFile,
    nameRes,
    extSet: new Set(extensions.map(ext => String(ext).toLowerCase())),
    allowExact,
    allowLower,
    warnings,
    renderReason(name) {
      // Strip control characters from the model-supplied entry name so the
      // denial cannot smuggle terminal escapes / newlines into the transcript.
      const safeName = String(name).replace(/[\u0000-\u001f\u007f]/g, '?')
      return reasonTemplate.split('{name}').join(safeName).split('{tmpDir}').join(tmpDirName ?? DEFAULTS.tmpDirName)
    },
  }
}

/**
 * Decide whether one tool call is denied.
 *
 * @param {{ name?: string, arguments?: Record<string, unknown> }} exec - the pipeline execution.
 * @param {object} config - compiled config from {@link normalizeConfig}.
 * @param {{ root?: string, cwd?: string, platform?: string }} context
 *   `root` = workspace boundary, `cwd` = base for relative paths (defaults to root).
 * @returns {string | undefined} denial reason, or undefined to allow.
 */
export function evaluate(exec, config, context) {
  if (!config || config.enabled !== true) return undefined
  const platform = context?.platform ?? process.platform
  if (typeof context?.root !== 'string' || context.root.length === 0) return undefined
  const root = path.resolve(context.root)
  const cwd = typeof context?.cwd === 'string' && context.cwd.length > 0 ? path.resolve(context.cwd) : root

  const args = exec?.arguments
  if (args === null || typeof args !== 'object') return undefined
  const tool = typeof exec.name === 'string' ? exec.name : ''

  if (FS_WRITE_TOOLS.has(tool)) {
    // `str_replace_editor` has a read-only `view` command.
    if (tool === 'str_replace_editor' && args.command === 'view') return undefined
    const target = pickPath(args)
    return target === undefined ? undefined : checkPath(root, cwd, target, config, platform)
  }

  if (SHELL_TOOLS.has(tool)) {
    const command = pickCommand(args)
    return command === undefined ? undefined : checkShell(root, cwd, command, args.workdir, config, platform)
  }

  return undefined
}

/**
 * Check a filesystem write target. The first path segment decides: writing
 * `<temp>/nested/file` still creates `<temp>` at the root.
 */
function checkPath(root, cwd, raw, config, platform) {
  const abs = resolveInput(cwd, raw, platform)
  if (abs === undefined) return undefined
  const rel = path.relative(root, abs)
  if (isOutsideRoot(rel)) return undefined
  return matchRootEntry(rel, config, platform)
}

/**
 * Heuristic shell check. Denies only when a creation verb appears together with
 * a temp-looking entry that resolves directly under the workspace root.
 */
function checkShell(root, cwd, rawCommand, rawWorkdir, config, platform) {
  const command = rawCommand.trim()
  if (command.length === 0) return undefined
  if (!CREATE_VERB_RE.test(command) && !REDIRECT_RE.test(command)) return undefined

  const workdir = typeof rawWorkdir === 'string' && rawWorkdir.trim().length > 0 ? rawWorkdir.trim() : undefined
  const base = workdir === undefined ? cwd : resolveInput(cwd, workdir, platform) ?? cwd

  for (const token of tokenize(command)) {
    if (token.skip) continue
    const candidate = token.text
    if (candidate.length === 0) continue
    const abs = resolveInput(base, candidate, platform)
    if (abs === undefined) continue
    const rel = path.relative(root, abs)
    if (isOutsideRoot(rel)) continue
    const reason = matchRootEntry(rel, config, platform)
    if (reason !== undefined) return reason
  }
  return undefined
}

/** Match one root-relative path against the temp-entry rules. */
function matchRootEntry(rel, config, platform) {
  const parts = rel.split(/[\\/]+/).filter(Boolean)
  const first = parts[0]
  if (first === undefined) return undefined
  // The configured unified temp dir and every ordinary repository directory stay legal.
  if (isAllowed(first, config, platform)) return undefined
  // Writing anywhere below a root-level temp directory still creates that directory.
  if (isTempName(first, config)) return config.renderReason(first)
  // A temporary file written directly into the root.
  if (parts.length === 1 && isTempFile(first, config, platform)) return config.renderReason(first)
  return undefined
}

/** Resolve one input path (or path-ish token) against a base directory. */
function resolveInput(base, raw, platform) {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  const normalized = normalizeInputPath(trimmed, platform)
  if (normalized.length === 0) return undefined
  return path.resolve(base, normalized)
}

/**
 * Normalize path spelling before resolution:
 *   - Windows extended-length / device prefixes (`\\?\`, `\\.\`, `\\?\UNC\`);
 *   - Windows trailing dots/spaces per segment (the OS strips them, so
 *     `build.log.` really creates `build.log`);
 *   - surrounding quotes (shell tokens keep them only when unbalanced).
 */
function normalizeInputPath(raw, platform) {
  let value = raw
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
  else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1)
  if (platform !== 'win32') return value
  if (/^\\\\\?\\UNC\\/i.test(value)) value = '\\\\' + value.slice(8)
  else if (/^\\\\\?\\/i.test(value)) value = value.slice(4)
  else if (/^\\\\.\\/i.test(value)) value = value.slice(4)
  return value
    .split(/[\\/]+/)
    .map(segment => (segment === '' || segment === '.' || segment === '..' ? segment : segment.replace(/[ .]+$/, '')))
    .join('\\')
}

/** Whether the root-level name is explicitly allowed (case rule follows the platform). */
function isAllowed(name, config, platform) {
  return isCaseInsensitivePlatform(platform)
    ? config.allowLower.has(name.toLowerCase())
    : config.allowExact.has(name)
}

/** Whether the root-level name belongs to the temp-artifact family. */
function isTempName(name, config) {
  for (const re of config.nameRes) if (re.test(name)) return true
  return false
}

/** Whether a root-level file name looks like a temporary file. */
function isTempFile(name, config, platform) {
  const normalized = platform === 'win32' ? name.replace(/[ .]+$/, '') : name
  if (config.extSet.has(path.extname(normalized).toLowerCase())) return true
  // `.log` / `.tmp` (extension-less dotfile names) are temp files too.
  return normalized.startsWith('.') && config.extSet.has(normalized.toLowerCase()) && !normalized.slice(1).includes('.')
}

/**
 * Whether a `path.relative` result escapes the root.
 *
 * A plain `rel.startsWith('..')` check is WRONG: a root-level entry named
 * `.._tmp_x` is inside the workspace, and treating it as outside would let that
 * name bypass the guard. Only `..` as a whole segment is outside.
 */
function isOutsideRoot(rel) {
  if (rel.length === 0) return true
  if (path.isAbsolute(rel)) return true
  return rel.split(/[\\/]+/, 1)[0] === '..'
}

/**
 * Tokenize a shell command without executing it: whitespace-separated words,
 * quotes kept together, command separators split, `-flag value` pairs marked so
 * content values are skipped.
 */
function tokenize(command) {
  const tokens = []
  let current = ''
  let quote = null
  let started = false
  const push = () => {
    if (!started) return
    tokens.push(current)
    current = ''
    started = false
  }
  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      push()
      continue
    }
    if (ch === '|' || ch === ';' || ch === '&') {
      push()
      continue
    }
    current += ch
    started = true
  }
  push()

  const out = []
  let skipNext = false
  for (const token of tokens) {
    if (skipNext) {
      skipNext = false
      out.push({ text: '', skip: true })
      continue
    }
    if (token.startsWith('-') || token.startsWith('--')) {
      if (VALUE_FLAGS.has(token.toLowerCase())) skipNext = true
      out.push({ text: '', skip: true })
      continue
    }
    // Redirection target: ">build.log", ">>tmp/x.log", "2>err.txt".
    const redirect = token.match(/^(?:[0-9]?>>?)(.+)$/)
    const text = redirect ? redirect[1] : token
    out.push({ text, skip: false })
  }
  return out
}

/** A safe single path segment, or undefined when the configured value is unusable. */
function sanitizeDirName(value) {
  if (typeof value !== 'string') return undefined
  const name = value.trim()
  if (name.length === 0) return undefined
  if (name === '.' || name === '..') return undefined
  if (/[\\/]/.test(name)) return undefined
  return name
}

/** First string-valued filesystem argument. */
function pickPath(args) {
  for (const key of ['file_path', 'path', 'filePath']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return undefined
}

/** First string-valued command argument. */
function pickCommand(args) {
  for (const key of ['command', 'text', 'cmd']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return undefined
}
