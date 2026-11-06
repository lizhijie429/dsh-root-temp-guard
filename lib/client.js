/**
 * Browser half of dsh-root-temp-guard: the graphical settings page on the DSH
 * Web Plugins page (row configuration for `dsh-root-temp-guard#root-temp-guard`).
 *
 * It is hand-written in the DSH client bundle format (`__ModuleLoader__.load`)
 * so the package needs no client build step. The page reads the form that the
 * Plugins page hands over (`{ state, mutate }`) and writes the whole live config
 * through `form.mutate` with `{ op: 'set', path, value }` operations. The Host
 * Config schema is root-volatile, so saved values apply without a remount.
 */

window.__ModuleLoader__.load({
  id: 'dsh-root-temp-guard',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** Locale namespace of this page's copy. */
    const NS = 'settings.root-temp-guard'
    /** Loader entry id (also the settings namespace of the row). */
    const ROW_ID = 'root-temp-guard'
    /** Package name; the row config slot key is `<package>#<row id>`. */
    const PACKAGE_NAME = 'dsh-root-temp-guard'

    const zh = {
      summary: '拦截在仓库根目录创建临时文件/目录的工具调用，并清扫本轮新增的根目录临时项。',
      title: '根目录临时文件守卫',
      description: '统一临时目录、拦截规则、清扫策略与日志。保存后立即生效，无需重启。',
      loading: '正在读取配置…',
      unavailable: '当前部署未提供可编辑的配置（插件未加载或配置只读）。',
      readOnly: '当前配置只读。',
      save: '保存',
      saving: '保存中…',
      reset: '恢复默认',
      saved: '已保存，立即生效。',
      failed: '保存失败，请检查取值后重试。',
      invalid: '有字段格式不正确。',
      listHint: '每行一个值。',
      base: '默认值',
      field_enabled: '启用插件',
      field_enabled_hint: '关闭后所有拦截与清扫立即停止（无需重启）。',
      field_mode: '运行模式',
      field_mode_hint: 'deny = 直接拒绝；warn = 只记录 would-deny，便于灰度。',
      field_tmpDirName: '统一临时目录名',
      field_tmpDirName_hint: '仓库根目录下允许的临时目录名，默认 tmp。',
      field_allowRootNames: '额外放行的根目录名',
      field_allowRootNames_hint: '每行一个；在默认规则之上追加。',
      field_denyNamePatterns: '临时目录名规则（正则）',
      field_denyNamePatterns_hint: '每行一个正则，整体替换默认值；留空表示使用默认值。',
      field_denyFileExtensions: '临时文件扩展名',
      field_denyFileExtensions_hint: '每行一个，如 .log；留空关闭扩展名规则。',
      field_extraWriteTools: '额外的文件类工具',
      field_extraWriteTools_hint: '每行一个工具名（按 file_path/path 参数判定）。',
      field_extraShellTools: '额外的命令类工具',
      field_extraShellTools_hint: '每行一个工具名（按 command/text 参数判定）。',
      field_quarantine: '回合结束清扫',
      field_quarantine_hint: 'strict = 移动本轮新增的根目录临时项；off = 关闭清扫。',
      field_quarantineDirName: '清扫目标子目录',
      field_quarantineDirName_hint: '位于统一临时目录下的子目录，默认 _quarantine。',
      field_workspaceRoot: '固定工作区根目录',
      field_workspaceRoot_hint: '留空表示跟随当前会话；仅多工作区部署需要固定。',
      field_logFile: '日志文件',
      field_logFile_hint: '留空使用插件目录下的 state/root-temp-guard.log；相对路径相对插件目录。',
      field_reasonTemplate: '拒绝文案',
      field_reasonTemplate_hint: '支持 {name} 与 {tmpDir} 占位符；留空使用默认文案。',
      mode_deny: 'deny（拒绝）',
      mode_warn: 'warn（仅记录）',
      quarantine_strict: 'strict（清扫）',
      quarantine_off: 'off（关闭）',
    }

    const en = {
      summary: 'Blocks tool calls that create temporary files/directories in the workspace root, and sweeps new root temp entries at turn end.',
      title: 'Root temp guard',
      description: 'Unified temp directory, deny rules, sweep policy and logging. Saves apply immediately, no restart.',
      loading: 'Loading configuration…',
      unavailable: 'This deployment exposes no editable configuration (plugin not loaded, or configuration is read-only).',
      readOnly: 'Configuration is read-only.',
      save: 'Save',
      saving: 'Saving…',
      reset: 'Reset to defaults',
      saved: 'Saved; applies immediately.',
      failed: 'Save failed; check the values and retry.',
      invalid: 'Some fields are invalid.',
      listHint: 'One value per line.',
      base: 'Default',
      field_enabled: 'Enabled',
      field_enabled_hint: 'Turning it off immediately stops all enforcement and sweeping (no restart).',
      field_mode: 'Mode',
      field_mode_hint: 'deny = reject; warn = only log would-deny (staged rollout).',
      field_tmpDirName: 'Unified temp directory',
      field_tmpDirName_hint: 'Allowed temp directory name at the workspace root; default tmp.',
      field_allowRootNames: 'Extra allowed root names',
      field_allowRootNames_hint: 'One per line; appended on top of the defaults.',
      field_denyNamePatterns: 'Temp directory name patterns (regex)',
      field_denyNamePatterns_hint: 'One regex per line, replacing the defaults; empty keeps the defaults.',
      field_denyFileExtensions: 'Temp file extensions',
      field_denyFileExtensions_hint: 'One per line, e.g. .log; empty disables the extension rule.',
      field_extraWriteTools: 'Extra file tools',
      field_extraWriteTools_hint: 'One tool name per line (judged by file_path/path arguments).',
      field_extraShellTools: 'Extra shell tools',
      field_extraShellTools_hint: 'One tool name per line (judged by command/text arguments).',
      field_quarantine: 'Turn-end sweep',
      field_quarantine_hint: 'strict = move new root temp entries; off = disable the sweep.',
      field_quarantineDirName: 'Sweep target directory',
      field_quarantineDirName_hint: 'Subdirectory of the unified temp dir; default _quarantine.',
      field_workspaceRoot: 'Pinned workspace root',
      field_workspaceRoot_hint: 'Leave empty to follow the session; pin it only for multi-workspace deployments.',
      field_logFile: 'Log file',
      field_logFile_hint: 'Empty uses state/root-temp-guard.log in the plugin directory; relative paths resolve against it.',
      field_reasonTemplate: 'Denial text',
      field_reasonTemplate_hint: 'Supports {name} and {tmpDir}; empty uses the default text.',
      mode_deny: 'deny (reject)',
      mode_warn: 'warn (log only)',
      quarantine_strict: 'strict (sweep)',
      quarantine_off: 'off (disabled)',
    }

    const FIELDS = [
      { key: 'enabled', kind: 'boolean' },
      { key: 'mode', kind: 'select', options: ['deny', 'warn'] },
      { key: 'quarantine', kind: 'select', options: ['strict', 'off'] },
      { key: 'tmpDirName', kind: 'text' },
      { key: 'quarantineDirName', kind: 'text' },
      { key: 'allowRootNames', kind: 'list' },
      { key: 'denyNamePatterns', kind: 'list' },
      { key: 'denyFileExtensions', kind: 'list' },
      { key: 'extraWriteTools', kind: 'list' },
      { key: 'extraShellTools', kind: 'list' },
      { key: 'workspaceRoot', kind: 'text' },
      { key: 'logFile', kind: 'text' },
      { key: 'reasonTemplate', kind: 'textarea' },
    ]

    const h = React.createElement

    /** Editable draft: arrays become newline-separated text. */
    function toDraft(value) {
      const draft = {}
      for (const field of FIELDS) {
        const current = value?.[field.key]
        if (field.kind === 'list') draft[field.key] = Array.isArray(current) ? current.join('\n') : ''
        else if (field.kind === 'boolean') draft[field.key] = current === true
        else draft[field.key] = current === undefined || current === null ? '' : String(current)
      }
      return draft
    }

    /** Convert one draft field back to the JSON-shaped config value. */
    function fromDraft(field, raw) {
      if (field.kind === 'boolean') return raw === true
      if (field.kind === 'list') {
        return String(raw ?? '')
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(line => line.length > 0)
      }
      return String(raw ?? '').trim()
    }

    function sameJson(a, b) {
      return JSON.stringify(a) === JSON.stringify(b)
    }

    function label(t, key) {
      const value = t(`field_${key}`)
      return value === `field_${key}` ? key : value
    }

    function hint(t, key) {
      const value = t(`field_${key}_hint`)
      return value === `field_${key}_hint` ? '' : value
    }

    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 8px',
      borderRadius: 6,
      border: '1px solid var(--dsw-color-border, #d0d7de)',
      background: 'var(--dsw-color-bg, #ffffff)',
      color: 'var(--dsw-color-text, #1f2328)',
      font: 'inherit',
    }

    const buttonStyle = {
      padding: '6px 14px',
      borderRadius: 6,
      border: '1px solid var(--dsw-color-border, #d0d7de)',
      background: 'var(--dsw-color-bg-subtle, #f6f8fa)',
      color: 'var(--dsw-color-text, #1f2328)',
      cursor: 'pointer',
      font: 'inherit',
    }

    function Field({ field, t, value, disabled, onChange }) {
      const id = `root-temp-guard-${field.key}`
      let control
      if (field.kind === 'boolean') {
        control = h('input', {
          id,
          type: 'checkbox',
          checked: value === true,
          disabled,
          onChange: event => onChange(event.target.checked),
        })
      } else if (field.kind === 'select') {
        control = h(
          'select',
          { id, style: inputStyle, value, disabled, onChange: event => onChange(event.target.value) },
          field.options.map(option =>
            h('option', { key: option, value: option }, t(`${field.key}_${option}`)),
          ),
        )
      } else if (field.kind === 'textarea' || field.kind === 'list') {
        control = h('textarea', {
          id,
          style: { ...inputStyle, minHeight: field.kind === 'list' ? 72 : 88, resize: 'vertical' },
          value,
          disabled,
          spellCheck: false,
          onChange: event => onChange(event.target.value),
        })
      } else {
        control = h('input', {
          id,
          type: 'text',
          style: inputStyle,
          value,
          disabled,
          onChange: event => onChange(event.target.value),
        })
      }
      const text = hint(t, field.key)
      return h(
        'div',
        { key: field.key, style: { display: 'grid', gap: 4, padding: '8px 0' } },
        h('label', { htmlFor: id, style: { fontWeight: 600, fontSize: 13 } }, label(t, field.key)),
        control,
        field.kind === 'list' ? h('div', { style: { fontSize: 12, opacity: 0.65 } }, t('listHint')) : null,
        text ? h('div', { style: { fontSize: 12, opacity: 0.65 } }, text) : null,
      )
    }

    function SettingsPage(props) {
      const t = typeof props.t === 'function' ? props.t : key => key
      if (props.view === 'summary') return t('summary')

      const form = props.form
      if (!form || !form.state || form.state.status === 'loading') {
        return h('p', { style: { fontSize: 13, opacity: 0.7 } }, t('loading'))
      }
      const state = form.state
      const value = state.value
      if (!value || typeof value !== 'object') {
        return h('p', { style: { fontSize: 13, opacity: 0.7 } }, t('unavailable'))
      }
      const writable = state.writable !== false
      const [draft, setDraft] = React.useState(() => toDraft(value))
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState('')
      const revision = state.revision

      React.useEffect(() => {
        setDraft(toDraft(state.value))
        setMessage('')
        // Reset the draft when the Host accepts/reloads a different revision.
      }, [revision])

      const edit = (key, next) => setDraft(current => ({ ...current, [key]: next }))

      const changed = FIELDS.flatMap(field => {
        const next = fromDraft(field, draft[field.key])
        return sameJson(next, value[field.key]) ? [] : [{ op: 'set', path: [field.key], value: next }]
      })

      const save = async () => {
        if (busy || !writable || changed.length === 0) return
        setBusy(true)
        setMessage('')
        try {
          const accepted = await form.mutate(changed, revision)
          setMessage(accepted ? t('saved') : t('failed'))
        } catch {
          setMessage(t('failed'))
        } finally {
          setBusy(false)
        }
      }

      const reset = async () => {
        if (busy || !writable) return
        setBusy(true)
        setMessage('')
        try {
          const accepted = await form.mutate(
            FIELDS.map(field => ({ op: 'unset', path: [field.key] })),
            revision,
          )
          setMessage(accepted ? t('saved') : t('failed'))
        } catch {
          setMessage(t('failed'))
        } finally {
          setBusy(false)
        }
      }

      return h(
        'section',
        { style: { display: 'grid', gap: 8 } },
        h('h3', { style: { margin: 0, fontSize: 16 } }, t('title')),
        h('p', { style: { margin: 0, fontSize: 13, opacity: 0.75 } }, t('description')),
        writable ? null : h('p', { style: { margin: 0, fontSize: 13, opacity: 0.75 } }, t('readOnly')),
        h(
          'div',
          null,
          FIELDS.map(field =>
            h(Field, {
              key: field.key,
              field,
              t,
              disabled: !writable || busy,
              value: draft[field.key],
              onChange: next => edit(field.key, next),
            }),
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h(
            'button',
            {
              type: 'button',
              style: { ...buttonStyle, opacity: changed.length === 0 || busy ? 0.6 : 1 },
              disabled: busy || !writable || changed.length === 0,
              onClick: save,
            },
            busy ? t('saving') : t('save'),
          ),
          h(
            'button',
            {
              type: 'button',
              style: buttonStyle,
              disabled: busy || !writable,
              onClick: reset,
            },
            t('reset'),
          ),
          message ? h('span', { style: { fontSize: 12, opacity: 0.8 } }, message) : null,
        ),
      )
    }

    /** Required client services. */
    const inject = ['slots', 'locale', 'configForms']

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        'root-temp-guard: settings dictionaries',
      )
      ctx.effect(
        () =>
          ctx.configForms.whileServed([ROW_ID], () =>
            ctx.slots.inject('plugins.row.config', () =>
              ctx.slots.register(
                {
                  name: 'plugins.row.config',
                  id: ROW_ID,
                  key: `${PACKAGE_NAME}#${ROW_ID}`,
                  order: 40,
                  locale: NS,
                  label: () => t('title'),
                },
                SettingsPage,
              ),
            ),
          ),
        'root-temp-guard: settings page',
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.NS = NS
    return module.exports
  },
})