/**
 * dsh-root-temp-guard — a DSH Host plugin that hard-blocks tool calls creating
 * temporary directories/files directly in the workspace root.
 *
 * Two enforcement layers, both config-driven and project-agnostic:
 *   1. `ctx.tools.guard()` — before a tool runs, from the tool arguments and the
 *      session's current working directory (`workingDirectory.get(session)`);
 *   2. `fs/write-intent` / `fs/edit-intent` waterfalls — after DSH resolved the
 *      target path (cwd applied, realpath identity known), so symlinks/junctions
 *      under an allowed temp dir cannot hide a root-level temp entry.
 *
 * Root boundary comes from the session (`sandboxPolicy`), unless the deployment
 * pins it with `config.workspaceRoot`; temp dir name, deny patterns, denied
 * extensions, denial text, mode (deny/warn) and extra tools are configuration.
 *
 * Design notes:
 *   - fail-open: any internal error allows the call and writes a log line;
 *   - synchronous: guards run inline, so no filesystem I/O except on denial and
 *     a one-time realpath of the workspace root (cached per root);
 *   - lifecycle: tool guard registered through `ctx.effect()`; waterfall
 *     listeners are fiber-scoped by `ctx.on()`;
 *   - scope: one global guard, so nested subagent/workflow/PTC tool calls are
 *     guarded too.
 *
 * @module dsh-root-temp-guard
 */

import { appendFileSync, mkdirSync, realpathSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, evaluateTarget, normalizeConfig } from './lib/guard.mjs'
import { createQuarantineWatcher } from './lib/quarantine.mjs'

/** Cordis plugin name. */
export const name = 'root-temp-guard'

/** The tool registry is the only service this plugin requires. */
export const inject = ['tools']

const PLUGIN_DIR = fileURLToPath(new URL('.', import.meta.url))

/** Rotate the audit log once it passes this size (checked at mount only). */
const LOG_MAX_BYTES = 5 * 1024 * 1024

/**
 * Mount the guard.
 * @param {any} ctx - Cordis context of the profile/host plugin tree.
 * @param {unknown} rawConfig - the `config:` block of the loader entry.
 */
export function apply(ctx, rawConfig) {
  let log = () => {}
  try {
    const config = normalizeConfig(rawConfig, PLUGIN_DIR)
    log = createLog(config.logFile)
    for (const message of config.warnings) {
      log(`config.warning ${message}`)
      try {
        ctx.logger?.warn?.(`[root-temp-guard] ${message}`)
      } catch {
        /* host logger is optional */
      }
    }

    /** Canonical workspace roots, realpath-ed once per distinct root. */
    const canonicalRoots = new Map()
    const canonicalRootOf = root => {
      if (typeof root !== 'string' || root.length === 0) return ''
      const cached = canonicalRoots.get(root)
      if (cached !== undefined) return cached
      let value = root
      try {
        value = realpathSync.native(root)
      } catch {
        /* keep the lexical root */
      }
      if (canonicalRoots.size > 64) canonicalRoots.clear()
      canonicalRoots.set(root, value)
      return value
    }

    /** Root boundary + current working directory for one call. */
    const resolveContext = exec => {
      const session = exec?.agent?.session
      const cwd = resolveCwd(ctx, session)

      if (config.workspaceRoot.length > 0) return { root: config.workspaceRoot, cwd }
      if (session === undefined) return { root: undefined, cwd } // agentless: no workspace to judge

      let root = ''
      try {
        const policy = ctx.get('sandboxPolicy')
        if (policy !== undefined && typeof policy.resolve === 'function') {
          const resolved = policy.resolve({ session })
          if (typeof resolved?.workspaceRoot === 'string' && resolved.workspaceRoot.length > 0) {
            root = resolved.workspaceRoot
          }
        }
      } catch {
        /* fall through to the working directory */
      }
      return { root: root.length > 0 ? root : cwd, cwd }
    }

    const guard = exec => {
      try {
        const { root, cwd } = resolveContext(exec)
        const reason = evaluate(exec, config, { root, cwd })
        if (reason !== undefined) {
          log(`deny source=tool tool=${forLog(exec?.name)} reason=${forLog(reason)}`)
          if (config.mode === 'warn') return undefined
        }
        return reason
      } catch (error) {
        log(`guard.error ${forLog(error?.message ?? error)}`)
        return undefined
      }
    }

    /** Register the tool guard; the returned disposer is idempotent. */
    const register = () => {
      const off = ctx.tools.guard(guard)
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        try {
          off()
        } catch {
          /* disposal is best effort */
        }
        log('plugin.disposed')
      }
    }

    if (typeof ctx.effect === 'function') {
      // Cordis runs the callback now and disposes the returned disposer with the
      // plugin's fiber, so a reload/HMR drops the old guard before mounting again.
      ctx.effect(register, 'root-temp-guard')
    } else {
      const off = register()
      if (typeof ctx.on === 'function') ctx.on('dispose', off)
    }

    // Second layer: resolved-target waterfalls, prepended so a denial vetoes the
    // write before the observation-policy listener (which never calls next()).
    const fsGuard = (target, actor, next) => {
      let reason
      try {
        const { root, cwd } = resolveContext(actor)
        reason = evaluateTarget(target, config, { root, cwd, canonicalRoot: canonicalRootOf(root) })
      } catch (error) {
        log(`fs-intent.error ${forLog(error?.message ?? error)}`)
        return next()
      }
      if (reason !== undefined) {
        log(`deny source=fs tool=${forLog(actor?.name)} target=${forLog(target?.displayPath)} reason=${forLog(reason)}`)
        if (config.mode !== 'warn') throw new Error(reason)
      }
      return next()
    }
    if (typeof ctx.on === 'function') {
      ctx.on('fs/write-intent', fsGuard, { prepend: true })
      ctx.on('fs/edit-intent', fsGuard, { prepend: true })
    }

    // Third layer: turn-end sweep. Anything a shell command bypassed past the
    // heuristic still shows up as a NEW root entry; move it into
    // <tmpDir>/<quarantineDirName>/ (moved, never deleted) at turn end.
    if (config.quarantine === 'strict' && typeof ctx.on === 'function') {
      const quarantine = createQuarantineWatcher({
        config,
        mode: config.mode,
        log,
        resolveRoot: session => resolveContext({ agent: { session } }).root,
      })
      ctx.on('session/event', (session, event) => {
        quarantine.onSessionEvent(session, event)
      })
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => quarantine.dispose(), 'root-temp-guard quarantine teardown')
      }
    }

    log(`plugin.mounted pid=${process.pid} mode=${config.mode} quarantine=${config.quarantine}`)
  } catch (error) {
    log(`plugin.error ${forLog(error?.message ?? error)}`)
  }
}

/**
 * The session's effective working directory: the mutable one the file tools use,
 * falling back to the immutable session header.
 * @param {any} ctx
 * @param {any} session
 * @returns {string | undefined}
 */
function resolveCwd(ctx, session) {
  if (session === undefined) return undefined
  try {
    const workingDirectory = ctx.get('workingDirectory')
    if (workingDirectory !== undefined && typeof workingDirectory.get === 'function') {
      const cwd = workingDirectory.get(session)
      if (typeof cwd === 'string' && cwd.length > 0) return cwd
    }
  } catch {
    /* fall back to the session header */
  }
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/**
 * Build an append-only audit log (rotated once at mount). Never throws.
 * @param {string} file - absolute log file path.
 * @returns {(line: string) => void}
 */
function createLog(file) {
  const target = file
  try {
    if (statSync(target).size > LOG_MAX_BYTES) renameSync(target, `${target}.1`)
  } catch {
    /* no log yet, or rotation failed: keep appending */
  }
  return line => {
    try {
      mkdirSync(dirname(target), { recursive: true })
      appendFileSync(target, `${new Date().toISOString()} ${line}\n`, 'utf8')
    } catch {
      /* swallow logging failures */
    }
  }
}

/**
 * One-line log-safe rendering: model-controlled text must not forge extra log
 * lines or blow up the file with control characters / unbounded length.
 * @param {unknown} value
 * @returns {string}
 */
function forLog(value) {
  return String(value ?? '')
    .replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ')
    .slice(0, 300)
}
