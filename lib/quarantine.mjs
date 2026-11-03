/**
 * Turn-end quarantine sweep.
 *
 * Guard denials cover tool calls; a shell command that bypasses the heuristic
 * can still drop a root-level temp entry. This watcher snapshots the workspace
 * root at `turn/start` and, at `turn/end`, moves entries that BOTH
 *   - did not exist at turn start, and
 *   - look like temp artifacts (deny patterns / temp extensions),
 * into `<tmpDir>/<quarantineDirName>/<timestamp>-<name>` — moved, never deleted,
 * so the user can recover them. Pre-existing entries are never touched.
 *
 * Safety:
 *   - baseline readdir failure => the sweep is skipped for that turn;
 *   - `mode: warn` only logs `would-move`;
 *   - failures are logged and never thrown into the session event loop.
 *
 * @module dsh-root-temp-guard/quarantine
 */

import { mkdir, readdir, rename } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { isAllowlistedRootName, isTempRootEntry } from './guard.mjs'

/** Upper bound on entries moved per turn (a runaway sweep is worse than a mess). */
const MAX_MOVES_PER_TURN = 50

/**
 * Create the turn-end quarantine watcher.
 *
 * @param {object} options
 * @param {object} options.config - compiled plugin config.
 * @param {(line: string) => void} options.log - audit logger.
 * @param {(session: any) => string | undefined} options.resolveRoot - workspace root for a session.
 * @param {'deny'|'warn'} [options.mode] - `warn` logs instead of moving.
 * @param {string} [options.platform] - platform override (tests).
 * @returns {{ onSessionEvent: (session: any, event: any) => Promise<void> | undefined, dispose: () => void }}
 */
export function createQuarantineWatcher({ config, log, resolveRoot, mode = 'deny', platform = process.platform }) {
  const states = new Map()

  const safeRoot = session => {
    try {
      const root = resolveRoot(session)
      return typeof root === 'string' && root.length > 0 ? root : undefined
    } catch (error) {
      log(`quarantine.root-failed error=${safeText(error?.message ?? error)}`)
      return undefined
    }
  }

  const start = session => {
    const root = safeRoot(session)
    if (root === undefined) return undefined
    const key = String(session?.id ?? '')
    if (key.length === 0) return undefined
    const baseline = readdir(root)
      .then(names => new Set(names))
      .catch(error => {
        log(`quarantine.baseline-failed root=${safeText(root)} error=${safeText(error?.message ?? error)}`)
        throw error
      })
    baseline.catch(() => undefined) // observed by finish()
    states.set(key, { root, baseline })
    return baseline.then(() => undefined).catch(() => undefined)
  }

  const finish = session => {
    const key = String(session?.id ?? '')
    const state = states.get(key)
    if (state === undefined) return undefined
    states.delete(key)
    return sweep(state).catch(error => {
      log(`quarantine.failed error=${safeText(error?.message ?? error)}`)
    })
  }

  const sweep = async state => {
    let baseline
    try {
      baseline = await state.baseline
    } catch {
      return // baseline unavailable: skip rather than sweep everything
    }
    let entries
    try {
      entries = await readdir(state.root)
    } catch (error) {
      log(`quarantine.scan-failed root=${safeText(state.root)} error=${safeText(error?.message ?? error)}`)
      return
    }

    const candidates = entries.filter(
      name =>
        !baseline.has(name) &&
        !isAllowlistedRootName(name, config, platform) &&
        isTempRootEntry(name, config, platform),
    )
    if (candidates.length === 0) return

    if (mode === 'warn') {
      log(`quarantine.would-move count=${candidates.length} names=${candidates.slice(0, 10).map(safeText).join(',')}`)
      return
    }

    const targetDir = path.join(state.root, config.tmpDirName, config.quarantineDirName)
    try {
      await mkdir(targetDir, { recursive: true })
    } catch (error) {
      log(`quarantine.mkdir-failed dir=${safeText(targetDir)} error=${safeText(error?.message ?? error)}`)
      return
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    let moved = 0
    for (const name of candidates.slice(0, MAX_MOVES_PER_TURN)) {
      const from = path.join(state.root, name)
      const to = path.join(targetDir, `${stamp}-${name}`)
      try {
        await rename(from, to)
        moved += 1
        log(`quarantine.moved name=${safeText(name)} -> ${safeText(to)}`)
      } catch (error) {
        log(`quarantine.move-failed name=${safeText(name)} error=${safeText(error?.message ?? error)}`)
      }
    }
    if (candidates.length > MAX_MOVES_PER_TURN) {
      log(`quarantine.truncated count=${candidates.length} moved=${moved}`)
    }
    log(`quarantine.done moved=${moved} dir=${safeText(targetDir)}`)
  }

  return {
    onSessionEvent(session, event) {
      try {
        if (event?.type === 'turn/start') return start(session)
        if (event?.type === 'turn/end') return finish(session)
        return undefined
      } catch (error) {
        log(`quarantine.event-failed error=${safeText(error?.message ?? error)}`)
        return undefined
      }
    },
    dispose() {
      states.clear()
    },
  }
}

/** One-line log-safe text. */
function safeText(value) {
  return String(value ?? '')
    .replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ')
    .slice(0, 300)
}
