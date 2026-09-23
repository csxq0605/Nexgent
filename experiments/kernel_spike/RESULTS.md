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

## A3：Python 路线真实 MiMo 模型调用

[`python_live_route.py`](python_live_route.py)在独立临时项目通过现有 `TaskService` 创建普通 Episode，固定 `mimo-v2.6-flash` 配置和同题输入，最多两次模型调用、512 completion token、一次工具调用，SDK 自动重试为零。凭据仅在内存读取，收据只记录配置引用和不含密钥的 profile 摘要。2026-09-23 唯一一次定向运行退出码 0；[脱敏收据](evidence-python-live-20260923.json)记录 Episode `completed`、两次真实模型调用共 260 prompt / 28 completion token、一次 `spike.multiply(6,7) → 42`、交付工件 `{"answer":42}`，并通过本地密钥字节扫描。原始 Episode 数据库保存在收据标明的本机 scratch 目录。

这证明现有 Python 路径能够把真实模型选择、预授权工具执行、预算用量和交付连在同一 Episode 中。模型通过两次 JSON `ask` 交互，**不是 provider-native tool calling**；工具由人工预先编写并在 Episode 创建时授权，任务中开发、安装、卸载和跨任务进化仍未证明。此次没有为同题任务测试动态租约，不能借真实模型成功覆盖前述任务内装入负结果。

## A3：DeepSeek 路线真实 MiMo 模型调用

[`dsh_mimo_driver.ts`](dsh_mimo_driver.ts)、[`dsh_mimo_plugin.mjs`](dsh_mimo_plugin.mjs) 和 [`dsh_mimo.patch.yml`](dsh_mimo.patch.yml)沿用固定上游 headless profile，以相同配置摘要接入 `mimo-v2.6-flash`，上限两次请求／一次工具、零自动重试。唯一一次真实运行的[失败摘要](evidence-a3-dsh-mimo-failure-20260923.json)与[运行后补强清单](evidence-a3-dsh-mimo-enrichment-20260923.json)均入库；原始 session、plugin receipt、stdout/stderr 和当时执行的脚本副本保存在摘要指向的本机 scratch 目录。

第一次请求得到模型原生 `spike.multiply({left:6,right:7})` tool call，MiMo 返回 627 input / 28 output token；DeepSeek session 持久记录工具调用和结果 42，handler 只执行一次。第二次请求已发出并返回 envelope，但当时的 adapter 未能将最终 `message.content` 解码为约定 JSON；分类为 `provider_protocol/final_decode`，进程退出码 1。总请求开始数为 2、完整模型收据数为 1、重试数为 0，**没有最终交付**。运行版本未先保存第二响应的 shape、finish reason 和 usage，因此不能在不重新请求的情况下确定是空内容、数组还是其他形态；不猜测根因。运行后只补强了后续尝试的观测字段，做本地语法／预检，没有再调用 provider。

因此这条路线只证明真实原生 tool-call 与工具闭环接通，不能算同题完整成功。其原执行仍没有进入 Nexgent Episode 的事前准入、预算或真实任务评分。Python 路线的完整 Episode 成功与 DeepSeek 路线的最终解码失败需并列进入内核 ADR，不能把两条路线成功片段拼成一次成功执行。

## A3：Python 任务级工具租约薄片

`TaskService.create(..., initially_active_capabilities=[])` 现在可以为**已安装且事先列入候选名称**的工具建立空活动作用域；宿主在 Episode 停止时调用 `mount_capability`，下次运行的工具 inventory 只包含活动租约。调用前核对 provider、版本、handler 身份、effect 与剩余工具预算，再写入工具准入记录并执行；结果事件保留租约 revision 和 descriptor。释放后不再接受新的调用路径，已完成 RPC 的旧结果仍可复用。初始租约与 Episode 创建在同一 SQLite 事务；中途失败不留下半套初始授权。

定向测试见 [`test_task_capability_leases.py`](../../tests/test_task_capability_leases.py)：作用域隔离、空 inventory 拒绝、真实 `TaskService.run` 的工具结果、完成后释放、进程重建后的 provider 漂移拒绝、委派子任务只继承父任务活动且同版本的描述、旧子任务缺版本界限时拒绝挂载。实现期间 50 项存储／运行时相关测试通过；最终安全修订后租约与委派相关的 20 项、释放修订后的租约 8 项通过。没有为该小样再次调用外部模型，真实 MiMo 成功仍属于上节**预授权静态工具**的单独 Episode。

这不是任务中安装新插件或完整 C1：候选工具名称和 handler 在任务创建前已存在于宿主 `ToolRegistry`；`handler_digest` 目前是受信 provider 提交的声明，不是从实际加载字节独立测得；释放影响 Episode 作用域，不执行 provider 进程／事件订阅清理。当前 `package_worker` 也不是 OS 安全容器。后续必须按[任务中能力授权合同](../../docs/design/task-time-capability-authority.md)把权限上限从“预列出名称”迁为 effect／操作／资源约束，并在隔离 worker 中真正试装模型开发的 fresh-name Definition。

### 同一 Episode 的真实模型与租约

新增 `python_live_route.py --leased`，保留原无参数静态路径。该诊断脚本在空活动清单下创建 Episode，由宿主在执行前挂载人工预写的 `spike.multiply`，随后让 MiMo v2.6 flash 在两次 JSON `ask` 之间选择并调用工具，任务完成后释放租约。2026-09-24 的**唯一一次**限额运行退出码 0；[脱敏收据](evidence-python-leased-live-20260924.json)记录同一 Episode `episode-5ae0d466e0a04de7` 完成，真实模型调用 2、工具调用 1、结果 42 和工件 `{"answer":42}`。模型报告用量 260 prompt / 29 completion token；自动重试 0。创建／挂载／完成／释放时的清单依次为 `[] / [spike.multiply] / [spike.multiply] / []`；租约 revision `1 → 2`，工具收据绑定 descriptor digest。独立重开 SQLite 核对 Episode `completed`、租约 `released`、mount/tool/release 事件各 1、模型调用账 2。

这补齐了 Python 同一次模型执行与任务级租约的 A3 证据，但**挂载动作仍由宿主在运行前完成**。模型没有发现能力缺口后自己编写／试装工具，handler 摘要仍由宿主声明，模型工具选择采用 JSON `ask` 而非 provider-native function call。因此它支持内核选型，不满足 C1、跨任务采用或 RSI 效果验收。

## C1 工具切片：真实模型在任务中开发未知名称工具

2026-09-24 使用 [`python_dynamic_tool_live.py`](python_dynamic_tool_live.py)做**一次**限额运行，[脱敏收据](evidence-python-dynamic-tool-live-20260924.json)已入库，原始 SQLite 在收据指明的本机 scratch。任务创建时 `capabilities=[]`、活动工具清单为空；冻结授权只允许 `tool/local_compute/controlled-python-v1`，定义和调用各最多一次。MiMo `mimo-v2.6-flash` 通过 `tool_builder` 请求返回它写的 `multiply_integers` 源码、输入／输出 schema 和参数 `{a:6,b:7}`。Nexgent 将此前未知的名称编译成 Definition，在同一 Episode 持久 stage/mount，重新读取 inventory 后在受控 worker 中执行模型源码，返回 42；第二次模型请求使用工具结果交付 `answer=42`。Episode `episode-d30ca5aa3ec74462` 为 `completed`，模型调用 2、工具调用 1、节点 7；实际用量 254 prompt / 300 completion token；零自动重试，凭据字节扫描通过。调用收据绑定 authority、Definition、Instance revision、bundle／入口摘要和 worker 的 9 个 trace 事件。

这是**模型生成并实际使用新工具**的任务内证据，比 A3 的人工预写租约多了一步。实验程序仍预设“先请模型开发工具，再调用，再写答案”的路线；模型没有独立决定是否开发、没有编写服务／策略插件，也没有经过跨任务独立评价与默认采用。`tool_work_units=0` 是既有可信工具工作量账，**不等于零计算成本**；受控 worker 此次执行 9 个 trace 事件，每次硬上限 20 万，且不是 OS 级容器。结果只属于 C1 工具切片，不宣称 B／C 全部通过或 RSI 净收益。

对照边界：固定 [DeepSeek Harness 源码审计](../../docs/research/kernel-reference-audit-20260923.md)里的作用域服务／provider／模型工具分层，Nexgent 此次只实现了**模型写工具定义 → Episode 实例 → 调用收据**，服务生命周期和 provider 替换未实现。[AutoSci](https://github.com/skyllwt/AutoSci/tree/arxiv-v1)的技能／图／反馈更新、[ADAS](https://arxiv.org/abs/2408.08435v2)的可执行 Agent 搜索、[AFlow](https://arxiv.org/abs/2410.10762v4)的工作流搜索，仍对应后续 D/E 的编排与候选评价；一次算术工具成功不能代替它们。OpenFOAM 等领域 demo 没有参与本次核心验收。

## C 服务切片：默认任务智能体真实开发并激活上下文服务

2026-09-24 使用 [`python_service_seed_live.py`](python_service_seed_live.py)进行一次限额 MiMo `mimo-v2.6-flash` 运行。[脱敏收据](evidence-python-service-seed-live-20260924.json)的 SHA-256 为 `496885F4AB11D3B8EDE330C0E94CD7FA6024A9DB7846752F0B785BCAB402E474`，原始 SQLite 在收据标明的本机 scratch。普通 `TaskService` 默认种子包从无已安装工具开始，由真实模型选择 `develop_service`，编写 `comparison.criteria` 的 `provide(payload, context)`，随后选择 `activate_service`。同一 Episode 的后三次模型调用经过该服务并留下 Definition／Instance／Authority 与有效 payload 摘要；最终工件根据 50ms 延迟上限选 A。Episode `episode-b194c9017d83486c` 为 `completed`，模型调用 5、节点 15，实际报告 11,889 prompt / 770 completion token，服务应用 3 次，自动重试 0，凭据扫描通过。

这验证模型生成的**任务内服务**能改变后续模型调用的 JSON 上下文，且默认任务智能体能自己发出开发、激活动作。任务文字明确要求开发服务，故仍**不能证明模型会自主判断能力缺口**；这也不是工作流／角色／DAG 的更新。服务未跨任务独立评价和采用，没有固定框架对照、成本收益或 RSI 净收益。受控 Python worker 每次上限 20 万 trace 事件，不是 OS 容器；服务调用与工具共用 root `max_tool_calls`，实际 worker 指令暂未纳入 `max_tool_work_units`。DeepSeek 式 Definition/provider/consumer 的首个窄接口有运行证据；AutoSci、ADAS、AFlow 对应的编排搜索和跨任务选择仍在 D/E 阶段。

### Main 图种子的四次真实服务任务：负结果与合同修复

使用 [`python_main_graph_service_live.py`](python_main_graph_service_live.py) 通过 Main 相同的版本化图 package/channel 和 v2 EpisodeAuthority 调用 MiMo `mimo-v2.6-flash`。每轮限制最多 8 次模型调用、8 次能力调用、100 节点，自动重试 0；这是图执行机制探针，不是 RSI 收益研究。四轮均保留脱敏 JSON 与本机 scratch 原始 Episode：

| 轮次／收据 SHA-256 | 机械状态与真实判断 | 发现／后续修复 |
| --- | --- | --- |
| [v1](evidence-python-main-graph-service-live-20260924.json) `05AC92E059E7EA069B056C263C6642D3FE7D28606C58CDCFED99BDF8940D94DA` | `failed`；服务已开发、激活并作用于模型调用，选择错误，发布被当时写死 A 的 schema 拒绝 | 图把输入工件 ID 当作内容；规划提示改为先 `read_artifact` 再传 `.content` |
| [v2](evidence-python-main-graph-service-live-v2-20260924.json) `E3E208D265DB77B6D594AFD5BB3C3E23D44DDD9DF74C4AC5B18137FABB6BC173` | `failed`；模型读了真实输入，服务未激活 | `services.model_context.v1.revision` 无法经点分隔 binder 访问；增加 `model_context_service.revision` 路径安全投影 |
| [v3](evidence-python-main-graph-service-live-v3-20260924.json) `735134D5012BCF789E3C6E4315DC2CFF1A3FFB4F0B7680B2ABD1B8F9AEC88E5F` | 机械状态 `completed`，**任务质量失败**；两次服务应用，选择 A，但理由声称选项数据缺失，验证节点也返回 `valid=false` | 模型写的服务用纯准则覆盖了原 payload，清空了实际输入；且旧实验 schema 的 `const: A` 泄露答案并制造假阳性。现在要求服务保留原有 top-level 字段，实验 schema 只允许 A/B，另由独立事实检查评分 |
| [v4](evidence-python-main-graph-service-live-v4-20260924.json) `43CF7BC0E8B8F4BAA50E69C8A1CAA7478317F3468040A550BD71BCADF4914E87` | `failed`；模型调用 3、节点 6，服务 Definition 已生成但未激活；独立质量检查失败 | 架构智能体把 `$node...`／`$input...` 放进普通字符串参数；运行时才发现 `expected_revision` 非整数。现于图编译期拒绝并向修复循环提供诊断 |

`model_context.v1` 的当前安全边界只允许添加模型 payload 的顶层字段，不能删改已有证据；这是首版窄接口，不是通用 provider。上述修订通过 22 项服务／图／Main 定向测试；最后一次实跑发生在编译期类型检查加入之前，故**没有**测试宣称该修复能让 MiMo 的图完成任务。四次样本不能估计成功率。它们说明图编译、数据传递、服务变换和独立评价必须同时正确，仍未证明模型能根据反馈更新编排并跨任务采用。
