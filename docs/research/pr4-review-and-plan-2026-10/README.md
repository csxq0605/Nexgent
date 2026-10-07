# Draft PR #4 评审与 Nexgent 工程实现计划（2026-10-07）

本文回答两个问题：[Draft PR #4](https://github.com/csxq0605/Nexgent/pull/4)（`refactor/dsh-application`）的内容、定位和方向是否正确；在 2026-10-07 给定的产品目标、六步顺序与“DSH 作为参考重写”的接入方式下，结合 PR #2 调研结论、`roadmap/research-agent-next` 和 REFACTOR_PLAN 历史，接下来应该怎样做工程。全部判断基于 2026-10-07 的分支顶端 `fd0b2f4`，没有运行真实模型。

## 一页结论

1. **方向对了，形态还是偏。** PR #4 终于采纳了 PR #2 的核心建议——以 DeepSeek Harness（DSH）为执行底座，把可进化对象从 15KB 私有 DSL 换成小而规整的配置（节点 = 角色 + 提示 + 依赖 + 模型 + schema + 人设 + 工具掩码）。证据纪律也保持得很好：未知结果不算成功、不宣称 RSI 收益。
2. **接入方式与决定不符。** 用户决定 DSH 只作参考、Nexgent 自己重写运行时；PR #4 却把 13,321 个文件的 DSH 源码以 subtree 整体导入，Nexgent 自己的 TypeScript 只有约 1,500 行（含测试），且分散在上游包里。DSH 处于 developer preview，上游 npm 已到 0.2.0-rc.2，仓库固定在 0.1.7-rc.1。按参考重写的方式，`runtime/` 不进入仓库，DSH 以只读子模块保留供对照，Nexgent 在自己的 monorepo 里按需改写所需的包（见 4.0）。
3. **“组织”这一层仍然没有出现。** 可进化对象是静态 DAG；没有花名册、邮箱、任务板、沟通规则、决策权，也没有按成员归因和成本账。DSH 自带的 `experimental/agent-team`（持久邮箱 + 共享任务板）在 Nexgent profile 里没有启用。
4. **采用门是回归夹具，不是任务质量门。** `architecture_trial / adopt / run` 只支持“全局工具为空、输出型图、宿主写死的输入与期望 JSON、精确相等”；selection 只比通过数，没有成本项、没有重复、没有留出集；候选还得由模型或人手工提交，普通反馈→候选的生成器未实现。这与 PR #2 前沿①⑥⑦的要求（等预算、重复、held-out、成本总账）距离很远。
5. **顺序颠倒。** PR #2 建议的阶段 1 退出门槛是“自建执行层代码明显减少”，阶段 2 是“先找到团队确实优于单智能体的任务家族”。PR #4 跳过了这两步，直接把阶段 3 的采用／激活／回滚管道做了第三遍（Python P3 控制面、组织服务门控、DSH 内核 Python 门控、现在的 TS 版），而 45,288 行 Python 宿主仍原样留在仓库里。
6. **可运行性差。** 只有 Windows 启动器，Windows ACL 是唯一验证过的沙箱；根目录 CI 仅手动触发且只跑 Python，TypeScript 运行时在本仓库没有任何 CI；PR #4 没有一次检查运行。
7. **建议：** PR #4 分支保留为参考与移植来源，不再提交；从 `main` 新建集成分支，以 Cordis 为库、DSH 为只读参考，按六步重写 Nexgent 运行时。PR #4 里 Nexgent 自己写的架构编译器、激活存储、账本和验收脚本设计直接移植。第 4 节按六步给出每步的参考实现、可移植部分、工作项、验收与风险，并给出 DSH 包组的改写 / 不要裁剪表。

## 1. 仓库与分支现状

### 1.1 分支谱系

```text
main (8e750a4)  PyQt 科研 Coding Harness（当前 README 描述的产品）
├── research/org-rsi-review-2026-09   PR #2  纯文档：重审 + 276 篇调研（2026-09-28）
├── roadmap/research-agent-next       无 PR  2026-08 科研运行时规范 M0–M6（已被后续方向放弃）
└── refactor/scientific-rsi           PR #1  176 commits，+750k 行，通用 RSI 框架（Python）
    └── feature/organization-loop     无 PR  +23 commits，组织提案应用、TaskService 框架化
        └── fix/main-delivery-...     PR #3  +3 commits，DSH 作为外置内核（SDK + MCP 桥）
            └── refactor/dsh-application  PR #4  +11 commits，DSH 源码 subtree + 原生架构图
```

四个 PR 全部未合并；PR #3、#4 的 base 不是 `main`，而 `main` 本身是另一个产品（长周期科研 Harness GUI）。从 `main` 到 PR #4 顶端共 213 个提交，没有任何一段进入过主干。这意味着“合并路径”目前不存在，任何一个 PR 单独合并都会让 `main` 变成不一致状态。

### 1.2 PR #4 实际包含什么

| 组成 | 规模 | 说明 |
| --- | --- | --- |
| `runtime/` DSH 源码 subtree | 13,321 文件 | `deepseek-ai/deepseek-harness@46a7f68b`（0.1.7-rc.1）squash 导入，含 `.agents/` 3,573 个文件、`snapshots/` 1,193 个文件、`website/` |
| Nexgent 对上游包的修改 | 约 20 个源文件 | `tool-workflow` 新增 `architecture.ts`（声明式图编译）、`architecture-store.ts`；`core/tools` 新增 `tool-restriction.ts`；`workflow-ptc` 透传 persona/toolFilter；`sandbox-windows-acl` 修错误路径；品牌与 profile 调整 |
| `@nexgent/application` bundle | `src/` 716 行，`tests/` 757 行 | `cordis.patch.yml`（MiMo 默认、禁用 DeepSeek 账户）；`execution-ledger.ts`（旁路请求账本）；`architecture-trials.ts`（输出型成对试用 + 策略采用）；`architecture-activation.ts`（硬链接发布的激活记录） |
| 根目录脚本 | 13 个 `.mjs` + PowerShell | 构建后应用的进程级验收与真实 MiMo 验证 |
| 文档与证据 | `docs/validation/` 104 个文件、3.2 MB | 七份 JSON 摘要 + 原始 JSONL 请求记录 + SHA-256 manifest |
| 保留的 Python 宿主 | `src/` 45,288 行、125 个测试文件 | README 称“迁移资产”，默认入口已不再使用 |

PR 描述里的 32 项测试、100% 覆盖、七进程验收等数字只对应最后一个提交涉及的两个源文件，不是对 PR 的整体验证。

### 1.3 原生架构图现在能做什么

`tool-workflow` 的 `architecture` 是一个 `{nodes:[...]}` JSON，每个节点有 `id / role / prompt / dependencies / provider? / model? / schema? / persona? / toolFilter?`，编译成一个用 DSH `agent()` 的 JavaScript 工作流：节点在依赖完成后启动，依赖的实际输出作为 JSON 塞进子智能体提示。版本是节点规范化后的 SHA-256。定义可保存到 `.nexgent/native/architectures/`，新 Session 用 `architectureVersion` 显式执行。

`architecture_trial`：宿主在 profile 里冻结 `plans`（基线图 + 若干 `{input, outputNode, expected}` 用例）；模型提交候选图，宿主用空工具掩码分别跑基线与候选，按 `isDeepStrictEqual` 比较输出节点的结构化结果。`architecture_adopt`：候选必须 selection 全过且通过数严格大于基线、guard 全过、无 unknown；每个候选消耗一个持久化尝试槽；并发只采用一个版本。`architecture_run`：自动读取已采用版本、核对编译脚本摘要、执行失败则回滚到基线。

这些机制在脚本化 provider 下验证过；真实 MiMo 的一次试用是基线 2/2、候选 1/2、一个 unknown，未采用。

## 2. PR #4 评价

### 2.1 内容

**做得好的地方**

- 真正读懂并复用了 DSH 的 workflow / subagent / sandbox / credentials / session 机制，没有再造 agent loop。`architecture` 编译器只有 130 行，却把“角色、依赖、模型、schema、人设、工具掩码”收进一个内容寻址的版本身份——这正是 EvoMAS / AOrchestra 式“小而规整的配置空间”。
- 请求账本（execution ledger）把主智能体、成员、标题调用都记了下来，缺失用量显式标 unknown，不记提示正文和密钥。这是做成本账的正确起点。
- 激活存储用“先写私有文件 + fsync，再硬链接独占发布”解决并发采用，预留槽位防跨进程重复抽样；回滚不重放失败任务；用户取消不算退化。这套语义可以保留。
- 每一处宣称都有边界说明；unknown 不被文字 JSON 或重复抽样替代；没有把机制验证说成模型收益。

**问题**

1. **整体导入与“参考重写”的方向相反。** Nexgent 对上游包的实际改动只有几百行，全部是“给 workflow 节点加几个字段”这类变化；而整体导入的代价已经出现：PR 无法评审（13,405 个文件）、`pnpm-lock.yaml` 与上游分叉、上游 0.1.7-rc.1 → 0.2.0-rc.2 的变化需要人工合并、`.agents/`、`snapshots/`、`website/` 等无关内容进入主干。参考重写要求 Nexgent 只保留自己需要并理解的代码，每个包有自己的测试固定边界。
2. **可进化对象仍不是“组织”。** 节点之间只有“依赖输出传递”，没有消息、没有共享任务板、没有角色间的决策权或审查规则；没有成员级归因（谁花了多少、谁的输出被采用）。PR #2 的结论是：失败主要出在通信与决策权，可进化对象应优先是这些。DSH 的 `experimental/agent-team` + `tool-agent-team`（Lead + 具名队友 + 持久邮箱 + 任务板，九个工具）正是这一层的物理实现，PR #4 没有用它。
3. **门控不能评价真实任务。** 输出型试用要求成员无任何全局工具，只能跑“读输入 JSON → 产出 JSON”的图；真正的产品任务（写文件、跑测试、查表）无法进入 selection。用例是宿主手写的精确期望，与“从普通任务反馈学习”无关。selection 没有成本项（PR #3 的 Python 门控至少要求质量不降且消耗 −20%），没有重复（Anthropic "Infrastructure noise" 指出基础设施配置本身就能让分数波动），没有留出集（PR 自述“不是封闭留出集或防篡改评价器”）。
4. **第三次重写同一套管道。** PR #1 的 P3 控制面（Python，`evolution.py` 1,799 行 + `generation.py` 1,628 行）、organization-loop 的 `OrganizationService` 门控、PR #3 的 DSH 内核 Python 门控，到 PR #4 的 TS 版，每一代都停在“脚本化 provider 下机制验证通过，真实模型 0 或 1 次正例”。PR #2 根因 4（每次只有 1 个样本）和根因 6（验证粒度与代码增长不匹配）没有解决：PR #4 的 11 个提交在两天内完成，每个提交都带一份新的证据 JSON。
5. **没有人能跑。** `start.ps1 / run.ps1` 只有 PowerShell；沙箱只验证了 Windows ACL，而且 Modify-only 目录会失败；根目录 `.github/workflows/test.yml` 是 `workflow_dispatch` 且只装 Python。TS 运行时的 vitest 没有进入任何 CI。这意味着评审者无法独立复现 PR 描述里的任何验收。
6. **产品面不清晰。** README 同时描述 0.8 源码自修改循环、0.9 `task / rsi-*` 命令、组织 demo、DSH 内核 Python 入口和原生应用五代入口；PR #2 已指出“近 30 个 `rsi-*` 命令”偏离“单一 Main 对话 + 信息窗口”的要求，PR #4 没有收敛，只是又加了一层。

### 2.2 定位

| PR #2 的定位要求 | PR #4 的状态 | 判断 |
| --- | --- | --- |
| 建在现成底座上，Nexgent 只做组织进化层 | 用了 DSH，但是整体 fork；Python 宿主未退役 | 半达成 |
| 可进化对象是成员、角色、沟通规则、决策权、SOP | 只有 DAG 节点配置；无规则、无通信、无 SOP | 未达成 |
| 按成员归因指导改动 | 账本记录到成员级请求，但没有与任务结果关联，也没有归因算法 | 起点有，未达成 |
| held-out + 成本账决定采纳 | 精确匹配夹具；无成本、无重复、无留出 | 未达成 |
| 换模型重学组织 | 无 | 未达成 |
| 单一 Main 对话 + 信息窗口 | 用 DSH 自带 Web UI；没有组织图、归因、门控、成本的信息窗口 | 部分 |
| 阶段合并前跑全量测试 | Python 全量不再跑；TS 只跑定向 spec | 未达成 |

### 2.3 方向

- 正确的部分：以 DSH 为执行层；配置式图表示；候选必须通过独立 selection 与 guard 才能被后续任务自动读取；失败 / unknown / 成本进入证据；执行失败自动回滚。
- 需要纠正的部分：整体导入 → 以 DSH 为参考、按需改写进 Nexgent 自己的包；DAG → 四种执行形态与可版本化的协作方式（成员 + 通信 + 规则 + 技能）；夹具门 → 回放集、重复、留出、成本的评价协议；先机制 → 先把日常任务体验接通；Windows-only → 两平台 CI；五代入口并存 → 一个入口。
- 需要承认的事实：到今天为止，Nexgent 在 DSH 之上提供给用户的新能力只有“把一个图保存下来再按版本执行”和“跑一组宿主写死的 JSON 用例”。组织进化层的核心（归因、变更算子、门控协议、跨任务资产）都还没有开始。

### 2.4 进度表

以 REFACTOR_PLAN 2026-10-06 的五步和 PR #2 的六个阶段为参照：

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| 导入 DSH、建立构建、Main 与 headless 入口 | 已完成（Windows） | `native-application-20261006.json`，真实 MiMo 文件交付与续聊 |
| 可执行、可版本化的架构图 | 已完成（DAG 子集） | `native-architecture-*.json`、`native-node-composition-20261007.json` |
| 原生请求账本 | 已完成（旁路、未签名） | `native-execution-ledger-20261007.json` |
| 迁移 selection / guard / 采用 | 部分：仅输出型、精确匹配、无成本 | `native-output-trials / adoption-20261007.json` |
| 普通反馈 → 候选生成 → 路由 | 未开始 | PR 自述 "still pending" |
| 代码 / 工具工件、上下文策略、执行器进化 | 未开始 | 同上 |
| 真实模型采用正例 | 0 次 | MiMo 试用 unknown，未采用 |
| PR #2 阶段 0 止血（全量测试、瘦身、拆 PR） | 未做 | PR #4 比 PR #1 更大 |
| PR #2 阶段 1 底座决策（自建执行层明显减少） | 决策做了，减少没做 | Python 45k 行仍在 |
| PR #2 阶段 2 基线（团队 vs 单智能体） | 未做 | 无任务家族、无等预算对照 |
| PR #2 阶段 3 组织进化层 v1 | 未做 | 无归因、无变更算子、无 held-out |

## 3. 从前序 PR 与分支继承的结论

这些结论在 PR #2、organization-loop 实测和 PR #3 实测里已经有证据，计划直接采用，不再重新讨论：

1. 私有 DSL 让模型写图会失败（PR #1 的 10 次真实闭环 0 次晋升；Evoflux / EvoMAS 文献一致）。配置空间要小，模型只填字段，不写代码。
2. 执行模型和改进模型不能都是 flash；N=1 的探针没有统计意义；门控必须有外部验证信号（SkillLearnBench、RSEA）。
3. 多智能体不是默认更好；有效前提是任务可分解 + 有可靠验证；最优组织随模型和任务变化，必须和单智能体在等预算下比。
4. 增 / 删 / 改成员各有成熟做法：入职试跑（MonoScale）、基线锚定接受（AgentSlimming）、按成员归因（HiveMind DAG-Shapley）、规则进化（Constitutions）。要做的是把它们统一进一个有门控的生命周期。
5. organization-loop 的七次真实运行证明了一件事：“精简 2 名成员为 1 名并在新进程复用”这种配置级改动，真实模型是能产生并通过门控的（`6d57db70`）；真正没证据的是泛化与净收益。
6. PR #3 证明了 DSH 原生循环 + 宿主门控 + 新进程复用的工程链路可以走通（revision 1，单对 selection 消耗 −33.7%），但也证明了一个任务族、一对样本、同模型审核的结果不能推广。
7. `roadmap/research-agent-next`（2026-08 的科研运行时 M0–M6：Capability ABI、effect ledger、aligned checkpoint、ClaimCI、RecoverSpec）与当前方向不同，其中“effect 生命周期 / verify-before-retry / 单一事实源”的不变量仍然适用于组织层的账本设计，其余按历史保留。

## 4. 工程实现计划（按六步，DSH 作为参考重写）

目标与顺序以 2026-10-07 的产品定义为准：以 DSH 源码为基础、使用并改造其 Cordis 运行架构，做成能完成真实任务、持续积累能力并改进自身的 Nexgent 独立应用；用户面对项目、对话、资料和成果；默认模型 `mimo-v2.6-pro`。订单、Excel、科研、OpenFOAM 是应用案例，benchmark 只用于测量。

DSH 的接入方式按用户决定为**参考重写**：DSH 源码只作阅读参考，不以 subtree 进入仓库，也不作为运行时 npm 依赖；Nexgent 在自己的 TypeScript monorepo 里按需重写所需的运行时，Cordis 及其配套库作为普通 npm 依赖使用。下面每一步给出：DSH 中的参考实现、PR #4 可移植的部分、要做的工作、验收、决策与风险。

### 4.0 横切安排

**参考重写的规则。**
- 仓库结构：`packages/*`（`@nexgent/*`）、`apps/*`、`docs/`、`benchmarks/`（夹具）、`reference/deepseek-harness`（git submodule，固定 `46a7f68b`，只读，不参与构建，供对照阅读）。
- 依赖：Cordis 运行架构直接用 npm 上的 `@deepseek-ai/cordis`（4.0.4）、`@deepseek-ai/schemastery`（3.18.4）与 `@cordisjs/loader`；模型接入用 pi-ai 的 OpenAI 兼容客户端。这些是库，不是 DSH 应用代码。
- 代码来源：允许从 DSH 复制并改写文件（MIT）。复制的文件头部注明 `Adapted from deepseek-harness@46a7f68b <path>`，`THIRD_PARTY_NOTICES.md` 列出 DSH；`docs/reference-map.md` 维护一张表：DSH 包 → Nexgent 包 → 处理方式（改写 / 重写 / 不要）。
- 保留 DSH 的服务名与模块边界（`ctx.agents`、`ctx.tools`、`ctx.session`、`ctx.workflowEngine` 等）作为 Nexgent 的内部接口命名，使 DSH 的架构文档继续可用作参考，也便于日后对照上游修复。
- 不追求与 DSH 功能对等。每个包只实现 Nexgent 当前步骤需要的部分，边界用测试固定；不复制 DSH 的 session 格式迁移、多 provider、i18n 文档、snapshot 测试体系。

**范围裁剪。** DSH 的 TypeScript 源码约 16 MB、2,228 个文件（不含测试与文档），按组分三类：

| 处理 | DSH 包组（源码 KB） | Nexgent 对应 |
| --- | --- | --- |
| **改写进 Nexgent（步骤 1）** | boot（383）、core（632）、llm（564）、session（749）、credentials（130）、storage（95）、workspace（58）、fs（254）、shell（208）、subprocess（245）、sandbox（161）、util（154） | `@nexgent/kernel`（profile 装载、agent loop、scope、tools、system prompt）、`@nexgent/llm`、`@nexgent/session`、`@nexgent/workspace`（fs、shell、sandbox、subprocess）。目标约为 DSH 对应代码的三分之一 |
| **改写进 Nexgent（步骤 2）** | context（170）、compaction（128）、deliverables（62）、goal（103）、jobs（94）、skill（111）、attachment（87）、feedback（27）、interaction（90）、hooks（77）、api（787）、host（165）、sdk（79）、client 中的 chat / conversation / session / deliverables / approval / workspace / settings-models（client 组共 5,108，只取这些） | `@nexgent/context`、`@nexgent/tasking`（goal、jobs、deliverables、feedback）、`@nexgent/skill`、`@nexgent/remote`（host ↔ client 协议）、`apps/web`（精简界面） |
| **改写进 Nexgent（步骤 3）** | subagent（438，只要 fresh / fork）、workflow（187）、ptc-runtime（97）、preset（51）、experimental/agent-team + tool-agent-team、mcp（60）、web（132） | `@nexgent/subagent`、`@nexgent/workflow`（含 PR #4 的 architecture 编译器）、`@nexgent/ptc`、`@nexgent/team`、`@nexgent/preset`、`@nexgent/mcp` |
| **不要** | desktop、acp、computer-use、browser-use、voice、deepseek-account、identity、telemetry-otel、lsp、ssh、terminal、tmux、spill、webhook、document、typert、test-support、website、snapshots、`.agents` 笔记、i18n 文档、Claude Code / Codex subagent provider | 需要时再从参考库改写 |

**分支与合并。** 新建集成分支 `nexgent-app`（从 `main` 起）；PR #4 分支保留为参考与移植来源，不再提交。每一步以小 PR 合入集成分支；步骤 2 验收通过后合入 `main`，旧 PyQt 产品归档为 `archive/harness-gui`；Python 宿主在步骤 3 删除并归档为 `archive/python-host`。

**CI 先于新机制。** GitHub Actions 改为 push / pull_request 触发：Linux job 跑 `pnpm install --frozen-lockfile`、`pnpm build`、`pnpm test`（vitest，脚本化 provider）与各步验收脚本；Windows job 跑同样内容；真实模型验收保留手动 workflow。

**证据卫生。** `docs/validation/` 只保留摘要 JSON 与 SHA-256 manifest，原始 JSONL 移到 Release 附件；每步一份验收记录。

**平台。** 从步骤 1 验收起 Linux 与 Windows 同时通过。沙箱先实现 Linux / macOS 的路径与命令策略（参考 `sandbox-local`、`fs-sandbox`）；Windows ACL 隔离（参考 `sandbox-windows-acl`，161 KB）作为步骤 1 的可选项，先用路径策略，后补 ACL。

### 4.1 步骤 1：建立基于 DSH 的 Nexgent 主应用

参考实现：`app-boot`（profile 组合与 patch）、`agent-loop`、`scope`、`tools`、`system-prompt`、`llm-pi-ai` + `token-meter`、`session-persistence-jsonl` + `session-checkpoint-policy` + `session-projection`、`credentials-local`、`fs` / `shell` / `subprocess` / `sandbox`、`bundle/headless` 与 `bundle/web-app`。

PR #4 可移植：`cordis.patch.yml` 的产品默认值（MiMo 路由、thinking 关闭、系统提示）、`execution-ledger.ts`（旁路请求账本）、`architecture-activation.ts`（激活记录）；PowerShell 启动器的参数设计。

要做的工作：
1. `@nexgent/kernel`：Cordis 应用装载（YAML profile + patch 行，参考 `app-boot`），`ctx.agents` 创建 / 恢复，agent loop（请求模型、执行工具、写入会话），`ctx.tools` 注册与作用域，系统提示组装。
2. `@nexgent/llm`：单一 OpenAI 兼容路由（MiMo），流式与工具调用，用量计量，`maxRetries: 0` 并把每次请求写入账本；思考关闭。
3. `@nexgent/session`：JSONL 追加写 + checkpoint，启动时按会话 ID 恢复；只定义一种格式（v1），不做历史迁移。
4. `@nexgent/workspace`：工作目录、文件读写与搜索、`str_replace` 编辑、bash / pwsh 工具、子进程与沙箱策略（路径白名单、写入限制）。
5. `apps/cli`：`nexgent web --project <dir>`、`nexgent run --project <dir> --task "..."`、`nexgent resume <session>`；项目数据目录 `.nexgent/`（`sessions/ materials/ outputs/ capabilities/ ledgers/`），密钥从 `NEXGENT_API_KEY` 或本机凭证文件读取。
6. 验收脚本 `scripts/accept-step1.mjs`：脚本化 provider 下启动 → 完成一次写文件任务 → 杀进程 → 新进程 `resume` 续聊；Linux 与 Windows CI 各跑一次。真实 MiMo 手动各跑一次并留摘要。

验收：通过 Nexgent 入口启动，完成真实任务并保存原生会话；不存在 Python 执行路径；两种操作系统通过。

决策与风险：这一步是重写里最大的一块（DSH 对应代码约 3.6 MB）。按“每个包只做当前需要的部分”执行，预计 Nexgent 版本约 1 MB；工期从 fork 方案的 1 周变为 4–6 周。重写初期会缺少 DSH 多年积累的边界处理（取消、超时、并行工具调用），要靠验收脚本和故障注入测试补回，而不是靠复制整包。

### 4.2 步骤 2：接通完整的日常任务体验

参考实现：`workspace`、`context/file-reference` 与 `agent-instructions`、`compaction-basic`、`deliverables`（`present` 工具 + 每轮文件变更）、`feedback`、`goal`、`jobs`、`skill` + `skill-office`、`api/remotes` + `gateway`、`host`、`sdk`、client 中的 `ui-chat / ui-conversation / ui-session / ui-deliverables / ui-approval / ui-workspace`。DSH 的 `attachment` 包只支持图片，不作为资料流程的参考。

要做的工作：
1. 项目模型：项目 = 工作目录 + `.nexgent/`；最近项目、新建、切换。
2. 资料：“添加资料”复制到 `.nexgent/materials/<id>/`，以文件引用注入对话；Office 文件按 `skill-office` 的方式用技能说明 + 工具读取。
3. 成果：`present` 工具声明最终交付；每轮文件变更记录；`outputs/` 保存每轮快照供反馈修改时对比。
4. 反馈修改：对成果提出修改即新一轮；评分与评语记录到会话并关联成果版本（步骤 5 的输入）。
5. 停止与继续：取消当前轮保留已流出文本；跨重启用持久目标（参考 `goal`）+ 会话恢复；验收包含轮中 `kill -9` 后恢复。
6. 上下文：工作区说明文件注入、长对话压缩（参考 `compaction-basic`，只做基本摘要）。
7. 远程层与界面：`@nexgent/remote` 定义 host ↔ client 的类型化调用与事件流（参考 `api` + `sdk`，去掉与 Nexgent 无关的能力）；`apps/web` 用 Vite + React 实现六个视图：项目、对话、资料、成果、改进（步骤 5 填充）、设置（模型与密钥）。CLI 与 SDK 走同一远程层。

验收脚本 `scripts/accept-step2.mjs`：提交资料 → 执行 → 成果文件存在且被 `present` → 提出修改 → 成果更新 → 杀进程 → 重启继续 → 会话、资料、成果全部可见；CI 两平台通过，真实 MiMo 手动一次。

决策与风险：界面是第二大工作量。DSH client 组 5.1 MB 里 Nexgent 只需要约六个视图，但 DSH 的 UI 与其 remote 协议耦合紧，复制收益小，建议从空白 React 工程开始，只参考交互设计。工期 3–4 周。

### 4.3 步骤 3：迁移已有能力，补齐灵活协作

参考实现：`subagent`（fresh / fork）、`experimental/agent-team` + `tool-agent-team`（具名队友、持久邮箱、共享任务板）、`workflow` + `workflow-ptc` + `tool-workflow`（图 / 脚本）、`ptc-runtime-node`、`agent-preset(-registry)` + `persona`、`skill-filesystem`、`mcp`、`web`。

PR #4 可移植：`tool-workflow/src/architecture.ts`（声明式图编译器）与 `architecture-store.ts`，`core/tools/src/tool-restriction.ts`，`workflow-ptc` 的 persona / toolFilter 透传——这些本来就是 Nexgent 写的，直接搬到 `@nexgent/workflow`。

Python 资产迁移表：

| Python 资产 | 去向 |
| --- | --- |
| `organization_spreadsheets.py`（读 / 查询 / 写带公式的 xlsx） | `@nexgent/tool-spreadsheet`（TS，SheetJS 或 exceljs），查询用 PTC 函数 |
| `run_python` 受限计算 | `@nexgent/ptc`（Node 后端，参考 `ptc-runtime-node`）；需要 CPython 时再参考 `ptc-runtime-python` |
| 公开网页读取 | `@nexgent/web`（参考 DSH `web` 组） |
| `.nexgent/skills/*.md`、技能编译器 | SKILL.md 目录发现（参考 `skill-filesystem`），不再编译成 Python 子包 |
| 组织角色与规则、成员目录 | `@nexgent/preset` 的预设 + 团队模板（JSON） |
| `tasks/` 的 evolution / generation / guards / feedback_trigger / studies | 作为步骤 4–6 的设计依据重写为 TS；不迁移代码 |
| benchmarks（workbench、bbh、scientific_discovery、openfoam） | 任务数据与评分器保留为 `benchmarks/*` 夹具；Python 插件删除 |

要做的工作：
1. `@nexgent/subagent`：fresh / fork 两种子智能体，继承沙箱与预算；`@nexgent/team`：Lead + 具名队友 + 持久邮箱 + 任务板（参考 experimental agent-team，重写时去掉 experimental 的兼容层）；`@nexgent/workflow`：脚本与声明式图，`agent() / parallel() / pipeline()`；`@nexgent/ptc`：模型写程序调用宿主函数。
2. 四种执行形态由模型按任务选择：直接执行（默认）、委派、团队、工作流 / 代码策略；系统提示只写选择原则，不固定角色与阶段；账本为每轮记录实际形态与成员。
3. 子任务共享资料：委派时传入文件引用与资料目录；成员通过 `present` 返回实际成果，Lead 读取后汇总。
4. 迁移上表资产；删除 `src/`、`tests/`、`benchmarks/*` Python 插件、`scripts/*.py`、`pyproject.toml`、`requirements-*.txt`、`runtime/` subtree；README 只描述一个入口。
5. 把 organization-loop 的 Excel / 订单任务改成原生验收脚本。

验收：同一任务从 Main 分别用四种形态完成并有实际成果；organization-loop 的表格任务在原生路径复现；Python 与 `runtime/` 删除后 CI 绿。

决策与风险：团队形态在 DSH 里仍是 experimental，其邮箱与任务板的持久化语义要以 Nexgent 自己的测试固定；MCP 客户端只在有真实需求时实现。

### 4.4 步骤 4：让能力变化进入真实运行系统

参考实现：`plugin-manager`（Creator 模式安装 bundle、逐次审批）、`skill` 目录发现、`agent-preset-registry`、`settings` 的 profile patch。DSH 没有“版本化能力集 + 门控采用”，这部分完全由 Nexgent 定义。

PR #4 可移植：`architecture-activation.ts`（预留槽位、独占发布、回滚）、`execution-ledger.ts`、`architecture-trials.ts` 的成对执行框架（比较规则要替换）。

要做的工作：
1. `@nexgent/capabilities`：内容寻址的 `CapabilityBundle` 清单，含四类组件——工具（PTC 函数模块或 Nexgent 插件包）、技能（SKILL.md 目录）、上下文策略（说明文件、压缩、系统提示的配置行）、协作方式（预设、团队模板、架构图）。存于 `.nexgent/capabilities/<version>/`；“当前采用版本”沿用激活存储。
2. 加载：kernel 组合时解析采用版本，把技能目录、工具模块、预设与架构默认值注入 profile；新 Session、新进程自动得到同一版本。
3. 任务内开发与试用：模型可在当前会话写 SKILL.md、PTC 函数模块或插件包，以会话作用域试用（Cordis scope 隔离），不影响其他会话；成功使用的组件成为候选。插件包安装仍需人审批（参考 `plugin-manager` 的审批语义）。
4. 门控 `capability_trial`：候选与基线在回放集上各跑 r 次；回放集来自项目历史任务，带宿主可做的确定性检查（文件存在、schema、用户曾运行的测试命令）加审核模型判断；selection 与 guard 不重叠；成本进入接受条件（质量不降且成本下降，或质量上升且成本在上限内）；通过后写入新采用版本，退化回滚。候选不能修改门控配置、权限与预算。
5. 账本扩展：请求记录加上 `capabilityVersion / memberId / executionForm / taskId`，任务结束写 `task-outcome`（检查结果、总成本、每成员成本、实际调用的组件）。

验收：任务 A 开发并使用工具或技能 → 候选 → 门控通过 → 新 OS 进程中的任务 B 自动加载并实际调用（账本可证）→ 人为注入退化后自动回滚；被拒候选保留记录，原版本继续可用。两平台 CI 脚本化 provider 覆盖；真实 MiMo 手动一次。

决策与风险：日常任务多数没有 oracle，审核模型的判断在证据里与确定性检查分开标记；插件包在宿主进程内执行、不受沙箱约束，采用前必须经人审批，技能与 PTC 函数可自动采用。

### 4.5 步骤 5：接入默认的反馈改进流程

参考实现：`feedback`（评分与评语）、`jobs`（后台作业）、`session-query`（读取历史会话）、`experimental/auto-review`（单任务自动复核，可作诊断提示的参考）。

要做的工作（`@nexgent/evolve`）：
1. 触发：用户评分 / 评语、显式“改进”动作、或成果检查失败，进入后台改进作业；默认每累计 N 条反馈运行一次，可改为即时。
2. 诊断：独立会话读取原会话、账本与反馈，输出结构化诊断——失败类型（沿用 MAST 的三类标签）、涉及的成员 / 工具 / 技能、按成员的成本与贡献。
3. 提案：一次只提一个类型化候选（新增或修改技能、工具、上下文策略、协作方式之一），schema 校验，不写自由代码。
4. 比较与采用：`capability_trial` 在回放集（反馈任务 + 若干不同的历史任务）上比较，走步骤 4 的门控。
5. 界面：“改进”视图展示每个候选改了什么、验证结果、费用、是否采用、何时被后续任务使用；失败候选可查看原因。
6. 用户不写评测配置：回放集与检查由宿主从项目历史自动构造；项目级只有“自动改进开 / 关”和预算上限两个设置。

验收：从 Main 提出反馈 → 看到候选 → 看到门控结果 → 下一次任务使用新版本（或看到拒绝原因）；全程不改配置文件。

决策与风险：以项目历史为回放集意味着早期项目样本少，门控在历史不足时等待而不是降低门槛（organization-loop 已有同样规则）。

### 4.6 步骤 6：实现递归改进并检验收益

要做的工作：
1. 改进器也是 `CapabilityBundle`：诊断提示、提案算子集合、比较策略参数；有版本，默认版本为步骤 5 的实现。
2. 元提案：改进器可对自身提出一个类型化变更；新版本必须实际承担下一次改进作业，产生后代候选。
3. 比较：父、子改进器从同一起点（同一项目快照、同一反馈集）各自产生后代，比较后代通过门控的比例、质量与总费用；评价器按纪元冻结，纪元之间才更新。
4. 测量：至少两个任务族（表格 / 数据、多文件代码；OpenFOAM 为可选插件族），`dev / selection / guard / holdout` 不重叠，holdout 只用于报告；每条 ≥3 次重复；费用包含改进本身；报告开发费用能否被后续任务摊薄。
5. 结果如实记录为正、零或负。

验收：一份可复现报告，同时给出能力激活证据、holdout 效果、费用与失败／缺测；没有收益时明确写出。

### 4.7 里程碑

| 步骤 | 估计 | 退出门槛 |
| --- | --- | --- |
| 0 横切（仓库骨架、CI、证据、reference 子模块） | 1 周 | 两平台 CI 绿；`reference-map.md` 建立 |
| 1 主应用（kernel / llm / session / workspace 重写） | 4–6 周 | `accept-step1` 两平台通过；真实 MiMo 一次 |
| 2 日常体验（remote 层 + 精简 Web UI） | 3–4 周 | `accept-step2` 通过；合入 `main` |
| 3 迁移与协作 | 3 周 | 四种形态各完成一次；Python 与 `runtime/` 删除；CI 绿 |
| 4 能力版本 | 3 周 | 跨任务、跨进程实际调用 + 回滚 |
| 5 反馈改进 | 2–3 周 | Main 内闭环，无手写配置 |
| 6 递归与检验 | 3–4 周 | 可复现报告 |

与 fork 方案相比，步骤 1–2 多出约 6–8 周，换来的是 Nexgent 对运行时的完整所有权、仓库体积与可评审性，以及不再受上游 preview 版本变动牵制。周数是范围估计；步骤 4–6 的真实模型实验需要提前约定预算与停止条件。

### 4.8 对 PR #4 的处置

- 分支保留为参考与移植来源，不再提交；关闭 PR，描述指向本计划。
- 移植到 `@nexgent/*` 的文件：`architecture.ts`、`architecture-store.ts`、`tool-restriction.ts`、`architecture-activation.ts`、`execution-ledger.ts`、`architecture-trials.ts` 的执行框架、`cordis.patch.yml` 的默认值、13 个验收脚本的流程设计。
- `runtime/` subtree 不进入新仓库结构；其固定 commit 以 `reference/deepseek-harness` 子模块保留。
- 七份验证摘要迁入 `docs/validation/`，原始 JSONL 移出主干。

### 4.9 仍需拍板

1. 步骤 1 的 Windows 沙箱：先用路径策略、后补 ACL 隔离，还是从一开始就移植 ACL（多 1–2 周）。
2. Web 界面是否从空白 React 工程开始（建议），还是改写 DSH client 包。
3. 步骤 2 后是否以集成分支替换 `main`，并归档现在的 PyQt Harness 产品。
4. 插件包类候选是否允许人审批后自动采用。
5. 改进器与审核使用的模型：仍是 `mimo-v2.6-pro` 关闭 thinking，还是允许开启 thinking 或用更强模型。
6. 步骤 6 的任务族与真实模型预算上限。

## 来源与局限

- 读取了 PR #1–#4 的描述与提交、`main` 与六个远端分支、PR #4 顶端的 `README.md`、`REFACTOR_PLAN.md`、`docs/native-application.md`、`docs/dsh-main.md`、`docs/validation/dsh-main-20261006.md`、`docs/organization-loop.md`、`docs/framework-runtime.md`，以及 `runtime/packages/bundle/nexgent-app`、`tool-workflow`、`workflow-ptc`、`experimental/agent-team`、`goal` 的源码与 README；用 `npm view` 核对了 DSH 与 Cordis 库的发布状态；按包组统计了 DSH 的 TypeScript 源码规模作为重写工作量的依据。
- 没有在本环境构建或运行 DSH（需要 pnpm 11.7、Node 22.19+ 与 Windows 启动器），也没有调用真实模型；对 PR #4 机制的描述来自源码与其自述验证记录。
- 各步骤的周数是基于改动范围的估计，不是承诺；步骤 4–6 涉及真实模型实验，结果可能为零或负，届时按原定规则如实记录，不以降低门槛换取正例。
