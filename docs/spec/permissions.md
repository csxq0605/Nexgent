# 权限与审批模型

> 步骤 1 章节（沙箱模式、路径与命令策略、工具审批、费用上限格式、密钥存放、已知边界、共用审批交互、测试）已定稿；"插件安装审批"在步骤 4 填，"本地 IPC 与访问令牌"在步骤 2 填。字段名以 `packages/kernel/src/contracts/` 为准，二者冲突时改契约 PR 并同步本文。来源：计划 4.10 第 2 行与"安全"一行；ADR 0001 决策 9、12。

## 目的与范围

定义 Nexgent 在用户机器上能读什么、写什么、跑什么、花多少钱，以及每一项由谁、在何时批准。约束对象是模型通过 `ctx.tools` 发起的调用（文件读写搜索编辑、`bash` / `pwsh`、后续的插件）；宿主自身对 `.nexgent/` 的写入不受本文约束。本文只描述策略，不描述实现；`@nexgent/workspace` 是策略的执行者，`@nexgent/kernel` 的审批代理（broker）是审批的执行者。

## 沙箱模式

三种模式，一次会话只有一个生效值：

| 模式 | 文件读 | 文件写 / 编辑 | `bash` / `pwsh` | 命令内网络 |
| --- | --- | --- | --- | --- |
| `read-only` | 读根内允许 | 全部拒绝（不提示） | 不执行（拒绝，不提示） | 无（无命令） |
| `workspace-write`（默认） | 读根内允许；根外拒绝 | 写根内允许；`.nexgent/` 内部目录与拒绝模式按下节；根外拒绝 | cwd 必须在项目内；命令形态黑名单需审批 | 允许，下载并执行类形态需审批 |
| `full-access` | 任意 | 任意，不检查 | 任意 cwd | 允许，不检查 |

- 模式只约束**工具层**，`read-only` 的"拒绝"是工具返回结构化错误 `SANDBOX_DENIED { mode, path | command }`，模型可据此换方案或请求用户切换模式；不会弹审批。
- 模式设置与优先级（高者胜）：
  1. CLI 参数 `--sandbox <read-only|workspace-write|full-access>`（`run` / `resume` / `app` 均接受）；
  2. 项目配置 `.nexgent/config.json` 的 `sandboxMode` 字段；
  3. 默认 `workspace-write`。
- 生效值在会话创建时写入会话头（`sandboxMode` 字段，见 `data-formats.md`），`resume` 时沿用会话头的值，除非再次传 `--sandbox`。步骤 1 不做会话中途切换；步骤 2 桌面应用若加切换控件，必须以会话记录落盘并从下一次工具调用起生效。
- 非法值在装载时报错退出，不回落到默认值。
- `full-access` 启动时在 CLI 与桌面应用各打印一行警告，并在系统提示里告知模型。

## 路径策略与写入限制

**根目录。**

| 类别 | 内容 | 来源 |
| --- | --- | --- |
| 读根 | 项目目录（`--project`，realpath 后）；加 `.nexgent/config.json` 的 `extraReadRoots: string[]`（绝对路径） | 项目配置；CLI 不加 |
| 写根 | 项目目录；再减去下面的宿主专属目录与拒绝模式 | 固定，不可配置扩大 |
| 临时目录 | `os.tmpdir()` 下的 `nexgent-<sessionId>/`，会话结束删除 | 宿主创建，可读写 |

**`.nexgent/` 内部。**

| 子目录 | 工具读 | 工具写 | 说明 |
| --- | --- | --- | --- |
| `sessions/`、`ledgers/`、`capabilities/` | 拒绝 | 拒绝 | 只有宿主写；模型不能改自己的历史、账本与能力版本 |
| `materials/` | 允许 | 拒绝 | 用户提供的资料，由宿主写入（步骤 2） |
| `outputs/` | 允许 | 允许 | 任务成果；步骤 2 的快照由宿主另存 |
| `config.json` | 允许 | 拒绝 | 配置改动必须经用户或审批流 |

**拒绝与审批模式**（在写根内也生效）：

| 模式 | 读 | 写 |
| --- | --- | --- |
| `.git/**` | 允许 | 拒绝（`git` 命令不在此列，由命令策略管） |
| `node_modules/**`、`.pnpm-store/**` | 允许 | 拒绝；要改依赖走包管理命令并审批 |
| `.env`、`.env.*`、`*.pem`、`*.key`、`id_rsa*`、`.npmrc`、`.netrc` | 审批 | 审批 |
| 其他以 `.` 开头的文件 / 目录 | 允许 | 允许 |

**规范化**（每次调用、在检查前执行，一次）：

1. 相对路径以项目目录为基解析；`path.resolve` 消去 `.`、`..`。
2. 取已存在的最长祖先做 `realpath`，把不存在的尾段按字面拼回；对结果做包含检查（根本身或根加分隔符的前缀）。文件工具在写入前**再做一次**同样的解析，用第二次的结果打开文件，缩小 resolve 到写入之间的符号链接竞争窗口。
3. 目标自身是符号链接时，按链接指向的真实位置判定；写入会跟随链接，因此指向根外的链接被拒绝。
4. Windows：比较前统一为小写并把 `/` 换成 `\`；去掉 `\\?\` 前缀后再比较；盘符必须与根一致；UNC 路径（`\\server\share\...`）只有在项目目录本身是 UNC 时才允许，且 share 必须相同；设备名（`CON`、`NUL`、`COM1` 等）作为文件名拒绝；8.3 短名靠 realpath 展开。
5. 路径长度：解析后超过 4096 个字符拒绝；Windows 超过 260 字符的路径交给 Node 的长路径支持处理，不做额外限制。
6. 所有检查用解析后的绝对路径记录在错误与账本里，不记录模型给的原始拼法以外的内容。

**Windows：先路径策略，后 ACL**（ADR 0001 决策 9）。步骤 1 的策略只在文件工具中生效，对 `pwsh` 启动的进程没有约束力。后补的 ACL 隔离（参考 DSH `sandbox-windows-acl` 的受限令牌方案）会增加：子进程及其后代的写入与删除被限制在项目目录与会话临时目录；受限令牌在 `read-only` 下无任何写授权；失败时不以非受限方式启动。ACL 不能补上的：硬链接别名、读取不受限、被其他 AppContainer 工具加过 ACL 的目录不可读。

## 命令策略

工具：Linux / macOS 为 `bash`（`bash -c <command>`，不是登录 shell），Windows 为 `pwsh`（`pwsh -NoProfile -NonInteractive -Command <command>`）。两者都是一次性进程，不保留 shell 状态。

| 规则 | `read-only` | `workspace-write` | `full-access` |
| --- | --- | --- | --- |
| 是否执行 | 否 | 是 | 是 |
| cwd | — | 必须在项目目录内（按路径策略解析），默认项目目录 | 任意 |
| 超时 | — | 每次调用 `timeoutMs`，默认 120 000，上限 600 000；超出上限按上限 | 同左 |
| 形态黑名单 | — | 命中则审批 | 不审批 |
| 网络 | — | 不限制 | 不限制 |

**进程树终止。** 超时或用户取消时：POSIX 子进程以独立进程组启动（`detached: true`），先对进程组发 `SIGTERM`，等 `graceMs`（默认 5 000）后发 `SIGKILL`；Windows 优先用 Job Object（`KILL_ON_JOB_CLOSE`，参考 DSH `win32-process` 的方式），不可用时退回 `taskkill /T /F /PID`。终止后必须等到进程组 / Job 为空再返回工具结果，结果带 `terminated: 'timeout' | 'cancel'`。

**环境清洗。** 子进程环境从宿主环境复制后删除：`NEXGENT_*`、名字以 `_API_KEY`、`_TOKEN`、`_SECRET`、`_PASSWORD` 结尾的变量、`AWS_*`、`AZURE_*`、`GOOGLE_APPLICATION_CREDENTIALS`；再叠加 `TMP` / `TEMP` / `TMPDIR` 指向会话临时目录。工具调用显式传入的 `env` 在清洗之后合并，因此模型不能靠传 `env` 拿回密钥（密钥值不在模型可见范围内）。`PATH` 保留。

**输出上限。** stdout 与 stderr 各保留末尾 64 KiB（可配置 `maxOutputBytes`），超出部分丢弃并在开头加一行标记 `[nexgent: output truncated, dropped N bytes]`；完整输出不落盘。结果在进入会话与账本前经过密钥脱敏（见"密钥存放"）。

**形态黑名单**（`workspace-write` 下命中即触发审批，审批通过后才执行；匹配对象是命令字符串，按空白与管道分段做前缀匹配，故意写得宽，宁可多问）：

| 类别 | 形态举例 |
| --- | --- |
| 安装包 | `npm\|pnpm\|yarn\|pip\|pip3\|uv\|cargo\|go install`、`apt\|apt-get\|brew\|choco\|winget\|scoop install` |
| 推送 / 发布 | `git push`、`git remote add`、`npm publish`、`gh pr merge` |
| 删除根外内容 | `rm -r*`、`Remove-Item -Recurse` 且参数解析为项目外路径或 `/`、`~`、盘符根 |
| 提权 | `sudo`、`su`、`doas`、`runas`、`Start-Process -Verb RunAs` |
| 下载并执行 | `curl\|wget\|Invoke-WebRequest ... \| sh\|bash\|pwsh\|iex`、`Invoke-Expression`、`eval "$(curl ...)"` |
| 改系统状态 | `systemctl`、`sc.exe`、`reg add`、`Set-ExecutionPolicy`、`chmod -R` / `chown -R` 作用于项目外 |

黑名单不是安全边界，只是把高风险形态交给用户决定；绕过方式（如 base64 解码后执行）不在步骤 1 的拦截范围内，见"已知边界"。

## 工具审批

每个工具注册时声明 `approval: 'never' | 'ask' | 'always'`（`always` 每次都问，对应“始终审批”表）；策略层可把单次调用提升为 `ask`（命中形态黑名单、敏感文件模式）或 `deny`（模式不允许）。三种模式下的行为：

| 模式 | `approval: 'never'` 工具 | `approval: 'ask'` 工具 / 被提升的调用 | 被模式禁止的调用 |
| --- | --- | --- | --- |
| `read-only` | 执行 | 写 / 执行类直接拒绝，不提示 | 拒绝，不提示 |
| `workspace-write` | 执行 | 弹审批 | 拒绝，不提示 |
| `full-access` | 执行 | 执行，不提示；例外是"始终审批"表 | — |

"始终审批"表（任何模式都问）：`sudo` 类提权、删除项目目录本身、写入 `.nexgent/config.json` 的 `approvals` / `costCaps` / `sandboxMode` 字段、步骤 4 的插件包采用。

**粒度。** 用户每次应答选择作用范围：

- `once`：只放行本次调用；
- `session`：本会话内相同工具 + 相同匹配模式（命令前缀或路径模式）不再问，记录在会话中（`approval.grant` 记录），`resume` 后仍有效；
- `project`：写入 `.nexgent/config.json` 的 `approvals` 列表，之后所有会话生效。

```json
{
  "approvals": [
    { "tool": "bash", "pattern": "pnpm install", "grantedAt": "2026-10-07T08:00:00Z" },
    { "tool": "fs.write", "pattern": ".env.local", "grantedAt": "2026-10-07T08:05:00Z" }
  ]
}
```

`pattern` 对命令是前缀匹配，对路径是项目相对路径的 glob；没有 `pattern` 的条目放行该工具的所有调用，CLI 与桌面应用都只在用户显式选择时才写无 `pattern` 的条目。

**记录。** 账本的 `tool.call` 记录带 `approval` 字段（契约 `ToolCallApproval`）：`{ required: boolean, decision: 'allow' | 'deny' | 'timeout' | 'cancel' | 'auto', scope?: 'once' | 'session' | 'project', requestId?: string }`；`auto` 表示命中已有授权。会话里写同一事实的 `approval.request` / `approval.decision` 两条记录，字段与 `ApprovalRequest` / `ApprovalDecision` 一致。审批 UI 的呈现不进入会话。

**超时。** 没有应答即拒绝（`decision: 'timeout'`）。CLI 在 TTY 下等 300 s（`approvalTimeoutMs`），非 TTY（CI、`nexgent run` 被重定向）直接拒绝且不阻塞；桌面应用等到用户应答或轮次被取消。拒绝后工具返回错误 `approval/denied`，模型可以换方案，但同一轮内对同一调用再次请求审批会被策略层直接拒绝，不再弹窗。

## 插件安装审批

一句话（步骤 4 填）：插件包在宿主进程内执行，每次采用都需人审批；技能与 PTC 函数自动采用。

## 费用上限

步骤 1 只定格式与达到上限的行为，不做产品设置页。配置在 `.nexgent/config.json`：

```json
{
  "costCaps": {
    "perTask":    { "maxRequests": 200,  "maxTokens": 2000000 },
    "perProject": { "maxRequests": 5000, "maxTokens": 50000000, "windowDays": 30 }
  }
}
```

- `maxRequests` 计模型请求次数（含失败），`maxTokens` 计 `inputTokens + outputTokens`；用量 `unknown` 的请求只计次数。
- `perTask` 以一次 `run` / 一次 `resume` 为单位；`perProject` 以账本在 `windowDays` 内的记录累加。
- 任一上限达到时：下一次模型请求不再发出，当前轮次以 `turn.end { kind: 'cancelled', cause: 'cost-cap' }` 结束；会话先写一条 `error` 记录（`fatal: false`），账本写 `task.outcome`，二者的错误 `code` 都是 `budget/exhausted`，`ErrorInfo.details` 带 `{ scope: 'task' | 'project', metric: 'requests' | 'tokens', used, limit }`；不重试、不自动续跑。
- 步骤 1 执行 `perTask`；`perProject` 只定格式。
- 字段缺省表示不限制；步骤 2 的设置页只改这两个对象。

## 密钥存放

| 优先级 | 来源 | 说明 |
| --- | --- | --- |
| 1 | 环境变量 `NEXGENT_API_KEY`（可选 `NEXGENT_API_BASE_URL`） | 一次性覆盖；只读，产品内不可改 |
| 2 | `~/.nexgent/credentials.json`（`NEXGENT_HOME` 可改根目录） | `{ "version": 1, "credentials": { "NEXGENT_API_KEY": "...", "NEXGENT_API_BASE_URL"?: "..." } }`（`CredentialFile`，与 `data-formats.md` 一致）；POSIX 创建时 `0600`，发现权限宽于 `0600` 时拒绝读取并提示；Windows 依赖用户配置文件目录的默认 ACL，不额外设置 |

- 密钥**不**从项目目录读取：不读项目 `.env`，不写 `.nexgent/`。
- 密钥不进入会话记录、账本、日志与模型上下文；凭证服务只向 llm 包提供值，向其他组件只提供 `{ configured, source }`。
- **脱敏**：工具输出、子进程 stdout / stderr、错误消息在写入会话 / 账本与回传模型之前，替换当前已加载的密钥值与常见密钥形态（`sk-[A-Za-z0-9]{16,}`、`Bearer [A-Za-z0-9._-]{16,}`、`AKIA[0-9A-Z]{16}`）为 `[redacted]`。脱敏是尽力而为，不是密钥不泄露的保证。

## 本地 IPC 与访问令牌

一句话（步骤 2 填）：Electron 渲染进程与主进程之间的调用边界与令牌。

## 已知边界与绕过

如实列出步骤 1 不能防住的情况；这些不是待办，是当前策略面的定义：

1. **路径策略只约束文件工具。** `workspace-write` 下 `bash` / `pwsh` 启动的进程以用户身份运行，能读写用户能读写的任何路径；cwd 限制与形态黑名单只提高门槛。在 Linux 上接 bwrap / Landlock、Windows 上接 ACL 之前，命令执行没有文件边界。
2. **形态黑名单可被绕过。** 编码、变量拼接、脚本文件间接执行都不在匹配范围内。黑名单的目的是让常见高风险操作经过用户，不是阻止有意绕过。
3. **`full-access` 没有任何边界。** 等同于用户亲自执行。
4. **插件包进程内执行（步骤 4）。** 插件包与宿主同进程、同权限，沙箱与审批对其无效，因此采用前每次人审批（ADR 0001 决策 12）。
5. **符号链接竞争。** 解析与打开之间仍有窗口；二次解析把窗口缩小但没有消除。对手是同一用户的并发进程时无法防御。
6. **Windows 路径策略弱于 ACL。** 大小写、8.3 短名、交接点（junction）、硬链接都靠 realpath 与身份比较，覆盖不完整；ACL 后补后仍有硬链接别名与读不受限的边界。
7. **读根不隔离读取。** `extraReadRoots` 之外的读取被文件工具拒绝，但命令可以读任何东西；密钥脱敏只覆盖已知形态。
8. **网络不受限。** 三种模式都不限制子进程网络；只有 `read-only` 因不执行命令而没有网络。
9. **审批依赖宿主在场。** 非 TTY 的 CLI 把所有审批视为拒绝，任务可能因此失败而不是等待。

## CLI 与桌面应用共用的审批交互

审批在 kernel 的审批代理（`ctx.approvals`，契约 `ApprovalBroker`，见 `packages/kernel/src/contracts/approvals.ts`）中统一处理；宿主（CLI 或桌面应用）注册**一个**应答者，没有应答者时所有审批按 `timeout` 拒绝。

```ts
interface ApprovalRequest {
  id: string                       // 本次请求 ID，写入账本与会话
  sessionId: string
  callId: string                   // 对应的 tool.call
  tool: string                     // 'bash' | 'pwsh' | 'fs.write' | ...
  summary: string                  // 一行：要做什么（命令全文或路径）
  detail?: string                  // 多行上下文：cwd、匹配到的规则、模型给的理由
  risk: 'low' | 'medium' | 'high'  // 低：敏感文件读；中：黑名单命令；高：始终审批表
  options: Array<'once' | 'session' | 'project'>  // 允许选择的作用范围；始终审批表只给 'once'
  pattern?: string                 // session / project 授权将保存的匹配模式
  expiresAt?: string               // ISO 时间；CLI 填，桌面应用可空
}

interface ApprovalDecision {
  id: string
  decision: 'allow' | 'deny'
  scope: 'once' | 'session' | 'project'   // deny 时固定 'once'
  decidedBy: 'user' | 'timeout' | 'cancel' | 'headless'
  reason?: string                          // 用户备注，可空
}
```

- CLI：在 TTY 上渲染一段提示（summary、detail、risk 与 `[a]llow once / [s]ession / [p]roject / [d]eny`），非 TTY 直接返回 `decidedBy: 'headless'` 的拒绝。
- 桌面应用（步骤 2）：主进程经 IPC 把 `ApprovalRequest` 推给渲染进程弹对话框，应答以 `ApprovalDecision` 回传；令牌与边界在"本地 IPC"章节。
- 两者记录完全相同：会话 `approval.request` / `approval.decision`，账本 `tool.call.approval`；呈现方式不入记录。
- 轮次取消时所有未决请求以 `decidedBy: 'cancel'` 关闭；一个请求只能被应答一次，迟到的应答丢弃。

**工具在运行中发现的审批。** 沙箱契约（`packages/kernel/src/contracts/workspace.ts`）的 `SandboxDecision` 除 `{ allowed: true }` 与 `{ allowed: false, code, reason }` 外，还有第三种情形 `{ allowed: false, code: 'approval-required', reason, ask: ToolApprovalAsk }`：策略没有直接拒绝，调用在宿主批准 `ask` 后可以继续。工具不自己弹窗，而是把 `ask` 交给 `ToolContext.requestApproval(ask)`（契约 `packages/kernel/src/contracts/tools.ts`），它经 `ctx.approvals` 走上面同一套 `ApprovalRequest` / `ApprovalDecision` 流程，解析为 `true` 表示可以继续，没有应答者时为拒绝。`ToolContext.approved` 为 `true` 表示循环在调用工具前已经为该调用取得审批（`approval: 'ask' | 'always'` 的工具），工具不必再问。`ToolApprovalAsk`（`packages/kernel/src/contracts/approvals.ts`）的字段：

```ts
interface ToolApprovalAsk {
  summary: string                  // 一行：将要发生什么（命令全文或路径）
  detail?: string                  // 多行上下文：命中的规则、cwd
  risk?: 'low' | 'medium' | 'high' // 默认 'medium'
  pattern?: string                 // session / project 授权保存的匹配模式；缺省从 subject 推导
  subject?: { kind: 'command' | 'path' | 'other', value: string }  // 用于匹配已有授权；默认 { kind: 'other', value: summary }
  options?: Array<'once' | 'session' | 'project'>  // 可选作用范围；默认宿主支持的全部，risk 为 'high' 时只给 'once'
}
```

`extraReadRoots`（读根的扩展）是项目配置 `.nexgent/config.json` 的字段（`ProjectConfig.extraReadRoots: string[]`，默认 `[]`），见 `data-formats.md` §项目配置文件。

## 测试

每条策略在 Linux 与 Windows CI 各跑一次；用例用 `@nexgent/test-support` 的脚本化 provider 驱动真实工具实现，不打桩路径函数。表中"两平台"指同一测试文件在两平台都通过，平台专属用例以 `it.runIf(process.platform === ...)` 标注。

| 策略 | 用例 | 预期 |
| --- | --- | --- |
| 沙箱模式 | `read-only` 下写文件、执行命令 | `SANDBOX_DENIED`，无审批请求产生 |
| 沙箱模式 | `--sandbox` 覆盖 `config.json`；非法值 | 会话头记录 CLI 值；非法值启动失败 |
| 路径 | 写 `../outside.txt`、绝对路径根外 | 拒绝，错误含解析后绝对路径 |
| 路径 | 项目内符号链接指向根外文件 / 目录后写入（Windows 用 junction 与 symlink 各一） | 拒绝 |
| 路径 | 写 `.nexgent/sessions/x`、`.nexgent/materials/x`、`.git/HEAD`、`node_modules/a.js` | 拒绝；写 `.nexgent/outputs/x` 允许 |
| 路径 | 写 `.env` | 产生审批请求；拒绝后不写入 |
| 路径（Windows） | 大小写不同的根拼法、`\\?\` 前缀、不同盘符、UNC、`NUL` 文件名 | 前两者允许，后三者拒绝 |
| 路径 | `extraReadRoots` 内读、外读 | 允许 / 拒绝 |
| 编辑 | `str_replace` 在 CRLF 文件上 | 保留 CRLF，不混入 LF；多处匹配报错、无匹配报错 |
| 命令 | cwd 指向项目外 | 拒绝 |
| 命令 | 启动 `sleep 600` 的子进程树后超时 / 取消（Windows 用 `Start-Process` 嵌套） | 返回 `terminated`，进程组 / Job 为空，无残留（Windows 用 Job 计数验证） |
| 命令 | 子进程打印 `NEXGENT_API_KEY` 与 `FOO_TOKEN` | 环境中不存在；输出里的真实密钥值被替换为 `[redacted]` |
| 命令 | 输出 1 MiB | 结果 ≤ 64 KiB 加截断标记，保留末尾 |
| 命令 | `pnpm install`、`git push`、`curl x \| sh`、`sudo ls` | 各产生一次审批请求；拒绝后不执行 |
| 审批 | TTY 超时（`approvalTimeoutMs` 设 100）、非 TTY | `decidedBy: 'timeout'` / `'headless'`，工具返回 `approval/denied`，账本 `tool.call.approval.decision` 一致 |
| 审批 | `session` 授权后同形态再调用；`resume` 后再调用 | 不再提问；账本 `decision: 'auto'` |
| 审批 | `project` 授权 | `config.json.approvals` 新增条目，新会话不再提问 |
| 费用 | `costCaps.perTask.maxRequests: 2` 下第 3 次请求 | 不发出请求；轮次以 `cost-cap` 取消，会话与账本各一条 `budget/exhausted`，无重试 |
| 密钥 | 凭证文件权限 `0644`（POSIX） | 拒绝读取并给出修复提示 |
| 密钥 | 会话、账本全文 | 不含密钥值 |
