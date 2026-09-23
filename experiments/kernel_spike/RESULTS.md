# Stage A 内核小样结果

日期：2026-09-23。固定任务与出口见[共同合同](CONTRACT.md)。小样脚本是诊断代码，不进入 Nexgent 产品执行路径。

## Python 路径：第一次实跑

命令（仓库根目录，使用本地 Python 3.12 环境）：

```powershell
$env:PYTHONPATH=(Resolve-Path 'src').Path
..\NExgent\.venv\Scripts\python.exe experiments\kernel_spike\python_route.py
```

脚本在独立临时项目中建立真实 `TaskService`／`EpisodeStore`，用固定模型接口响应完成 `ask → tool → publish`。人工编写的 `spike.multiply` 预先注册和授权后，交付 `{"answer":42}`；模型调用收据 1、工具调用收据 1，工具事件记录参数和结果。未授权的另一 Episode 调用同名工具被拒绝。全局移除处理器后，对原 Episode 的调用也被拒绝。

**共同合同尚未通过。** 空工具作用域的 Episode 创建后，试图增补能力得到 `PermissionError: Immutable Episode identity field: capabilities`。`ToolRegistry` 只有注册，没有公开卸载；诊断脚本使用私有字典模拟全局移除，不能证明任务作用域的插件生命周期。试验工具在宿主进程中执行，模型是固定响应替身。真实模型、暂停恢复、独立 evaluator 投影、重启后处理器恢复均未测。

首次脚本还观察到 Windows 临时目录清理遇到 `research.sqlite3` 文件占用；修订脚本忽略临时清理错误以保留主要诊断结果。阶段 A3 的 Windows／恢复评估需核查数据库连接生命周期，不能把这次退出码 0 当成文件句柄问题已解决。

这条路线如果进入生产，需要显式的任务内能力租约和原子装入／卸载 API，在不改写 Episode 原始任务合同的情况下记录新增准入、实际 handler 摘要和回放行为。不能简单修改 `TaskService._change` 或全局 `ToolRegistry._tools` 来掩盖基线阻断。

## DeepSeek Harness 路径

固定 `dsh-v0.1.7-rc.1` / `46a7f68b0922371ce7144b668b90e377d8e799f4` 已在独立目录检出，`git rev-parse HEAD` 与目标 SHA 一致。使用本机 Node `24.15.0`，把 Corepack 缓存放在试验工作区以取得仓库指定 pnpm `11.7.0`。`corepack pnpm install --frozen-lockfile --ignore-scripts` 通过；完整 `corepack pnpm run build` 在宿主环境退出码 0，`corepack pnpm dsh --version` 返回 `0.1.7-rc.1`。

首次受限构建遇到 Node `os.userInfo()` 的 `uv_os_get_passwd returned ENOMEM`；单独执行同一调用在受限环境失败、宿主环境成功。重跑构建成功，故这次不是上游 TypeScript 编译错误。依赖安装采用 `--ignore-scripts`，暂未验证依赖构建脚本的所有功能。

定向上游检查：

| 运行项 | 实际结果 | 证据边界 |
| --- | --- | --- |
| `corepack pnpm exec vitest run packages/core/tools/tests/scoped.spec.ts --reporter=dot` | 27 passed | 证明固定源码中 scope-aware ToolRuntime 对显式注册的可见性、调用、释放合同；不是 Nexgent 任务或模型开发插件 |
| `corepack pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/profiles/headless/tests/source-tool.built.e2e.ts --reporter=dot` | 1 passed | 官方命名 headless profile 经固定模型接口到宿主工具及持久 `tool/call`／`tool/result`；这是上游自带 shell smoke，不是本合同的 `multiply` 工具或 Episode 桥接 |

第一次运行 headless 测试没有传其 `vitest.e2e.config.ts`，默认配置只收 `*.spec.ts`，因此报 `No test files found`；使用专用配置后通过。两项定向测试与完整源码构建都只在固定上游检出中运行，不能算 Nexgent 实现通过。

### 同题 headless 运行（固定模型接口）

新增 [`dsh_driver.ts`](dsh_driver.ts)、[`dsh_headless.patch.yml`](dsh_headless.patch.yml) 和 [`dsh_spike_plugin.mjs`](dsh_spike_plugin.mjs)，只在固定上游 `46a7f68b0922371ce7144b668b90e377d8e799f4` 的官方 `headless` profile 上叠加诊断插件。复现命令（在 Nexgent 根目录）：

```powershell
node experiments/kernel_spike/dsh_driver.ts ..\NExgent-upstream-deepseek-46a7f68
```

2026-09-23 本机定向运行退出码 0；一轮原始收据在独立工作区目录 `E:\PKU\program\2026\Aug\te\.nexgent-dsh-spike-jcxy5n\receipts`，第二次独立通过在 `E:\PKU\program\2026\Aug\te\.nexgent-dsh-spike-MBaDnk\receipts`。摘要为 `summary.json`，另外保留 headless 输出、主任务及另一任务的 session JSONL、插件 side receipts 和 stderr。这些 scratch 收据没有入 Git，不能当作长期归档。首次把试验项目放在 `%TEMP%` 时，第二 Agent 创建触发受限环境的 `EPERM: realpath C:\Users\Lenovo`；失败收据保留在 `%TEMP%\nexgent-dsh-spike-R4vp0m\receipts`。移到 E: 后的第一次运行 `...\.nexgent-dsh-spike-NRwurd` 因诊断脚本错误地断言只能有一个 session 日志而失败；修正为检查主、次两个日志后通过，无需提升沙箱权限。

通过的是**固定模型替身和人工编写工具处理器的后端合同**：主 Agent 第一请求的工具 schema 只有 `spike.multiply`；同进程第二 Agent 的工具列表为空，直接调用同名工具失败；主 Agent 的模型接口请求 `multiply(6,7)` 并收到 42。工具执行时调用 disposer，下一条持久 `request/header` 已没有该 schema；模型接口再次请求同名工具，持久 `tool/result` 记录 unknown-tool 错误；最后交付精确 `{"answer":42}`。诊断插件 SHA-256 为 `6ca07a39515b539c16c0d6bee50ed0e03cd68de7f640f8c3d99f7b2847e3d892`。三次模型请求由固定 adapter 接收；并未测试或审计外部网络调用。

此处的“隔离”仅是 DeepSeek 同进程 Agent 作用域的**工具处理器注册／释放**；诊断插件在启动前通过 profile 全局加载，并未证明任务内动态插件加载／卸载。它在宿主进程执行，**不是 OS 代码沙箱**。Creator 的 profile 持久安装也不能代替任务内隔离试装。主任务持久日志记录模型工具 schema、调用、结果和会话顺序；第二 Agent 的拒绝仅在插件 side receipt 中，第二 Agent session 日志没有对应的 `tool/call`／`tool/result`。上游日志不包含 Nexgent 所需的 handler 摘要、依赖锁定、能力版本及准入账；生产桥接需把实际 handler 与事件绑定。

初版 runner 只核对源码 `.git/HEAD`，未核对构建产物。独立审查指出这不足以把运行结果严格归给固定提交；修订 runner 增加 tracked source clean 检查，并在摘要中记录实际执行的 `apps/cli/lib/bin.js`、pnpm lockfile、overlay patch 和复制收据的 SHA-256。初次加入 Git clean 检查时，受限用户触发 Git `dubious ownership`，未改全局配置，而是在该次只读 Git 命令中指定固定上游目录为 safe.directory 后重跑成功。修订后第三轮通过的收据位于 `E:\PKU\program\2026\Aug\te\.nexgent-dsh-spike-lTgig9\receipts`；可供 PR 审查的[摘要与哈希清单](evidence-a2-20260923.json)已入库。原始 JSONL 仍只在本机 scratch，清单不是完整构建依赖闭包或远端原始收据归档。上游 install/build/27+1 测试是独立命令观察，不由本轮同题收据证明。

**共同合同尚未完整通过：**真实模型、重启恢复，以及将原执行纳入 Nexgent Episode／benchmark 的生产桥接仍待验证。当前 `TaskService` 没有公开的外部执行结算接口；事后导入 DeepSeek 日志不能冒充执行前预算准入或原任务完成。下述诊断 Episode 只验证证据投影的可行性。

### Nexgent 诊断 Episode 投影

[`dsh_projection.py`](dsh_projection.py) 从上述第三轮同题运行的**持久** session JSONL、第二 Agent session、插件 side receipts 和摘要重新读取证据，核对这三份收据与摘要中的 SHA-256、session 身份、连续 seq、首请求 schema、两次 tool call/result、卸载后的错误及最终 JSON。它把内部一致的外部证据交给一个静态可信的 Nexgent package，经公开 `TaskService.create → run → evaluate` 发布 `result` 与 `external_evidence`，并冻结本地诊断 BenchmarkAdapter 的身份。

定向命令（只读源收据，输出项目另置）：

```powershell
..\NExgent\.venv\Scripts\python.exe experiments\kernel_spike\dsh_projection.py E:\PKU\program\2026\Aug\te\.nexgent-dsh-spike-lTgig9\receipts --project-root E:\PKU\program\2026\Aug\te\.nexgent-dsh-projection-lTgig9
```

2026-09-23 实跑退出码 0。独立审查后修订的投影 Episode `episode-3d2cad3b2b794521` 为 `completed`，本地诊断报告 `accepted/1.0`、scope=`receipt_internal_consistency_only`；**仅投影程序**的模型与工具调用均为 0，外部原执行的用量单列为 `unknown`。修订版 [投影摘要](evidence-a2-projection-20260923.json)已入库；此前初版及第二个独立项目目录也通过。将源 `session.jsonl` 追加一行空白后，校验在创建 Episode 之前因摘要不匹配而拒绝。这一分数**仅评价外部收据的投影合同**，不评价智能体完成任务的质量，也不能作为 Nexgent 原执行受预算准入、恢复或 RSI 改进的证据。外部原执行的成本未进入 Nexgent 用量账，不能把这行报告汇入正式 benchmark 成本／效果统计。

独立审查还指出：本地文件哈希只证明在给定摘要下的内部一致性，不能阻止一起改写摘要和收据；构建入口、patch 和 lockfile 的摘要尚未在投影进程里对原文件重算；诊断 evaluator 尚未独立重验所有来源。修订版 snapshot 已绑定 validator、bridge 和 adapter 源码摘要，并单列外部成本未知，但仍不是可信来源认证。生产路径需要可信来源锚点、宿主侧复核及外部成本结算。不能把这次 `accepted/1.0` 迁移解释成独立任务质量评价。

至此 A2 的**诊断投影**已跑通，生产桥接仍不存在。若采用 DeepSeek 执行后端，阶段 B 必须实现调用前准入、能力／handler 版本绑定、外部完成结算、side receipt 与 session 的可靠关联，并使真实 BenchmarkAdapter 只接收宿主认可的原任务证据。A3 的跨进程恢复见下节；同一真实模型路径仍待实测。

## A3：DeepSeek 跨进程恢复定向实验

新增 [`dsh_recovery_driver.ts`](dsh_recovery_driver.ts)、[`dsh_recovery_plugin.mjs`](dsh_recovery_plugin.mjs) 与 [`dsh_recovery.patch.yml`](dsh_recovery.patch.yml)。它们仍使用固定上游、官方 `headless` profile、人工编写的工具和固定模型 adapter；两次启动使用相同 cwd、DSH_HOME、session 存储，再通过公开 `--session-id` 恢复。父进程在工具结果已进入持久 JSONL、或 handler 已进入但无持久结果时强制结束子进程。实验保存 crash 前后 session、append-only handler 入口账本、插件 side receipt、两阶段 stdout/stderr 和各文件 SHA-256。

```powershell
node experiments/kernel_spike/dsh_recovery_driver.ts ..\NExgent-upstream-deepseek-46a7f68
```

Windows 上最终脚本由子智能体与根代理分别定向运行通过。最新收据位于 `E:\PKU\program\2026\Aug\te\.nexgent-dsh-recovery-jF0Qp6`；[摘要与哈希清单](evidence-a3-recovery-20260923.json)入库，九份原始收据／组仍在本机 scratch。运行前后上游 tracked tree 均 clean；摘要绑定实际执行的 CLI 构建入口、patch、插件与 lockfile 摘要。首次运行在 Windows 对只读 marker 句柄 `fsync` 触发 `EPERM`，失败收据留在 `.nexgent-dsh-recovery-0bCU8q`；改为可写句柄写入并同步后通过。

| 进程终止切面 | 恢复后的持久事件与外部账本 | 固定 adapter 的交付 |
| --- | --- | --- |
| 成功 `tool/result` 已在 crash 前的 session JSONL | 相同 call ID 的 `tool/call` 1、成功结果 1、未知结果 0、handler 入口 1；旧 turn 被标记 interrupted | `{"answer":42}`，没有再次发出工具调用 |
| `tool/call` 已在 JSONL、handler 已进入但没有持久 `tool/result` | 相同 call ID 的调用 1、成功结果 0、`TOOL_OUTCOME_UNKNOWN` 1、handler 入口 1；旧 turn 被标记 interrupted | `{"status":"unknown","action":"verify_external_state"}`，没有再次发出工具调用 |

每组 phase 1 都由父进程请求 `SIGKILL` 而结束，phase 2 退出码 0。断言还核对 crash 前的 session 是恢复后日志的前缀、结构化账本字段、`turn/end.reason.kind=interrupted`、固定 adapter 请求收据及输入摘要。此结果证明**进程终止后，恢复的历史使这个固定 adapter 能避免重发**；它不证明运行时对任意模型具有 exactly-once 去重、断电级持久性，也不证明真实外部业务副作用的提交／对账。未知组账本只证明 handler 已进入。外部原执行仍未进入 Nexgent 的预算和 evaluator，真实模型接通及生产技术选型尚待完成。
