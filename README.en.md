# dsh-root-temp-guard

[![test](https://github.com/lizhijie429/dsh-root-temp-guard/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/lizhijie429/dsh-root-temp-guard/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/dsh-root-temp-guard.svg)](https://www.npmjs.com/package/dsh-root-temp-guard)

[English](README.en.md) | [简体中文](README.md)

A DSH host plugin that intercepts tool calls creating temporary directories/files in the workspace root, turning "keep temporary artifacts under one temp directory" from a **written convention** into an **enforced check**.

> ⚠️ **Scope**: this is a **hygiene/convention guard**, not a security boundary. File tools are checked by an argument layer (early deny + monotonic guard) and a resolved-target layer; shell commands are matched heuristically. Do not rely on it against malicious behaviour — the real boundary is the DSH sandbox.

## Four enforcement layers

1. **Early-deny layer** (DSH 0.2.2+): `tools/pre-execute` runs **before approval resolution** and returns `deny` for a temp-creating call, so the user is not asked to approve something that will be rejected anyway. In `warn` mode it only logs `stage=pre` and continues.
2. **Monotonic guard layer**: `ctx.tools.guard()` runs after approval and before execution, evaluating the arguments together with the session's **current working directory** (`workingDirectory.get(session)`). It is an owner policy, so another plugin cannot turn its denial back into an allow. If the model runs `working_directory { cd: "tmp" }` and then writes `../_tmp_x`, the path is resolved against the real cwd and still denied.
3. **Resolved-target layer**: listens to DSH's `fs/write-intent` / `fs/edit-intent` waterfalls (emitted by `write`, `edit`, `str_replace_editor` and `apply_patch`) and decides after DSH resolved the path but before the write happens. This layer has the **realpath identity**, so a junction/symlink such as `tmp/link` cannot hide a root-level temp entry under the allowed `tmp/`.
4. **Turn-end sweep**: listens to `session/event` (`turn/start` / `turn/end`) and **moves** (never deletes) root entries that are new in this turn and look like temp artifacts into `tmp/_quarantine/<timestamp>-<name>`, where they can be recovered manually. This is the backstop for shell bypasses: even if a shell command slips past the heuristic, the root does not keep a temp entry after the turn. Entries that existed before `turn/start` are never touched.
   - **Concurrent sessions**: when several sessions have an active turn on the same workspace root (Agent Teams / workflow / multiple windows), the sweep is **deferred until the last active turn ends** (`quarantine.deferred`), so another session's files are not moved mid-turn; single-session behavior is unchanged.
   - **Truncation retry**: at most 50 entries are moved per sweep; entries over the cap or whose `rename` failed are remembered as pending and retried by later sweeps (`quarantine.truncated` / `quarantine.move-failed`).

All four layers are fail-open: internal errors allow the call and are logged, so they never wedge the tool pipeline.

**Compatibility**: verified on DSH `0.2.2-rc.1`; `engines.dsh` stays `>=0.2.1-0 <0.3.0`, the 0.2.2 `apply_patch` tool is covered automatically, and older versions without that tool are unaffected.

## Generality

- **Workspace root** comes from the current session (`ctx.sandboxPolicy.resolve({session}).workspaceRoot`) and adapts to any project; only an explicit `workspaceRoot` pins it.
- **Relative-path base** is the session's current working directory, matching DSH's own file tools.
- **Temp directory name** is configurable (`tmpDirName`, default `tmp`); extra allowed names go in `allowRootNames`.
- **Deny rules, extensions, denial text, mode, extra tools and log location** are all configurable.
- Invalid configuration is reported as `config.warning` log lines instead of silently disabling rules.

## How it works

DSH tool pipeline:

```text
tools/pre-execute early deny → ctx.tools.guard() monotonic guard → tool body
   write/edit/str_replace_editor/apply_patch: fs.resolve → fs/write-intent | fs/edit-intent waterfall → ctx.fs write
```

- Both tool gates are registered through `ctx.effect()`, so they unregister on plugin unmount/hot reload.
- Waterfall listeners are registered with `ctx.on(..., { prepend: true })`; a denial throws and short-circuits the remaining listeners.
- Applies to every agent; nested subagent / workflow / PTC `run_code` tool calls share the same registry (**no end-to-end integration test yet**, see "Known limitations").

## Default deny rules

| Category | Examples | Result |
| --- | --- | --- |
| Root-level temp directory (including paths below it) | `_tmp_probe/x.txt`, `tmp_lead/log.txt`, `.tmp/`, `.._tmp/`, `scratch/`, `test-out/` | denied |
| Root-level temp file | `_tmp_notes.md`, `build.log`, `x.tmp`, `x.bak`, `.log` | denied |
| `apply_patch` target | `*** Add File: _tmp_probe/a.txt`, `*** Move to: tmp_lead/b.md` | denied |
| `apply_patch` deletion | `*** Delete File: build.log` | allowed (deletion is not creation) |
| Configured unified temp dir | `tmp/20261103-dialog-design/a.txt` (`tmpDirName: tmp`) | allowed |
| Normal repository paths | `AGENTS.md`, `docs/01-x.md`, `backend/pom.xml` | allowed |
| Paths outside the workspace | `../other/...`, another drive | left alone (sandbox policy applies) |

Covered tools:

- File tools: `write`, `edit`, `str_replace_editor` (the read-only `view` command is allowed), `apply_patch` (paths from `*** Add File:`, `*** Update File:` and `*** Move to:` are checked; `*** Delete File:` is a deletion, not a creation, and stays allowed) — argument layer + fs-intent layer.
- Shell tools: `pwsh`, `bash`, `terminal_send` (`command` / `text`; `workdir` is resolved against the current cwd, and relative names after `cd`/`Set-Location` use the new directory).

Shell heuristic: when the command contains a creation verb (`New-Item`/`mkdir`/`touch`/`Set-Content`/`Add-Content`/`Out-File`/`Copy-Item`/`Move-Item`/`xcopy`/`cp`/`mv`/`tee`/`ln`/`>` redirection) and one of its **path operands** resolves to a root-level temp name, the call is denied. Free-text arguments such as `-Value`/`-Content` are skipped to avoid false positives like `Set-Content -Value "console.log"`; inline operands such as `-FilePath:_tmp/a` and `--target-directory=_tmp` are inspected as paths too.

Default denial text (overridable with `reasonTemplate`):

```text
Refusing to create temporary entry "_tmp_probe" in the repository root. Write temporary artifacts under
tmp/<task-name>/ instead (see the project convention file, e.g. AGENTS.md).
```

## Configuration

The `config:` block is entirely optional:

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch (`false` disables the plugin) |
| `mode` | `deny` | `deny` rejects; `warn` only logs `would-deny` and allows (staged rollout) |
| `tmpDirName` | `tmp` | Unified temp directory name; must be a single path segment, invalid values fall back to `tmp` |
| `allowRootNames` | `[]` | Extra allowed root-level names (appended on top of the defaults) |
| `denyNamePatterns` | `^(?:\.*_?tmp\|\.*temp\|\.*scratch\|\.*test[-_]?out)(?=$|[._-]\|\d)` | Root-level temp-name regex; **replaces the defaults**; `[]` keeps the defaults |
| `denyFileExtensions` | `['.log','.tmp','.bak','.orig','.rej']` | Root-level temp-file extensions; `[]` disables the extension rule |
| `extraWriteTools` | `[]` | Extra "file-path" tool names (added to `write`/`edit`/`str_replace_editor`) |
| `extraShellTools` | `[]` | Extra "shell" tool names (added to `pwsh`/`bash`/`terminal_send`) |
| `quarantine` | `strict` | `strict` = sweep new root-level temp entries at turn end; `off` = disable the sweep |
| `quarantineDirName` | `_quarantine` | Sweep target directory (under `tmpDirName`); entries are moved, not deleted |
| `reasonTemplate` | see above | Denial text; supports `{name}` and `{tmpDir}` |
| `workspaceRoot` | empty | **When non-empty it wins over session resolution** (fixed root / multi-workspace deployments); absolute path recommended |
| `logFile` | `<plugin dir>/state/root-temp-guard.log` | Install/deny/config-warning log; rotated once to `.1` when it exceeds 5 MB at mount |

Example — use `scratchpad` as the temp directory and observe in `warn` mode first:

```yaml
- insert:
    - id: root-temp-guard
      name: 'C:\Users\<you>\.dsh\plugins\dsh-root-temp-guard\index.mjs'
      config:
        mode: warn
        tmpDirName: scratchpad
        reasonTemplate: 'Write temporary artifacts under {tmpDir}/<task-name>/ instead: {name}'
```

## Install

The plugin is a DSH **profile bundle**: `package.json` declares `dsh.bundle.patch` → `cordis.patch.yml`, so installing it makes DSH insert the `root-temp-guard` row automatically (defaults: `tmpDirName: tmp`, `quarantine: strict`). No manual patch edit required.

### Option 1 — CLI install (CLI-managed profiles such as web/headless; recommended)

After the npm release:

```powershell
dsh plugin --profile web add dsh-root-temp-guard
```

Before the npm release (local directory; the plugin has no build step):

```powershell
dsh plugin --profile web add "file:$env:USERPROFILE\.dsh\plugins\dsh-root-temp-guard"
```

`dsh plugin add` installs the dependency and adds the package to the profile's `dsh.profile.bundles`; the bundled `cordis.patch.yml` is then loaded. Verify:

```powershell
dsh --profile web --dump-config | Select-String -Context 0,6 'dsh-root-temp-guard'
```

(Verified locally: after a `file:` install the dump contains `- id: root-temp-guard`, `tmpDirName: tmp`, `quarantine: strict`.)

Override defaults from the profile's own `cordis.patch.yml` by id (this replaces that row's whole `config`):

```yaml
- id: root-temp-guard
  config:
    tmpDirName: scratchpad
```

### Option 2 — Desktop profile (Electron-managed)

The desktop profile is owned by the Electron app; `dsh plugin` does not manage it. Insert the plugin by absolute path in `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`:

```yaml
- insert:
    - id: root-temp-guard
      name: 'C:\Users\<you>\.dsh\plugins\dsh-root-temp-guard\index.mjs'
      config:
        tmpDirName: tmp
```

Replace `<you>` with your user name. The desktop profile's `patchReload` defaults to `live`: **config-only changes remount live; code changes to `index.mjs`/`lib/guard.mjs` are affected by Node's ESM module cache and need a DeepSeek Harness restart.**

### Option 3 — Temporary check without touching any profile

```powershell
dsh headless --patch <yaml containing the root-temp-guard insert> "hello"
```

## Graphical settings page

Once installed, the DSH Web client loads this package's browser half (`dsh.client`), with two entry points:

- **Plugins → "Built-in plugin configuration" → the "Root temp guard" card**: provided by `plugins.item`; it does **not** require installing the package as a bundle, so a desktop profile inserted by absolute path gets it too;
- **Plugins → Installed → `dsh-root-temp-guard` → the `root-temp-guard` row → Configure**: only for bundle installs; it opens the same form as the card.

The desktop app's embedded Web UI works the same way.

- The page covers every option: enabled switch, `deny`/`warn`, unified temp directory, sweep policy and target directory, extra allowed names, name regexes, extensions, extra file/shell tools, pinned root, log file and denial text;
- Saving goes through the DSH settings service (`ctx.configForms`) into the profile's Cordis patch; the Host `Config` schema is root-`.volatile()`, so **saved values apply immediately without a restart or remount**;
- Reset clears that field's profile override (back to the inherited/default value);
- **Restart the host once after upgrading**: the browser half is loaded at startup, so the card/Configure entry above appears only after a restart;
- headless / ACP profiles have no Web client, so they show no page; edit `cordis.patch.yml` as described below;
- `vendor/` contains `@deepseek-ai/schemastery` and `@deepseek-ai/cosmokit` (MIT, see `vendor/README.md`), so a desktop profile inserted by absolute path with no `node_modules` still gets the schema without extra npm dependencies.

> The browser half is a hand-written bundle (`lib/client.js`, DSH `__ModuleLoader__` format, no build step); `dsh.client.platform` is `web` only, so pure CLI hosts never load it.

## Verify

```powershell
cd "$env:USERPROFILE\.dsh\plugins\dsh-root-temp-guard"
node --test "test/*.test.mjs"   # 70 cases, including real-filesystem quarantine, Config schema and client-bundle tests
npm pack --dry-run              # validate npm package contents (includes cordis.patch.yml)
Get-Content state\root-temp-guard.log
```

Example log:

```text
2026-11-03T... plugin.mounted pid=... mode=deny quarantine=strict
2026-11-03T... deny source=tool tool=pwsh reason=...
2026-11-03T... deny source=fs tool=write target=...\tmp\link\_tmp_x\a.txt reason=...
2026-11-03T... quarantine.moved name=_tmp_sneaky -> ...\tmp\_quarantine\2026-11-03T...-_tmp_sneaky
2026-11-03T... quarantine.done moved=1 dir=...\tmp\_quarantine
2026-11-03T... plugin.disposed
```

## Plugin market and community listings

Besides `dsh plugin add`, this repository publishes a **DSH plugin-market index (format 1)** on GitHub Pages:

- Index URL: <https://lizhijie429.github.io/dsh-root-temp-guard/index.json>
- Subscribe in DSH: **Plugins → Experimental plugins → enable "Custom plugin market" → "Discover" → "Add index source"**, then paste the URL
- Regenerate: `npm run market:index` (pins the current `HEAD` commit and timestamp, and copies the icon into `docs/icons/`); committing `docs/` refreshes Pages automatically
- The index is validated with the official `@deepseek-ai/dsh-plugin-market-index` (`parseMarketIndex` + `marketInstallTarget`)

Community directories:

- **awesome-dsh-plugin**: PR adding `data/plugins/lizhijie429__dsh-root-temp-guard.yml` ([#11726](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/11726)). The list requires repositories to be at least one day old; until then CI is red and re-runs itself to green once the age threshold is met — no need to reopen the PR.
- **deepseekplugin.org**: paste this repository's URL at <https://deepseekplugin.org/submit> (no account; listed immediately after automatic parsing). The repository already carries the `dsh-plugin` topic required for recognition.
- **npm**: once published, `dsh plugin --profile web add dsh-root-temp-guard` works directly.

## Known limitations

- **Not a security boundary**: shell checks are heuristic text matching; `node -e "fs.mkdirSync(...)"`, `xcopy`/`robocopy`, shell variables/functions/aliases, PowerShell pipeline composition and scripts that create directories indirectly can bypass it.
- **Shell checks only track simple `cd`/`Set-Location`**: `pushd` stacks and variable expansion (`$DIR`, `%TEMP%`, `~`) fall back to the workspace-root base (deny-biased, may cause false positives); `cd` inside pipeline subcommands is not tracked.
- **Symlinks / junctions**: file-tool writes go through the fs-intent layer and are judged by realpath identity, so a root temp entry hidden behind `tmp/link` is denied; **shell text** is still matched literally and cannot see junctions. Plain UNC paths (`\\server\share`) are treated as outside the workspace and left alone.
- **The fs-intent layer only covers write/edit intents**: `fs/write-intent` and `fs/edit-intent` cover `write`/`edit`/`str_replace_editor`/`apply_patch`; the 0.2.2 `fs/delete-intent` and `fs/observed` events are not observed here (deletion is not creation, observation is not mutation). Other plugins calling the `ctx.fs` service directly (no intent event) are not covered.
- **Only known tools/pipelines are covered**: built-ins `write`/`edit`/`str_replace_editor`/`apply_patch`/`pwsh`/`bash`/`terminal_send` are covered by default; new path-shaped tools can be added via `extraWriteTools` and new shell tools via `extraShellTools`; patch-shaped third-party tools need parser support in code.
- **MCP / third-party plugin tools are not covered by default**: arbitrary tool names registered by `dsh-mcp-client` or other plugins (e.g. a filesystem MCP's `write_file`/`create_directory`) are outside the default sets, and they usually do not go through `ctx.fs` intents either, so only the turn-end sweep (when the name matches) or the sandbox stops them. Add them explicitly with `extraWriteTools`/`extraShellTools` when needed.
- **Direct filesystem calls inside PTC `run_code` programs**: nested **tool** calls go through the same policy pipeline (guarded), but code that calls `fs` directly (e.g. `require('fs').mkdirSync`) bypasses `ctx.tools`/`ctx.fs` and is only covered by the sweep/sandbox.
- **Agentless calls are not checked**: without a session there is no workspace context, so the guard allows the call (fail-open).
- **The graphical settings page only exists in the Web client**: headless / ACP profiles have no browser half, so they neither show the page nor load `lib/client.js`; edit `cordis.patch.yml` there. The page also needs DSH's settings/config-editor services (the 0.2.2 base bundle provides them).
- **The Config schema is intentionally permissive**: root `.volatile()` plus `any` fields keep legacy configs loadable and make every field editable by the page; invalid values are still reported by `normalizeConfig` at runtime and fall back to defaults, so a bad value may save but behave as the fallback.
- **Subagent / workflow / PTC coverage is not end-to-end tested**: they share the same registry in principle, but there is no integration test yet; do not treat it as a guarantee. (Concurrent sessions are handled by deferring the sweep per root until the last turn, see "Four enforcement layers".)
- **Sweep semantics**: temp directories that already existed before `turn/start` are untouched; when the baseline read fails that root is skipped; entries are moved (recoverable under `tmp/_quarantine/`), at most 50 per sweep, and entries over the cap or whose rename failed become pending and are retried by later sweeps (up to 500 remembered per root); in `mode: warn` only `would-move` is logged. If a background process still writes into the directory, the rename can fail and is logged as `quarantine.move-failed` (also retried).
- **Logging**: rotated once at mount (>5 MB → `.1`), not rotated while running; write failures are swallowed.
- **Fail-open**: internal errors allow the call and are logged as `guard.error` / `pre-execute.error` / `fs-intent.error`.

## Uninstall

Remove the corresponding `insert` entry from `cordis.patch.yml`, or set `config.enabled` to `false` and restart.

## License

MIT — see [LICENSE](LICENSE).
