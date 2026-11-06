/**
 * Host `Config` schema for dsh-root-temp-guard.
 *
 * DSH derives two things from this export:
 *   - loader validation/normalization (`resolveConfig` uses the schema's
 *     Standard Schema `~standard` interface), and
 *   - the graphical settings form (`dsh-settings` projects volatile fields from
 *     `Config.toJSON()`).
 *
 * The root is `.volatile()`: the loader hands `apply()` a stable volatile
 * reference (`{ get() }`) whose value is updated in place when the settings
 * page saves, so the plugin can read live configuration without remounting.
 * Field types are intentionally permissive (`any` + default) because the plugin
 * already normalizes/sanitizes values in `lib/guard.mjs` — a malformed legacy
 * value must not make the plugin fail to load.
 *
 * Schemastery is vendored under `vendor/` (see `vendor/README.md`) so the
 * plugin also works when inserted by absolute path with no node_modules.
 *
 * @module dsh-root-temp-guard/config
 */

import z from '../vendor/schemastery/index.mjs'
import { DEFAULTS } from './guard.mjs'

const anyDefault = value => z.any().default(value)

/** Root schema; volatile so settings edits apply without a remount. */
export const Config = z
  .object({
    enabled: anyDefault(DEFAULTS.enabled),
    mode: anyDefault(DEFAULTS.mode),
    tmpDirName: anyDefault(DEFAULTS.tmpDirName),
    allowRootNames: anyDefault(DEFAULTS.allowRootNames),
    denyNamePatterns: anyDefault(DEFAULTS.denyNamePatterns),
    denyFileExtensions: anyDefault(DEFAULTS.denyFileExtensions),
    extraWriteTools: anyDefault(DEFAULTS.extraWriteTools),
    extraShellTools: anyDefault(DEFAULTS.extraShellTools),
    quarantine: anyDefault(DEFAULTS.quarantine),
    quarantineDirName: anyDefault(DEFAULTS.quarantineDirName),
    workspaceRoot: anyDefault(DEFAULTS.workspaceRoot),
    logFile: anyDefault(DEFAULTS.logFile),
    reasonTemplate: anyDefault(DEFAULTS.reasonTemplate),
  })
  .volatile()

/**
 * Read the current plain config from whatever `apply()` received.
 *
 * With the root `.volatile()` schema above the loader passes a frozen reference
 * with a `get()` method; when the row has no schema (older loaders/tests) the
 * plain object is used as-is.
 *
 * @param {unknown} raw - `apply()` configuration argument.
 * @returns {Record<string, unknown> | undefined} the current plain config.
 */
export function currentConfigValue(raw) {
  if (raw !== null && typeof raw === 'object' && typeof raw.get === 'function') {
    try {
      return raw.get()
    } catch {
      /* fall through to the raw value */
    }
  }
  return raw !== null && typeof raw === 'object' ? raw : undefined
}
