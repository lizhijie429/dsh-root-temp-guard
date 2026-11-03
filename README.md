# dsh-root-temp-guard

[![test](https://github.com/lizhijie429/dsh-root-temp-guard/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/lizhijie429/dsh-root-temp-guard/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/dsh-root-temp-guard.svg)](https://www.npmjs.com/package/dsh-root-temp-guard)

DSH Host 插件：在工具调用层拦截"在工作区根目录创建临时目录 / 临时文件"，把"临时产物统一放临时目录"的项目约定从**文字规则**升级为**执行期拦截**。

> ⚠️ **定位说明**：这是一个**卫生/约定守卫**，不是安全边界。文件类工具走两层判定（工具参数 + 已解析目标），命令类只做启发式文本匹配。不要依赖它防御恶意行为——真正的边界是 DSH 沙箱。

## 三层拦截

1. **工具参数层**：`ctx.tools.guard()` 在工具执行前运行，用工具参数 + 会话**当前工作目录**（`workingDirectory.get(session)`）判定。模型执行 `working_directory { cd: "tmp" }` 后再写 `../_tmp_x`，也会按真实 cwd 解析并拦截。
2. **已解析目标层**：监听 DSH 的 `fs/write-intent` / `fs/edit-intent` waterfall（`write` / `edit` / `str_replace_editor` 都会触发），在 DSH 完成路径解析后、真正写盘前判定。这一层拿到 **realpath 身份**，因此 `tmp/link` 这类 junction/symlink 也无法把根目录临时项藏进允许的 `tmp/` 里。
3. **回合结束清扫**：监听 `session/event` 的 `turn/start` / `turn/end`，把"本轮新出现、且名字像临时项"的根目录条目**移动**（不删除）到 `tmp/_quarantine/<timestamp>-<name>`，可人工恢复。这是对命令类绕过的兜底：即使某条 shell 命令绕过了启发式，回合结束后根目录也不会留下临时项。turn/start 之前已存在的条目不会被动。

三层都 fail-open：插件内部异常一律放行并写日志，不会卡死工具调用。

## 通用性

- **工作区根目录**取自当前会话（`ctx.sandboxPolicy.resolve({session}).workspaceRoot`），换项目自动生效；只有显式配置 `workspaceRoot` 时才固定根目录；
- **相对路径基址**取会话当前工作目录，与 DSH 内置文件工具一致；
- **临时目录名**可配置（`tmpDirName`，默认 `tmp`），额外放行名用 `allowRootNames`；
- **拦截规则、扩展名、拒绝文案、模式、额外工具、日志位置**均可配置；
- 非法配置会写 `config.warning` 日志，而不是静默失效。

## 工作原理

DSH 工具执行管线：

```text
tools/pre-execute → ctx.tools.guard() 单调守卫 → 执行工具
   write/edit/str_replace_editor: fs.resolve → fs/write-intent | fs/edit-intent waterfall → ctx.fs 写盘
```

- 工具守卫通过 `ctx.effect()` 注册，插件卸载/热重载时自动注销；
- waterfall 监听器用 `ctx.on(..., { prepend: true })` 注册，拒绝时抛错并短路后续监听器；
- 对所有 agent 生效，子代理 / workflow / PTC `run_code` 的内部工具调用走同一注册表（**未做端到端集成验证**，见"已知限制"）。

## 默认拦截规则

| 类别 | 例子 | 结果 |
| --- | --- | --- |
| 根目录临时目录（含其下层路径） | `_tmp_probe/x.txt`、`tmp_lead/log.txt`、`.tmp/`、`.._tmp/`、`scratch/`、`test-out/` | 拒绝 |
| 根目录临时文件 | `_tmp_notes.md`、`build.log`、`x.tmp`、`x.bak`、`.log` | 拒绝 |
| 配置的统一临时目录 | `tmp/20261103-dialog-design/a.txt`（`tmpDirName: tmp`） | 允许 |
| 正常仓库路径 | `AGENTS.md`、`docs/01-x.md`、`backend/pom.xml` | 允许 |
| 工作区外路径 | `../other/...`、其他盘符 | 不干预（交给沙箱策略） |

覆盖工具：

- 文件类：`write`、`edit`、`str_replace_editor`（`view` 只读命令放行），工具参数层 + fs-intent 层；
- 命令类：`pwsh`、`bash`、`terminal_send`（`command` / `text`；`workdir` 按当前 cwd 解析，"cd/Set-Location 后的相对名"按新目录解析）。

命令类启发式：命令中出现创建动词（`New-Item`/`mkdir`/`touch`/`Set-Content`/`Add-Content`/`Out-File`/`Copy-Item`/`Move-Item`/`xcopy`/`cp`/`mv`/`tee`/`ln`/`>` 重定向），且某个**路径操作数**解析到根目录下的临时名时拒绝；`-Value`/`-Content` 等自由文本参数会被跳过（避免 `Set-Content -Value "console.log"` 之类误报）。

默认拒绝文案（可用 `reasonTemplate` 覆盖）：

```text
禁止在仓库根目录创建临时项 "_tmp_probe"。临时产物请写入 tmp/<任务名>/ 下；
具体约定见项目约定文件（如 AGENTS.md）中的临时文件规则。
```

## 配置

`config:` 块全部可选：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关（`false` 关闭） |
| `mode` | `deny` | `deny` 拒绝；`warn` 只记 `would-deny` 日志并放行（灰度上线用） |
| `tmpDirName` | `tmp` | 统一临时目录名；必须是单个路径段，非法值回退 `tmp` |
| `allowRootNames` | `[]` | 额外放行的根目录名（在默认规则之上追加） |
| `denyNamePatterns` | `^(?:\.*_?tmp\|\.*temp\|\.*scratch\|\.*test[-_]?out)(?=$|[._-]\|\d)` | 根目录临时名正则；**整体替换默认值**；`[]` 表示保留默认 |
| `denyFileExtensions` | `['.log','.tmp','.bak','.orig','.rej']` | 根目录临时文件扩展名；`[]` 表示关闭扩展名规则 |
| `extraWriteTools` | `[]` | 额外的"文件路径类"工具名（追加到 `write`/`edit`/`str_replace_editor`） |
| `extraShellTools` | `[]` | 额外的"命令类"工具名（追加到 `pwsh`/`bash`/`terminal_send`） |
| `quarantine` | `strict` | `strict` = 回合结束清扫本轮新增的根目录临时项；`off` = 关闭清扫 |
| `quarantineDirName` | `_quarantine` | 清扫目标目录（位于 `tmpDirName` 下），移动而非删除 |
| `reasonTemplate` | 见上 | 拒绝文案，支持 `{name}`、`{tmpDir}` |
| `workspaceRoot` | 空 | **非空时优先于会话解析**（固定根/多工作区部署）；建议绝对路径 |
| `logFile` | `<插件目录>/state/root-temp-guard.log` | 安装/拒绝/配置告警日志；挂载时超过 5MB 自动轮转一次为 `.1` |

示例：临时目录统一叫 `scratchpad`、先灰度观察再拦截：

```yaml
- insert:
    - id: root-temp-guard
      name: 'C:\Users\<你>\.dsh\plugins\dsh-root-temp-guard\index.mjs'
      config:
        mode: warn
        tmpDirName: scratchpad
        reasonTemplate: '临时产物请写入 {tmpDir}/<任务名>/，不要污染仓库根目录：{name}'
```

## 安装

本插件是一个 DSH **profile 组合包（bundle）**：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，安装后 DSH 会自动插入 `root-temp-guard` 行（默认 `tmpDirName: tmp`、`quarantine: strict`），无需手工改 patch。

### 方式一：CLI 安装（web / headless 等 CLI 管理的 profile，推荐）

npm 发布后：

```powershell
dsh plugin --profile web add dsh-root-temp-guard
```

发布前（本地目录安装；本插件无构建步骤）：

```powershell
dsh plugin --profile web add "file:$env:USERPROFILE\.dsh\plugins\dsh-root-temp-guard"
```

`dsh plugin add` 会安装依赖并把包加入 profile 的 `dsh.profile.bundles`，包自带的 `cordis.patch.yml` 随即被加载。验证：

```powershell
dsh --profile web --dump-config | Select-String -Context 0,6 'dsh-root-temp-guard'
```

（已实测：`file:` 安装后 dump 中出现 `- id: root-temp-guard`、`tmpDirName: tmp`、`quarantine: strict`。）

覆盖默认配置：在 profile 自己的 `cordis.patch.yml` 里按 id 覆盖（会整体替换该行的 `config`）：

```yaml
- id: root-temp-guard
  config:
    tmpDirName: scratchpad
```

### 方式二：桌面端（desktop profile，Electron 管理）

desktop profile 由 Electron 独占管理，`dsh plugin` 不直接管理它，仍需在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 末尾按绝对路径插入：

```yaml
- insert:
    - id: root-temp-guard
      name: 'C:\Users\<你>\.dsh\plugins\dsh-root-temp-guard\index.mjs'
      config:
        tmpDirName: tmp
```

`<你>` 替换为实际用户名。desktop profile 的 `patchReload` 默认 `live`：**纯 `config` 改动会重新挂载生效；`index.mjs`/`lib/guard.mjs` 的代码改动受 Node ESM 模块缓存影响，需要重启 DeepSeek Harness**。

### 方式三：临时验证（不改任何 profile）

```powershell
dsh headless --patch <含 root-temp-guard insert 的 yaml> "hello"
```

## 验证

```powershell
cd "$env:USERPROFILE\.dsh\plugins\dsh-root-temp-guard"
node --test "test/*.test.mjs"   # 48 个用例，含真实文件系统 quarantine 套件
npm pack --dry-run              # 校验 npm 包内容（含 cordis.patch.yml）
Get-Content state\root-temp-guard.log
```

日志示例：

```text
2026-11-03T... plugin.mounted pid=... mode=deny
2026-11-03T... deny source=tool tool=pwsh reason=禁止在仓库根目录创建临时项 "_tmp_probe"...
2026-11-03T... deny source=fs tool=write target=...\tmp\link\_tmp_x\a.txt reason=...
2026-11-03T... quarantine.moved name=_tmp_sneaky -> ...\tmp\_quarantine\2026-11-03T...-_tmp_sneaky
2026-11-03T... quarantine.done moved=1 dir=...\tmp\_quarantine
2026-11-03T... plugin.disposed
```

## 插件市场与社区收录

除 `dsh plugin add` 安装外，本仓库还发布了一份 **DSH 插件市场索引（format 1）**，托管在 GitHub Pages：

- 索引地址：<https://lizhijie429.github.io/dsh-root-temp-guard/index.json>
- 在 DSH 中订阅：**插件 → 实验性插件 → 打开「自定义插件市场」→「发现」→「添加索引源」**，粘贴上面的地址
- 生成/更新：`npm run market:index`（固定当前 `HEAD` 的 commit 与提交时间，并把图标复制到 `docs/icons/`）；提交 `docs/` 后 Pages 自动刷新
- 索引已用官方校验器 `@deepseek-ai/dsh-plugin-market-index` 的 `parseMarketIndex` + `marketInstallTarget` 校验通过

社区目录：

- **awesome-dsh-plugin**：提交 `data/plugins/lizhijie429__dsh-root-temp-guard.yml` 的 PR（仓库需带 `dsh-plugin` topic 且创建满 1 天；CI 会在达到年龄后自动转绿）
- **deepseekplugin.org**：在 <https://deepseekplugin.org/submit> 粘贴本仓库 URL，自动识别 `dsh-plugin` topic 后即时收录
- **npm**：发布后可直接 `dsh plugin --profile web add dsh-root-temp-guard`

## 已知限制

- **不是安全边界**：命令类是启发式文本匹配，`node -e "fs.mkdirSync(...)"`、`xcopy`/`robocopy`、shell 变量/函数/别名、PowerShell 管道拼接、脚本内部间接建目录均可绕过。
- **命令类只跟踪简单 `cd`/`Set-Location`**：`pushd` 栈、变量展开（`$DIR`、`%TEMP%`、`~`）按"未知目标 → 回到根目录基准"处理（deny-biased，可能误伤）；管道子命令里的 cd 不跟踪。
- **符号链接 / junction**：文件类工具的写盘走 fs-intent 层，用 realpath 身份判定，`tmp/link` 藏根目录临时项会被拒绝；但**命令类**（shell 文本）仍按字面判定，无法感知 junction。普通 UNC 路径（`\\server\share`）被视为工作区外，不干预。
- **fs-intent 层只覆盖经 `write`/`edit`/`str_replace_editor` 的写**：其它插件直接调用 `ctx.fs` 服务（不触发 intent）不在覆盖范围。
- **只覆盖已知工具与工具管线**：新工具可通过 `extraWriteTools`/`extraShellTools` 追加。
- **agentless 调用不拦截**：没有 session 的调用拿不到工作区上下文，守卫直接放行（fail-open）。
- **子代理 / workflow / PTC 覆盖未做端到端验证**：机制上走同一注册表，但未集成测试；不要把这条当保证。
- **清扫只处理"本轮新增"**：turn/start 前已存在的临时目录不会被动；baseline 读取失败时整轮跳过；移动而非删除（`tmp/_quarantine/` 可恢复）；每轮最多移动 50 个；`mode: warn` 下只记 `would-move` 不移动。清扫发生在 turn/end：若某后台进程仍在写该目录，重命名可能失败并记录 `quarantine.move-failed`。
- **日志**：挂载时轮转一次（>5MB → `.1`），运行期间不轮转；写失败被吞。
- **fail-open**：内部异常放行并记录 `guard.error` / `fs-intent.error`。

## 卸载

删除 `cordis.patch.yml` 中对应 `insert` 段，或把 `config.enabled` 设为 `false` 后重启。

## License

MIT，见 [LICENSE](LICENSE)。
