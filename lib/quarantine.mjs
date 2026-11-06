/**
 * Turn-end quarantine sweep.
 *
 * Guard denials cover tool calls; a shell command that bypasses the heuristic
 * can still drop a root-level temp entry. This watcher snapshots the workspace
 * root when the FIRST concurrent turn on that root starts, and sweeps at the
 * END of the LAST concurrent turn:
 *   - entries that did not exist at that baseline and look like temp artifacts
 *     are moved into `<tmpDir>/<quarantineDirName>/<timestamp>-<name>`;
 *   - pre-existing entries are never touched;
 *   - leftovers that exceeded the per-sweep cap (or whose rename failed) are
 *     remembered per root and retried by the next sweep.
 *
 * Concurrency: Agent Teams / workflow can run several sessions in the same
 * workspace root. Sweeping at the end of one session while another is mid-turn
 * would move that other session's files, so the sweep is deferred until no
 * session has an active turn on the root (logged as `quarantine.deferred`).
 *
 * Safety:
 *   - baseline readdir failure => the sweep is skipped for that root;
 *   - `mode: warn` only logs `would-move`;
 *   - failures are logged and never thrown into the session event loop.
 *
 * @module dsh-root-temp-guard/quarantine
 */

import { mkdir, readdir, rename } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { isAllowlistedRootName, isTempRootEntry } from './guard.mjs'

/** Upper bound on entries moved per sweep (a runaway sweep is worse than a mess). */
const MAX_MOVES_PER_TURN = 50

/** Upper bound on remembered leftovers per root (bounded memory; oldest dropped). */
const MAX_PENDING = 500

/**
 * Create the turn-end quarantine watcher.
 *
 * @param {object} options
 * @param {() => object} options.getConfig - current compiled config (live, so
 *   enabling/disabling or changing `quarantine` from the settings page applies
 *   without remounting the plugin).
 * @param {(line: string) => void} options.log - audit logger.
 * @param {(session: any) => string | undefined} options.resolveRoot - workspace root for a session.
 * @param {string} [options.platform] - platform override (tests).
 * @returns {{ onSessionEvent: (session: any, event: any) => Promise<void> | undefined, dispose: () => void }}
 */
export function createQuarantineWatcher({ getConfig, log, resolveRoot, platform = process.platform }) {
  /** root -> { baseline: Promise<Set<string>>, active: number, broken: boolean } */
  const roots = new Map()
  /** session id -> root */
  const sessionRoots = new Map()
  /** root -> names that were candidates but not moved yet (truncated / failed). */
  const pendingByRoot = new Map()

  const safeRoot = session => {
    try {
      const root = resolveRoot(session)
      return typeof root === 'string' && root.length > 0 ? root : undefined
    } catch (error) {
      log(`quarantine.root-failed error=${safeText(error?.message ?? error)}`)
      return undefined
    }
  }

  const sessionKey = session => String(session?.id ?? '')

  const snapshot = root =>
    readdir(root)
      .then(names => new Set(names))
      .catch(error => {
        log(`quarantine.baseline-failed root=${safeText(root)} error=${safeText(error?.message ?? error)}`)
        throw error
      })

  const start = session => {
    const config = getConfig()
    if (!config || config.enabled !== true || config.quarantine !== 'strict') return undefined
    const root = safeRoot(session)
    const key = sessionKey(session)
    if (root === undefined || key.length === 0) return undefined
    if (sessionRoots.has(key)) return undefined // duplicate turn/start

    sessionRoots.set(key, root)
    let state = roots.get(root)
    if (state === undefined) {
      const baseline = snapshot(root)
      state = { baseline, active: 0, broken: false }
      baseline.catch(() => {
        state.broken = true
      })
      roots.set(root, state)
    }
    state.active += 1
    return state.baseline.then(
      () => undefined,
      () => undefined,
    )
  }

  const finish = session => {
    const key = sessionKey(session)
    const root = sessionRoots.get(key)
    if (root === undefined) return undefined // no matching turn/start
    sessionRoots.delete(key)

    const state = roots.get(root)
    if (state === undefined) return undefined
    state.active = Math.max(0, state.active - 1)
    if (state.active > 0) {
      // Another session still owns this workspace root: do not sweep its files.
      log(`quarantine.deferred root=${safeText(root)} active=${state.active}`)
      return undefined
    }
    roots.delete(root)
    const config = getConfig()
    if (!config || config.enabled !== true || config.quarantine !== 'strict') {
      log(`quarantine.skipped root=${safeText(root)}`)
      return undefined
    }
    return sweep(root, state, config).catch(error => {
      log(`quarantine.failed error=${safeText(error?.message ?? error)}`)
    })
  }

  const sweep = async (root, state, config) => {
    let baseline
    try {
      baseline = await state.baseline
    } catch {
      return // baseline unavailable: skip rather than sweep everything
    }
    if (state.broken) return
    let entries
    try {
      entries = await readdir(root)
    } catch (error) {
      log(`quarantine.scan-failed root=${safeText(root)} error=${safeText(error?.message ?? error)}`)
      return
    }

    const present = new Set(entries)
    const pending = pendingByRoot.get(root) ?? new Set()
    for (const name of [...pending]) if (!present.has(name)) pending.delete(name)

    const candidates = entries.filter(
      name =>
        (pending.has(name) || !baseline.has(name)) &&
        !isAllowlistedRootName(name, config, platform) &&
        isTempRootEntry(name, config, platform),
    )
    if (candidates.length === 0) {
      pendingByRoot.delete(root)
      return
    }

    if (config.mode === 'warn') {
      log(`quarantine.would-move count=${candidates.length} names=${candidates.slice(0, 10).map(safeText).join(',')}`)
      return
    }

    const targetDir = path.join(root, config.tmpDirName, config.quarantineDirName)
    try {
      await mkdir(targetDir, { recursive: true })
    } catch (error) {
      log(`quarantine.mkdir-failed dir=${safeText(targetDir)} error=${safeText(error?.message ?? error)}`)
      return
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const batch = candidates.slice(0, MAX_MOVES_PER_TURN)
    let moved = 0
    for (const name of batch) {
      const from = path.join(root, name)
      const to = path.join(targetDir, `${stamp}-${name}`)
      try {
        await rename(from, to)
        moved += 1
        pending.delete(name)
        log(`quarantine.moved name=${safeText(name)} -> ${safeText(to)}`)
      } catch (error) {
        pending.add(name)
        log(`quarantine.move-failed name=${safeText(name)} error=${safeText(error?.message ?? error)}`)
      }
    }

    for (const name of candidates.slice(MAX_MOVES_PER_TURN)) pending.add(name)

    if (pending.size > MAX_PENDING) {
      // Drop the oldest overflow instead of growing without bound; they stay in
      // the root and the next baseline will treat them like pre-existing files.
      const overflow = pending.size - MAX_PENDING
      const iterator = pending.values()
      for (let index = 0; index < overflow; index += 1) pending.delete(iterator.next().value)
      log(`quarantine.pending-truncated size=${pending.size}`)
    }
    if (pending.size > 0) pendingByRoot.set(root, pending)
    else pendingByRoot.delete(root)

    if (candidates.length > MAX_MOVES_PER_TURN) {
      log(`quarantine.truncated count=${candidates.length} moved=${moved} pending=${pending.size}`)
    }
    log(`quarantine.done moved=${moved} pending=${pending.size} dir=${safeText(targetDir)}`)
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
      roots.clear()
      sessionRoots.clear()
      pendingByRoot.clear()
    },
  }
}

/** One-line log-safe text. */
function safeText(value) {
  return String(value ?? '')
    .replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ')
    .slice(0, 300)
}
