# @nexgent/ptc

程序化工具调用（PTC）的 Node 后端：模型写的 JavaScript 在一个新的、隔离的 Node 进程里运行，只能通过宿主函数（stdio 上的 NDJSON 消息）接触项目；宿主按调用方会话的沙箱检查每次访问。对模型提供 `run_code` 工具（名字、schema、`effects`、`approval` 冻结在契约 `RUN_CODE_TOOL`，`packages/kernel/src/contracts/step3-tools.ts`）；`@nexgent/workflow` 的脚本也跑在同一运行时上。权限规则见 `docs/spec/permissions.md`。

归属：步骤 3 W4「工作流与代码」（`docs/plan/step-3-work-partition.md`）。运行时依赖：Node 内置模块、`@nexgent/kernel`、`@nexgent/skill`、`@nexgent/tool-spreadsheet`、`@nexgent/workspace`。DSH 的 `ptc` 包只参考了设计（宿主函数经 IPC、每次一个进程），没有复制代码。

## Public API

| Export | What it does |
| --- | --- |
| `PtcPlugin` / `apply` / `name` | 行名 `@nexgent/ptc`；注入 `workspace`、`sandbox` 后注册 `run_code`，卸载即注销 |
| `runCodeTool(sandbox, options?)` | 工具本身 |
| `runProgram(options)` | 跑一段程序：`code`、`cwd`、`functions`（宿主函数）、`globals`（JSON 值）、`prelude`、`timeoutMs` / `unboundedTimeout`、`signal`、`caps`、`onOutput`；返回 `ProgramResult`（`completed | failed | timeout | cancelled | crashed`、`value`、`output`、`outputTruncated`、`error`、`calls`、`durationMs`） |
| `projectFunctions(sandbox, context)`、`sandboxFor` | 项目宿主函数：`readFile`、`writeFile`、`listDir`、`exists`、`readSpreadsheet`、`writeSpreadsheet` |
| `PTC_LIMITS`、`permissionFlag`、`programArgs`、`programEnv` | 上限与启动参数 |
| `parseProgramMessage`、`BOOTSTRAP_SOURCE`、`HOST_GONE_EXIT` | 协议与子进程引导代码 |
| `renderProgramResult`、`RUN_CODE_DESCRIPTION` | 工具结果文本与描述 |

## 行为

- **进程。** 每次调用起一个新进程：`node --permission`（Node 22.13 前为 `--experimental-permission`）`--max-old-space-size=512 --input-type=module --eval <引导代码>`，不给任何 fs、子进程、worker 授权；环境变量为空（Windows 只保留启动必需的 `SystemRoot` 等几项，Electron 宿主加 `ELECTRON_RUN_AS_NODE=1`），引导代码再清空 `process.env`。代码作为 async 函数体运行，`return` 的 JSON 值是结果。
- **宿主函数。** 子进程只能通过宿主函数读写项目：每次访问都按调用方会话的沙箱（`withMode(mode).forSession(sessionId)`）判定，`deny` 报 `sandbox/denied`，`ask` 走审批，只读模式下写入被拒。`writeFile` 默认不覆盖已有文件（与 `write_file` 一致），要 `overwrite: true`。读写各上限 10 MiB，`listDir` 最多 2000 项。`readSpreadsheet` 返回计算后的值（日期为 ISO 字符串、错误为错误码）和公式；`writeSpreadsheet` 走 `@nexgent/tool-spreadsheet` 的写入工具。
- **上限。** 超时默认 60 s（1–300 s，`run_code` 的 `timeoutMs`）；输出 64 000 字符后截断并标注；返回值 256 000 字符；单行消息 16 MiB，超出即判崩溃并杀进程。超时、取消、宿主崩溃都杀整个进程树：POSIX 用独立进程组，Windows 用 `@nexgent/workspace` 的 Job Object 启动器，退路为 `taskkill /T`。
- **工具结果。** 一行状态与耗时、宿主调用次数，输出，返回值（JSON），错误时附栈（只保留用户代码的帧）。非 `completed` 的结果标为错误。

## Model Experience

`run_code` 描述约 1 150 字符，列出全部宿主函数与上限。程序的中间数据不进入上下文，只有输出与返回值进入，适合批量读表、汇总、过滤。

## Known Limitations and Deferred Work

- 不拦网络：Node 22 的权限模型没有网络开关。子进程没有密钥和环境变量，但能发出请求。
- kernel 的工具策略按 `effects` 在只读模式下整体拒绝 `run_code`，与 `permissions.md`“只读模式可运行只读代码”不一致；需要改 kernel 的策略或契约，已报给集成者。
- Windows 路径（Job Object 启动器、权限参数）只在 Linux 上测过逻辑；Electron 宿主下 `--permission` 是否可用未验证。
- 插件要由宿主的注册表加载（SDK 与 CLI 的 profile 接入归 W6）。
