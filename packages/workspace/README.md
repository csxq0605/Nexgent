# @nexgent/workspace

工作目录与 `.nexgent/` 数据目录、文件与 shell 工具、子进程与沙箱策略。策略的规范文本是
`docs/spec/permissions.md`（沙箱模式、路径与命令策略、工具审批）与 `docs/spec/data-formats.md`
（目录布局、项目配置文件）；本包是策略的执行者，审批由 kernel 的 `ctx.approvals` 执行。

归属：计划步骤 1；分工与完成定义见 `docs/plan/step-1-work-partition.md`。运行时依赖：Node 内置模块 + `@nexgent/kernel`。

## Public API

| Export | Contract | What it does |
| --- | --- | --- |
| `openWorkspace(root, { create, ensureLayout })` → `LocalWorkspace` | `Workspace` | realpath 后的项目根；`ensureLayout()` 幂等创建 `.nexgent/{sessions,materials,outputs,capabilities,ledgers}`；`locateWorkspace(start)` 向上找 `.nexgent/` |
| `loadProjectConfig(layout)` / `readProjectConfigFile` / `validateProjectConfig` | `ProjectConfig` | 读 `.nexgent/config.json`；缺文件 = `{}`；未知字段、类型不符、`version ≠ 1`、坏 JSON → `config/invalid`；默认值由 `resolveProjectConfig` 填；额外支持 `extraReadRoots` |
| `writeProjectConfig` / `updateProjectConfig` / `addProjectApproval` | — | 临时文件 + fsync + rename 的原子写；`project` 授权追加（按 tool+pattern 去重） |
| `createSandbox(options)` → `LocalSandbox` | `Sandbox` | `checkRead/checkWrite/checkCommand`（契约二值结果，`ask` 映射为拒绝）；`assessRead/assessWrite/assessCommand` 三值结果 `allow / ask {risk, options, pattern, reason} / deny {code, reason}`；`withMode(mode)` |
| `LocalProcessRunner` | `ProcessRunner` | 超时、AbortSignal、进程树终止、环境清洗、64 KiB 尾部截断 + 标记、密钥脱敏 |
| `readFileTool` `writeFileTool` `strReplaceTool` `listFilesTool` `searchTextTool` `bashTool` `pwshTool` `shellTools()` | `Tool` | 工具对象（附加 `preflight`）；`shellTools()` 在 Windows 给 `pwsh`、其余给 `bash` |
| `createWorkspaceServices(options)` / `createWorkspaceTools(deps)` | — | 普通工厂：打开项目、读配置、建沙箱 / runner / 工具 |
| `apply` / `name` / `WorkspacePlugin` | Cordis plugin | `ctx.provide('workspace' \| 'sandbox' \| 'processes')`；`ctx.inject(['tools'])` 时经 `ToolRegistry.register` 注册工具（随任一方卸载而注销）。配置：`root?`（默认 `process.cwd()`）、`sandboxMode?`（CLI 覆盖）、`create?`、`maxOutputBytes?`、`graceMs?`、`secrets?`、`tempBase?` |
| 纯函数 | — | `isWithin` `comparablePath` `windowsPathIssue` `resolveReal` `matchGlob` `matchCommandRules` `commandScript` `scrubEnv` `isSecretEnvName` `Redactor` `TailBuffer` `truncationMarker` `applyStrReplace` `clampTimeout` |

工具名：`read_file`、`write_file`、`str_replace`、`list_files`、`search_text`、`bash` / `pwsh`。全部声明
`approval: 'never'`；按调用的升级（形态黑名单、敏感文件、始终审批表）由沙箱判定。

## Policy summary

- **模式**：`read-only` 只读根内可读、写与命令全部拒绝（不提示）；`workspace-write` 读写限项目内（另加
  `extraReadRoots` 只读、`<tmpdir>/nexgent-*` 会话临时目录可读写），命令 cwd 必须在项目内、黑名单需审批；
  `full-access` 不检查，只保留始终审批表（提权、删除项目目录本身、改 `config.json` 的
  `approvals/costCaps/sandboxMode`）。工具按 `ToolContext.sandboxMode` 取对应模式的沙箱。
- **路径**：`path.resolve` → 最长已存在祖先 `realpath` + 字面尾段（悬空符号链接按链接目标解析）→ 包含检查；
  词法在根内但真实位置在根外 = `symlink-escape`。处理器在操作前再解析一次并使用第二次结果。Windows：小写、
  `/`→`\`、去 `\\?\`、设备名 / ADS / 非 UNC 项目下的 UNC 拒绝、长度 > 4096 拒绝。
- **`.nexgent/`**：`sessions/ ledgers/ capabilities/` 读写拒绝；`materials/` 只读；`outputs/` 读写；`config.json` 只读。
  `.git/`、`node_modules/`、`.pnpm-store/` 任意深度写拒绝；`.env* *.pem *.key id_rsa* .npmrc .netrc` 读写需审批。
- **命令**：`bash -c` / `pwsh -NoProfile -NonInteractive -Command`；超时默认 120 000，上限 600 000；POSIX 独立进程组，
  `SIGTERM` → `graceMs`（默认 5 000）→ `SIGKILL`，等进程组为空（Linux 读 `/proc` 排除僵尸）后才返回，正常退出后残留的
  后台成员同样被清理；Windows `taskkill /PID <pid> /T /F`。环境删除 `NEXGENT_*`、`*_API_KEY|_TOKEN|_SECRET|_PASSWORD`、
  `AWS_*`、`AZURE_*`、`GOOGLE_APPLICATION_CREDENTIALS`，`TMP/TEMP/TMPDIR` 指向会话临时目录，显式 `env` 最后合并；
  被删变量的值加入脱敏表。stdout / stderr 各保留末尾 64 KiB，开头加 `[nexgent: output truncated, dropped N bytes]`。

## Approval hand-off

工具不自己提示。处理器里沙箱答 `ask` 时：`context.approved === true` 直接执行；否则若上下文有
`requestApproval(ask)`（kernel 的 `KernelToolContext`）则调用它，`ask` 带 `summary / detail / risk / options /
pattern / subject`（命令取命中的分段，路径取项目相对路径），`true` 才执行；都没有则以 `approval/denied` 失败（fail closed）。
拒绝一律抛 `sandbox/denied`，消息以 `SANDBOX_DENIED` 开头并含解析后的绝对路径或命令，`details` 带 `{ mode, code, path | command }`。
每个工具另有无副作用的 `preflight(input, context, grants?)` → `allow {grant?} | ask {approval} | deny {error}`，供 UI 或预检使用。

## DSH references

改写参考（文件头带 `Adapted from deepseek-harness@46a7f68b ...`）：`fs/fs-sandbox/src/containment.ts`（`paths.ts`）、
`subprocess/subprocess-local/src/spawn.ts`（`process.ts` 的进程组 / taskkill 终止与存活判定）。只参考设计：
`workspace/workspace`、`fs/tool-fs`、`fs/tool-fs-search`、`fs/tool-str-replace-editor`、`shell/shell-env`、`shell/tool-bash`、
`shell/tool-pwsh`、`sandbox/sandbox-policy`。

## Not done yet

- Windows Job Object（`KILL_ON_JOB_CLOSE`）与 ACL 隔离：步骤 1 只用 `taskkill /T /F`；根进程已退出后脱离进程树的
  Windows 后代无法追踪。
- 命令执行没有文件边界（bwrap / Landlock / ACL 未接）；黑名单可被绕过，见 permissions.md §已知边界。
- 凭证文件中的密钥值不会自动进入脱敏表（只有被清洗的环境变量值与插件配置 `secrets`）。
- `list_files` / `search_text` 不读 `.gitignore`。
