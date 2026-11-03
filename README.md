# dsh-root-temp-guard

DSH Host 插件：在工具调用层拦截"在工作区根目录创建临时目录 / 临时文件"，把"临时产物统一放临时目录"的项目约定从**文字规则**升级为**执行期拦截**。

> ⚠️ **定位说明**：这是一个**卫生/约定守卫**，不是安全边界。文件类工具做路径级判定（仍有已知边界），命令类只做启发式文本匹配。不要依赖它防御恶意行为——真正的边界是 DSH 沙箱。

## 通用性

- **工作区根目录**取自当前会话（`ctx.sandboxPolicy.resolve({session}).workspaceRoot`），换项目自动生效；只有显式配置 `workspaceRoot` 时才固定根目录；
- **相对路径基址**取会话**当前工作目录**（`workingDirectory.get(session)`），与 DSH 内置 `write`/`edit` 的实际解析一致——模型执行 `working_directory { cd: "tmp" }` 后再写 `../_tmp_x` 也会被正确拦截；
- **临时目录名**可配置（`tmpDirName`，默认 `tmp`），额外放行名用 `allowRootNames`；
- **拦截规则、扩展名、拒绝文案、日志位置**均可配置。

## 工作原理

DSH 工具执行管线：

```text
tools/pre-execute → ctx.tools.guard() 单调守卫 → 执行工具 → tools/post-execute → 结果
```

本插件通过 `ctx.effect()` 注册一条全局守卫：

- 守卫在工具执行**之前**同步运行，返回字符串即拒绝，理由原样返回给模型；
- 对所有 agent 生效，子代理 / workflow / PTC `run_code` 的内部工具调用走同一注册表（**未做端到端集成验证**，见"已知限制"）；
- 插件卸载/热重载时守卫随 `ctx.effect` 注销，不会叠加；
- **fail-open**：插件内部异常一律放行并写日志，不会卡死工具调用。

## 默认拦截规则

| 类别 | 例子 | 结果 |
| --- | --- | --- |
| 根目录临时目录（含其下层路径） | `_tmp_probe/x.txt`、`tmp_lead/log.txt`、`.tmp/`、`.._tmp/`、`scratch/`、`test-out/` | 拒绝 |
| 根目录临时文件 | `_tmp_notes.md`、`build.log`、`x.tmp`、`x.bak`、`.log` | 拒绝 |
| 配置的统一临时目录 | `tmp/20261103-dialog-design/a.txt`（`tmpDirName: tmp`） | 允许 |
| 正常仓库路径 | `AGENTS.md`、`docs/01-x.md`、`backend/pom.xml` | 允许 |
| 工作区外路径 | `../other/...`、其他盘符 | 不干预（交给沙箱策略） |

覆盖工具：

- 文件类：`write`、`edit`、`str_replace_editor`（`file_path` / `path`；`view` 只读命令放行）；
- 命令类：`pwsh`、`bash`、`terminal_send`（`command` / `text`；`workdir` 按当前 cwd 解析）。

命令类启发式：命令中出现创建动词（`New-Item`/`mkdir`/`touch`/`Set-Content`/`Add-Content`/`Out-File`/`Copy-Item`/`Move-Item`/`xcopy`/`cp`/`mv`/`tee`/`ln`/`>` 重定向），且某个**路径操作数**解析到根目录下的临时名时拒绝；`-Value`/`-Content` 等自由文本参数会被跳过（避免 `Set-Content -Value "console.log"` 之类误报）。

默认拒绝文案（可用 `reasonTemplate` 覆盖）：

```text
禁止在仓库根目录创建临时项 "_tmp_probe"。临时产物请写入 tmp/<任务名>/ 下；
具体约定见项目约定文件（如 AGENTS.md）中的临时文件规则。
```

## 配置

`config:` 块全部可选；非法值会写入 `config.warning` 日志，而不是静默失效。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关（`false` 关闭） |
| `tmpDirName` | `tmp` | 统一临时目录名；必须是单个路径段，非法值回退 `tmp` |
| `allowRootNames` | `[]` | 额外放行的根目录名（在默认规则之上追加） |
| `denyNamePatterns` | `^(?:\.*_?tmp\|\.*temp\|\.*scratch\|\.*test[-_]?out)(?=$|[._-]\|\d)` | 根目录临时名正则；**整体替换默认值**；`[]` 表示保留默认 |
| `denyFileExtensions` | `['.log','.tmp','.bak','.orig','.rej']` | 根目录临时文件扩展名；`[]` 表示关闭扩展名规则 |
| `reasonTemplate` | 见上 | 拒绝文案，支持 `{name}`、`{tmpDir}` |
| `workspaceRoot` | 空 | **非空时优先于会话解析**（固定根/多工作区部署）；建议绝对路径 |
| `logFile` | `<插件目录>/state/root-temp-guard.log` | 安装/拒绝/配置告警日志；挂载时超过 5MB 自动轮转一次为 `.1` |

示例：临时目录统一叫 `scratchpad` 并自定义提示语：

```yaml
- insert:
    - id: root-temp-guard
      name: 'C:\Users\<你>\.dsh\plugins\dsh-root-temp-guard\index.mjs'
      config:
        tmpDirName: scratchpad
        reasonTemplate: '临时产物请写入 {tmpDir}/<任务名>/，不要污染仓库根目录：{name}'
```

## 安装

### 桌面端（desktop profile）

在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: root-temp-guard
      name: 'C:\Users\<你>\.dsh\plugins\dsh-root-temp-guard\index.mjs'
      config:
        tmpDirName: tmp
```

`<你>` 替换为实际用户名。desktop profile 的 `patchReload` 默认 `live`：**纯 `config` 改动会重新挂载生效；`index.mjs`/`lib/guard.mjs` 的代码改动受 Node ESM 模块缓存影响，需要重启 DeepSeek Harness**。

### 其他 profile

```powershell
$dir = "$env:USERPROFILE\.dsh\plugins\dsh-root-temp-guard"
dsh plugin --profile web add "file:$dir"
# 再在该 profile 的 cordis.patch.yml 中按上面的 insert 段挂载（id 相同即可）
```

## 验证

```powershell
cd "$env:USERPROFILE\.dsh\plugins\dsh-root-temp-guard"
node --test "test/*.test.mjs"
Get-Content state\root-temp-guard.log
```

日志示例：

```text
2026-11-03T... plugin.mounted pid=...
2026-11-03T... deny tool=pwsh reason=禁止在仓库根目录创建临时项 "_tmp_probe"...
2026-11-03T... plugin.disposed
2026-11-03T... config.warning denyNamePatterns entry ... is not a valid RegExp; ignored
```

## 已知限制

- **不是安全边界**：命令类是启发式文本匹配，`node -e "fs.mkdirSync(...)"`、`xcopy`/`robocopy`、shell 变量/函数/别名、PowerShell 管道拼接、脚本内部间接建目录均可绕过。
- **命令里的 `cd`/`Set-Location` 不跟踪**：`Set-Location tmp\x; mkdir _tmp_y` 会按 cwd 基准误判为根目录操作而被拒（安全方向误伤）；把 `workdir` 参数或显式路径用上是可靠做法。
- **符号链接 / junction 不解析**：路径按字面判定；`tmp/link` 指向根再写 `tmp/link/_tmp_x` 可绕过。普通 UNC 路径（`\\server\share`）被视为工作区外，不干预。
- **只覆盖已知工具与工具管线**：新工具、或插件直接调用 `ctx.fs` 服务（不走工具）不在覆盖范围；`str_replace_editor` 的 `view` 已放行。
- **agentless 调用不拦截**：没有 session 的调用拿不到工作区上下文，守卫直接放行（fail-open）。
- **子代理 / workflow / PTC 覆盖未做端到端验证**：机制上走同一注册表，但未集成测试；不要把这条当保证。
- **不做自动清理**：只拒绝新写入，已存在的临时目录不会搬走或删除。
- **日志**：挂载时轮转一次（>5MB → `.1`），运行期间不轮转；写失败被吞。
- **fail-open**：内部异常放行并记录 `guard.error`。

## 卸载

删除 `cordis.patch.yml` 中对应 `insert` 段，或把 `config.enabled` 设为 `false` 后重启。

## License

MIT，见 [LICENSE](LICENSE)。
