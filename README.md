# dsh-root-temp-guard

[![test](https://github.com/lizhijie429/dsh-root-temp-guard/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/lizhijie429/dsh-root-temp-guard/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/dsh-root-temp-guard.svg)](https://www.npmjs.com/package/dsh-root-temp-guard)

[English](README.en.md) | 简体中文

DSH Host 插件：在工具调用层拦截"在工作区根目录创建临时目录 / 临时文件"，把"临时产物统一放临时目录"的项目约定从**文字规则**升级为**执行期拦截**。

> ⚠️ **定位说明**：这是一个**卫生/约定守卫**，不是安全边界。文件类工具走参数层（提前拒绝 + 单调守卫）与已解析目标层，命令类只做启发式文本匹配。不要依赖它防御恶意行为——真正的边界是 DSH 沙箱。

## 四层拦截

1. **提前拒绝层**（DSH 0.2.2+）：`tools/pre-execute` 在**审批之前**运行，命中临时项时直接返回 `deny`，不会先弹审批再拒绝；`warn` 模式下只记 `stage=pre` 日志并继续。
2. **单调守卫层**：`ctx.tools.guard()` 在审批之后、执行之前运行，用工具参数 + 会话**当前工作目录**（`workingDirectory.get(session)`）判定。它是 owner policy，其它插件无法把拒绝改回允许。模型执行 `working_directory { cd: "tmp" }` 后再写 `../_tmp_x`，也会按真实 cwd 解析并拦截。
3. **已解析目标层**：监听 DSH 的 `fs/write-intent` / `fs/edit-intent` waterfall（`write` / `edit` / `str_replace_editor` / `apply_patch` 都会触发），在 DSH 完成路径解析后、真正写盘前判定。这一层拿到 **realpath 身份**，因此 `tmp/link` 这类 junction/symlink 也无法把根目录临时项藏进允许的 `tmp/` 里。
4. **回合结束清扫**：监听 `session/event` 的 `turn/start` / `turn/end`，把"本轮新出现、且名字像临时项"的根目录条目**移动**（不删除）到 `tmp/_quarantine/<timestamp>-<name>`，可人工恢复。这是对命令类绕过的兜底：即使某条 shell 命令绕过了启发式，回合结束后根目录也不会留下临时项。turn/start 之前已存在的条目不会被动。
   - **并发会话安全**：同一 workspace 有多个活跃回合（Agent Teams / workflow / 多窗口）时，清扫会**延迟到最后一个回合结束**再执行（日志 `quarantine.deferred`），避免把其它会话正在用的文件移走；单会话时行为不变。
   - **截断重试**：单次最多移动 50 个；超出上限或 `rename` 失败的条目会记入 pending，由后续回合继续清扫（日志 `quarantine.truncated` / `quarantine.move-failed`）。

四层都 fail-open：插件内部异常一律放行并写日志，不会卡死工具调用。

**兼容性**：已在 DSH `0.2.2-rc.1` 上验证；`engines.dsh` 保持 `>=0.2.1-0 <0.3.0`，0.2.2 新增的 `apply_patch` 工具自动纳入覆盖，0.2.1 及更早版本缺少该工具时不受影响。

## 通用性

- **工作区根目录**取自当前会话（`ctx.sandboxPolicy.resolve({session}).workspaceRoot`），换项目自动生效；只有显式配置 `workspaceRoot` 时才固定根目录；
- **相对路径基址**取会话当前工作目录，与 DSH 内置文件工具一致；
- **临时目录名**可配置（`tmpDirName`，默认 `tmp`），额外放行名用 `allowRootNames`；
- **拦截规则、扩展名、拒绝文案、模式、额外工具、日志位置**均可配置；
- 非法配置会写 `config.warning` 日志，而不是静默失效。

## 工作原理

DSH 工具执行管线：

```text
tools/pre-execute 提前拒绝 → ctx.tools.guard() 单调守卫 → 执行工具
   write/edit/str_replace_editor/apply_patch: fs.resolve → fs/write-intent | fs/edit-intent waterfall → ctx.fs 写盘
```

- 提前拒绝层与单调守卫层都通过 `ctx.effect()` 注册，插件卸载/热重载时自动注销；
- waterfall 监听器用 `ctx.on(..., { prepend: true })` 注册，拒绝时抛错并短路后续监听器；
- 对所有 agent 生效，子代理 / workflow / PTC `run_code` 的内部工具调用走同一注册表（**未做端到端集成验证**，见"已知限制"）。

## 默认拦截规则

| 类别 | 例子 | 结果 |
| --- | --- | --- |
| 根目录临时目录（含其下层路径） | `_tmp_probe/x.txt`、`tmp_lead/log.txt`、`.tmp/`、`.._tmp/`、`scratch/`、`test-out/` | 拒绝 |
| 根目录临时文件 | `_tmp_notes.md`、`build.log`、`x.tmp`、`x.bak`、`.log` | 拒绝 |
| `apply_patch` 补丁目标 | `*** Add File: _tmp_probe/a.txt`、`*** Move to: tmp_lead/b.md` | 拒绝 |
| `apply_patch` 删除 | `*** Delete File: build.log` | 允许（删除不是创建） |
| 配置的统一临时目录 | `tmp/20261103-dialog-design/a.txt`（`tmpDirName: tmp`） | 允许 |
| 正常仓库路径 | `AGENTS.md`、`docs/01-x.md`、`backend/pom.xml` | 允许 |
| 工作区外路径 | `../other/...`、其他盘符 | 不干预（交给沙箱策略） |

覆盖工具：

- 文件类：`write`、`edit`、`str_replace_editor`（`view` 只读命令放行）、`apply_patch`（解析 `*** Add File:` / `*** Update File:` / `*** Move to:` 的路径；`*** Delete File:` 是删除而非创建，放行），参数层 + fs-intent 层；
- 命令类：`pwsh`、`bash`、`terminal_send`（`command` / `text`；`workdir` 按当前 cwd 解析，"cd/Set-Location 后的相对名"按新目录解析）。

命令类启发式：命令中出现创建动词（`New-Item`/`mkdir`/`touch`/`Set-Content`/`Add-Content`/`Out-File`/`Copy-Item`/`Move-Item`/`xcopy`/`cp`/`mv`/`tee`/`ln`/`>` 重定向），且某个**路径操作数**解析到根目录下的临时名时拒绝；`-Value`/`-Content` 等自由文本参数会被跳过（避免 `Set-Content -Value "console.log"` 之类误报）；`-FilePath:_tmp/a`、`--target-directory=_tmp` 这类"参数内嵌值"也会作为路径检查。

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

## 图形化设置页

安装后 DSH Web 界面会加载本包的浏览器半侧（`dsh.client`），有两个入口：

- **插件页 → 「内置插件配置」→「根目录临时文件守卫」卡片**：卡片由 `plugins.item` 提供，**不要求把包安装为组合包**，按绝对路径手动插入的桌面 profile 也会出现；
- **插件页 → 已安装 → `dsh-root-temp-guard` → 行 `root-temp-guard` 的「配置」**：仅以组合包安装时出现，和上面的卡片打开同一个表单。

桌面端内嵌的 Web UI 同样可用。

- 页面覆盖全部配置项：启用开关、`deny`/`warn`、统一临时目录、清扫策略与目标目录、额外放行名、名称正则、扩展名、额外文件/命令工具、固定根目录、日志与拒绝文案；
- 保存通过 DSH 设置服务（`ctx.configForms`）写入 profile 的 Cordis patch；Host `Config` schema 根节点是 `.volatile()`，**保存后立即生效，无需重启或重挂载**；
- 「恢复默认」会清除该字段的 profile 覆盖层（回到继承值/默认值）；
- **升级后需要重启一次宿主**：浏览器半侧在启动时加载，重启后才会出现上面的卡片/配置入口；
- headless / ACP 等没有 Web 客户端的 profile 不显示设置页，仍按下文的 `cordis.patch.yml` 编辑；
- `vendor/` 内置了 `@deepseek-ai/schemastery` 与 `@deepseek-ai/cosmokit`（MIT，见 `vendor/README.md`），因此按绝对路径插入、没有 `node_modules` 的桌面 profile 也能提供 schema，无需额外 npm 依赖。

> 浏览器半侧是手写 bundle（`lib/client.js`，遵循 DSH `__ModuleLoader__` 格式，无需构建步骤）；`dsh.client.platform` 仅声明 `web`，纯 CLI 宿主不会加载它。

## 验证

```powershell
cd "$env:USERPROFILE\.dsh\plugins\dsh-root-temp-guard"
node --test "test/*.test.mjs"   # 70 个用例，含真实文件系统 quarantine、Config schema 与客户端 bundle 测试
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

- **awesome-dsh-plugin**：提交 `data/plugins/lizhijie429__dsh-root-temp-guard.yml` 的 PR（[#11726](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/11726)）。该列表要求仓库创建满 1 天，未满时 CI 会先标红，达到年龄后自动 re-run 转绿，无需重开 PR
- **deepseekplugin.org**：在 <https://deepseekplugin.org/submit> 粘贴本仓库 URL 即可（无账号、自动解析后即时上架）；本仓库已加 `dsh-plugin` topic，满足其自动识别条件
- **npm**：发布后可直接 `dsh plugin --profile web add dsh-root-temp-guard`

## 已知限制

- **不是安全边界**：命令类是启发式文本匹配，`node -e "fs.mkdirSync(...)"`、`xcopy`/`robocopy`、shell 变量/函数/别名、PowerShell 管道拼接、脚本内部间接建目录均可绕过。
- **命令类只跟踪简单 `cd`/`Set-Location`**：`pushd` 栈、变量展开（`$DIR`、`%TEMP%`、`~`）按"未知目标 → 回到根目录基准"处理（deny-biased，可能误伤）；管道子命令里的 cd 不跟踪。
- **符号链接 / junction**：文件类工具的写盘走 fs-intent 层，用 realpath 身份判定，`tmp/link` 藏根目录临时项会被拒绝；但**命令类**（shell 文本）仍按字面判定，无法感知 junction。普通 UNC 路径（`\\server\share`）被视为工作区外，不干预。
- **fs-intent 层只覆盖写/编辑类 intent**：`fs/write-intent`、`fs/edit-intent` 覆盖 `write`/`edit`/`str_replace_editor`/`apply_patch`；0.2.2 新增的 `fs/delete-intent` 与 `fs/observed` 不在本插件监听范围（删除不是创建，观测不是变更）。其它插件直接调用 `ctx.fs` 服务（不触发 intent）不在覆盖范围。
- **只覆盖已知工具与工具管线**：DSH 内置的 `write`/`edit`/`str_replace_editor`/`apply_patch`/`pwsh`/`bash`/`terminal_send` 默认覆盖；`apply_patch` 已内置；其它新文件工具可通过 `extraWriteTools`（`file_path`/`path` 参数）或 `extraShellTools` 追加，补丁型工具需在代码中按 `input` 解析。
- **MCP / 第三方插件工具默认不覆盖**：`dsh-mcp-client` 或其它插件注册的任意工具名（如 filesystem MCP 的 `write_file`/`create_directory`）不在默认工具集内；它们通常也不走 `ctx.fs` intent，只能靠回合结束清扫（名称匹配时）或沙箱兜底。需要时用 `extraWriteTools`/`extraShellTools` 显式追加。
- **PTC `run_code` 内的直接文件系统调用**：嵌套**工具**调用会经过同一策略流水线（守卫生效），但程序代码若直接调用 `fs`（如 `require('fs').mkdirSync`）不经过 `ctx.tools`/`ctx.fs`，插件看不到，只有清扫/沙箱兜底。
- **agentless 调用不拦截**：没有 session 的调用拿不到工作区上下文，守卫直接放行（fail-open）。
- **图形化设置页只在 Web 客户端可用**：headless / ACP 等没有浏览器半侧的 profile 不显示设置页，也不会加载 `lib/client.js`；这些部署仍用 `cordis.patch.yml` 编辑。设置页还要求 DSH 自带的 settings/config-editor 服务（0.2.2 基础组合包已提供）。
- **Config schema 有意宽松**：根节点 `.volatile()` + 字段 `any` 让旧配置不会因类型不符而加载失败，也保证设置页可编辑；非法值仍由运行时 `normalizeConfig` 告警并按默认值回退，因此表单里填错不会"存不进去"，但运行时行为按回退值执行。
- **子代理 / workflow / PTC 覆盖未做端到端验证**：机制上走同一注册表，但未集成测试；不要把这条当保证（并发会话的清扫已按 root 延迟到最后回合，见"四层拦截"）。
- **清扫语义**：turn/start 前已存在的临时目录不会被动；baseline 读取失败时跳过该 root；移动而非删除（`tmp/_quarantine/` 可恢复）；单次最多移动 50 个，超出/失败项进入 pending 由后续回合重试（最多记 500 个/root）；`mode: warn` 下只记 `would-move` 不移动。若某后台进程仍在写该目录，重命名可能失败并记录 `quarantine.move-failed`（同样进入 pending）。
- **日志**：挂载时轮转一次（>5MB → `.1`），运行期间不轮转；写失败被吞。
- **fail-open**：内部异常放行并记录 `guard.error` / `pre-execute.error` / `fs-intent.error`。

## 卸载

删除 `cordis.patch.yml` 中对应 `insert` 段，或把 `config.enabled` 设为 `false` 后重启。

## License

MIT，见 [LICENSE](LICENSE)。
