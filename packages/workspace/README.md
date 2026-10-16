# @nexgent/workspace

工作目录与 `.nexgent/` 数据目录、文件与 shell 工具、子进程与沙箱策略。策略的规范文本是
`docs/spec/permissions.md`（沙箱模式、路径与命令策略、工具审批）与 `docs/spec/data-formats.md`
（目录布局、项目配置文件）；本包是策略的执行者，审批由 kernel 的 `ctx.approvals` 执行。

归属：计划步骤 1；分工与完成定义见 `docs/plan/step-1-work-partition.md`。运行时依赖：Node 内置模块 + `@nexgent/kernel`。

## Public API

| Export | Contract | What it does |
| --- | --- | --- |
| `openWorkspace(root, { create, ensureLayout })` → `LocalWorkspace` | `Workspace` | realpath 后的项目根；`ensureLayout()` 幂等创建 `.nexgent/{sessions,materials,outputs,capabilities,ledgers,snapshots}`；`locateWorkspace(start)` 向上找 `.nexgent/` |
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
`write_file` 新建文件，或覆盖本会话读过/写过的文件、给出 `overwrite: true` 的文件（否则 `tool/failed` 并提示先读）；`str_replace` 支持 `replace_all` 与 `edits`（全成功才写）；`read_file` 输出带行号（ADR 0017 决策 1，契约 `edit-tools.ts`）。

## Policy summary

- **模式**：`read-only` 只读根内可读、写与命令全部拒绝（不提示）；`workspace-write` 读写限项目内（另加
  `extraReadRoots` 只读、`<tmpdir>/nexgent-*` 会话临时目录可读写），命令 cwd 必须在项目内、黑名单需审批；
  `full-access` 不检查，只保留始终审批表（提权、删除项目目录本身、改 `config.json` 的
  `approvals/costCaps/sandboxMode`）。工具按 `ToolContext.sandboxMode` 取对应模式的沙箱。
- **路径**：`path.resolve` → 最长已存在祖先 `realpath` + 字面尾段（悬空符号链接按链接目标解析）→ 包含检查；
  词法在根内但真实位置在根外 = `symlink-escape`。处理器在操作前再解析一次并使用第二次结果。Windows：小写、
  `/`→`\`、去 `\\?\`、设备名 / ADS / 非 UNC 项目下的 UNC 拒绝、长度 > 4096 拒绝。
- **`.nexgent/`**：`sessions/ ledgers/ capabilities/ snapshots/` 读写拒绝；`materials/`、`outputs/`、`skills/` 只读（成果快照只由宿主在 `present` 时写，步骤 2 起模型不能写改；技能由用户维护）；`config.json` 只读；其余 `.nexgent/` 路径读写都拒绝。
  `.git/`、`node_modules/`、`.pnpm-store/` 任意深度写拒绝；`.env* *.pem *.key id_rsa* .npmrc .netrc` 读写需审批。
- **命令**：`bash -c` / `pwsh -NoProfile -NonInteractive -Command`；超时默认 120 000，上限 600 000；POSIX 独立进程组，
  `SIGTERM` → `graceMs`（默认 5 000）→ `SIGKILL`，等进程组为空（Linux 读 `/proc` 排除僵尸）后才返回，正常退出后残留的
  后台成员同样被清理；Windows 每个命令经一个 `pwsh` 启动器运行在 `KILL_ON_JOB_CLOSE` 的 Job Object 里（`windows-job.ts`；P/Invoke 辅助程序首次使用时编译到系统临时目录 `nexgent-job-<hash>.dll`），终止时 `taskkill /PID <pid> /T /F` 结束启动器、作业关闭，父进程已退出的后代也一并结束，正常退出后的残留同样被结束；建不起作业时退回只用 `taskkill /T`（`windowsJob: false` 可关闭）。环境删除 `NEXGENT_*`、`*_API_KEY|_TOKEN|_SECRET|_PASSWORD`、
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

- Windows ACL 隔离未接。Job Object 由启动器建立，每次命令多一次 `pwsh` 启动（约数百毫秒）。
- Windows 命令仍没有文件边界（系统沙箱只有 Linux bubblewrap 与 macOS seatbelt）；黑名单可被绕过，见 permissions.md §已知边界。
- 凭证文件中的密钥值不会自动进入脱敏表（只有被清洗的环境变量值与插件配置 `secrets`）。
- `list_files` / `search_text` 是纯 JS 实现，语义向 ripgrep 看齐但不保证与它逐字一致（正则是 JavaScript 语法）；`multiline` 整文件读入，超过 16 MiB 的文件跳过并提示。

## 搜索工具（`list_files` / `search_text`）

- 读 `.gitignore`（根、嵌套、否定、`.git/info/exclude`，与 `GitignoreMatcher` 同一份解析，现在放在本包 `src/gitignore.ts`，`@nexgent/tasking` 再导出）；`.nexgent/`、`.git/`、`node_modules/` 总被跳过，`includeIgnored: true` 解除 `.gitignore` 和 `node_modules/`。目标目录本身在 `.nexgent/` 内时不套其 `.gitignore`。
- 结果按相对路径排序。`list_files`：`offset` / `limit`（别名 `maxResults`），结尾写总数；需审批的敏感文件带 `[sensitive: …]` 标记列出。
- `search_text`：`outputMode`（`content` / `files_with_matches` / `count`）、`before` / `after` / `context`、`ignoreCase`、`literal`、`multiline`、`glob`、`offset` / `limit`。还有更多结果时末尾写 `[more results: pass offset N]`。文件并发读取（16 路），按行流式匹配，不再跳过大文件；二进制文件跳过并写出个数。
- 敏感文件（`assessRead` 为 `ask`）绝不在搜索里读取，也不弹审批；结果末尾写一行跳过了哪些（最多列 20 个，其余写个数）。被沙箱拒绝的文件仍静默跳过。

## 命令的系统沙箱、后台运行与输出（ADR 0022 决策 1、6、7）

- **系统沙箱**（`src/os-sandbox.ts`，`createOsSandbox()`）：包装 `@anthropic-ai/sandbox-runtime`（钉 0.0.80，Apache-2.0）。库的 `SandboxManager` 是进程级单例，所以全局只初始化一次（延迟、不带网络与文件规则），写根、写保护、读保护和网络开关全部作为每次 `wrapWithSandbox` 的 `customConfig` 传入，不同项目的会话可以在同一进程并发。网络允许时不加网络段（命令用宿主网络，不走代理）；`network: false` 时给空白名单（新网络命名空间，无网络）。`probe()` 做依赖检查并真跑一条试验命令，失败返回 `{ kind: 'none', reason }`，`wrap()` 返回 `unavailable`，从不抛错。Linux 需要 `bwrap`、`socat`、`rg`；Windows 与缺依赖的平台为 `none`。
- **网络桥的寿命**（Linux）：库为网络常驻 `socat` 桥。进程内只生成一个包装脚本（临时目录里，退出时删除），让 `socat` 经 `setpriv --pdeathsig KILL` 启动，宿主被强杀时桥随之结束；没有 `setpriv` 时用库的默认方式。`WorkspacePlugin` 在 `agents` 可用时就开始探测，所以第一个会话不等探测；新会话与重开的会话都等探测完成，`session.start` 记 `commandSandbox`（经 `AgentsService.useCommandSandboxProbe`）。
- **策略输入**由宿主经 `ShellToolDeps.os`（`ShellSandboxDeps`）给出：`inputs(context)` 返回 `ShellSandboxInputs`（是否启用、`required`、项目根、只读、本会话放行的写根、读保护路径、读保护里仍可读的路径 `allowRead`——迁移到用户数据目录的项目的 `materials/` 与 `outputs/`、网络）。工具参数 `sandbox: false` 请求沙箱外重跑，经 `approveUnsandboxed` 钩子批准，没有钩子就拒绝。
- **后台运行**：`bash` / `pwsh` 的 `run_in_background` 立即返回编号；`shell_output`（读新增输出和状态）、`shell_kill`（杀进程树）。登记表是 `BackgroundShells`，宿主在会话关闭时调用 `backgroundShellsFor(deps).disposeSession(sessionId)`；宿主进程退出时同步 SIGKILL 所有后台进程树。
- **输出**：每个流在进程里保留头尾（默认合计 64 KiB，中间写 `[nexgent: N bytes omitted from the middle]`）；给模型的文本最多约 30 000 字符，头尾各半；完整的（已脱敏的）stdout / stderr 写到会话临时目录，被截断时路径附在结果里，没截断就删。
- **Windows**：没有 `pwsh` 时回退到 Windows PowerShell 5.1，工具描述和第一条结果里提示一次；Job Object 启动器按 `$PSVersionTable` 选 `ArgumentList`（7）或手工转义的 `Arguments`（5.1）。
