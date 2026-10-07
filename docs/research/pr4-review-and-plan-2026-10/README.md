# Draft PR #4 评审与 Nexgent 工程实现计划（2026-10-07）

本文回答两个问题：[Draft PR #4](https://github.com/csxq0605/Nexgent/pull/4)（`refactor/dsh-application`）的内容、定位和方向是否正确；在 PR #2 调研结论、`roadmap/research-agent-next` 和 REFACTOR_PLAN 历史的基础上，接下来应该怎样做工程。全部判断基于 2026-10-07 的分支顶端 `fd0b2f4`，没有运行真实模型。

## 一页结论

1. **方向对了，形态还是偏。** PR #4 终于采纳了 PR #2 的核心建议——以 DeepSeek Harness（DSH）为执行底座，把可进化对象从 15KB 私有 DSL 换成小而规整的配置（节点 = 角色 + 提示 + 依赖 + 模型 + schema + 人设 + 工具掩码）。证据纪律也保持得很好：未知结果不算成功、不宣称 RSI 收益。
2. **但它把“复用底座”做成了“整体 fork 底座”。** 2,377,015 行新增里 13,321 个文件是 DSH 源码的 subtree 快照，Nexgent 自己的 TypeScript 只有约 1,500 行（含测试）。DSH 处于 developer preview，上游 npm 已到 0.2.0-rc.2，仓库里固定在 0.1.7-rc.1；fork 的同步成本会持续吞掉开发时间。DSH 的每个包都在 npm 公开发布，而 PR #4 自己写的 `@nexgent/application` 恰好就是一个 bundle 插件——这说明不 fork 也能做。
3. **“组织”这一层仍然没有出现。** 可进化对象是静态 DAG；没有花名册、邮箱、任务板、沟通规则、决策权，也没有按成员归因和成本账。DSH 自带的 `experimental/agent-team`（持久邮箱 + 共享任务板）在 Nexgent profile 里没有启用。
4. **采用门是回归夹具，不是任务质量门。** `architecture_trial / adopt / run` 只支持“全局工具为空、输出型图、宿主写死的输入与期望 JSON、精确相等”；selection 只比通过数，没有成本项、没有重复、没有留出集；候选还得由模型或人手工提交，普通反馈→候选的生成器未实现。这与 PR #2 前沿①⑥⑦的要求（等预算、重复、held-out、成本总账）距离很远。
5. **顺序颠倒。** PR #2 建议的阶段 1 退出门槛是“自建执行层代码明显减少”，阶段 2 是“先找到团队确实优于单智能体的任务家族”。PR #4 跳过了这两步，直接把阶段 3 的采用／激活／回滚管道做了第三遍（Python P3 控制面、组织服务门控、DSH 内核 Python 门控、现在的 TS 版），而 45,288 行 Python 宿主仍原样留在仓库里。
6. **可运行性差。** 只有 Windows 启动器，Windows ACL 是唯一验证过的沙箱；根目录 CI 仅手动触发且只跑 Python，TypeScript 运行时在本仓库没有任何 CI；PR #4 没有一次检查运行。
7. **建议：** 不要在 PR #4 上继续叠加。把它拆成四块（可上游的 tool-workflow 改动、应用 bundle、文档、证据），把 DSH 改为锁定版本的依赖，退役 Python 宿主，先在 Linux CI 上跑通，然后按“基线 → 组织层 → 进化门”的顺序推进。详细计划见第 4 节。

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

1. **Fork 代价与收益不成比例。** Nexgent 对上游包的实际改动只有几百行，且全部是“给 workflow 节点加几个字段”这类可以上游化或以独立包实现的变化；而代价是：PR 无法评审（13,405 个文件）、`pnpm-lock.yaml` 与上游分叉、上游 0.1.7-rc.1 → 0.2.0-rc.2 的变化需要人工合并、`.agents/`、`snapshots/`、`website/` 等与 Nexgent 无关的内容进入主干。DSH 自己的宣传语是 "everything is a plugin"，Nexgent 应当是插件集合而不是 fork。
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
- 需要纠正的部分：fork → 依赖；DAG → 组织（成员 + 通信 + 规则 + SOP）；夹具门 → 等预算、重复、留出、成本的评价协议；先机制 → 先基线；Windows-only → Linux CI 优先；五代入口并存 → 一个入口。
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

## 4. 工程实现计划

### 4.1 原则

1. **Nexgent 是 DSH 之上的插件集合，不是 DSH 的 fork。** 上游以锁定版本作为依赖；需要改上游的地方先尝试提 PR，暂时用 `pnpm patch` 或独立包覆盖。
2. **只有一个运行时。** TypeScript / DSH 是唯一执行路径；Python 宿主整体移到归档分支，`main` 不再携带。
3. **先能跑，再能学。** Linux CI 必须先于任何新机制；每个阶段的 PR 要能在 CI 里用脚本化 provider 复现其机制声明。
4. **先基线，再进化。** 没有“某个任务家族上组织优于单智能体”的等预算证据，就不写进化算子。
5. **门控三要素：留出、重复、成本。** 任何采用决定都要给出 selection / guard / holdout 三个不重叠划分上的均值与方差，以及完整成本账；夹具式精确匹配只作单元测试。
6. **PR 可评审。** 单个 PR 不超过一次评审能读完的量；原始 JSONL 收据不进主干。

### 4.2 阶段 0：止血与仓库重整（约 1 周）

目标：让仓库有一个清晰的主干、一个入口、一条 CI。

- 新建分支 `next/organization-layer`（从 `main` 起，而不是从 PR #4 顶端）。
- 仓库结构：

  ```text
  package.json / pnpm-workspace.yaml     Nexgent 自己的 workspace
  packages/app/                          原 @nexgent/application（profile、ledger、activation）
  packages/org-schema/                   组织表示与版本（阶段 1）
  packages/org-runtime/                  组织 → DSH 执行形态编译（阶段 1）
  packages/eval/                         任务家族、划分、评分器、等预算运行器（阶段 2）
  packages/evolve/                       归因、变更算子、门控（阶段 3）
  apps/cli/                              nexgent 命令：run / bench / evolve / show
  docs/                                  只保留当前产品文档、ADR、各阶段报告与证据索引
  archive/ (git 分支 archive/python-host)  PR #1 / organization-loop / PR #3 的 Python 宿主
  ```

- DSH 依赖方式：首选 npm 锁定版本（`@deepseek-ai/dsh-*` 均以 `access: public` 发布；需要核对各包版本是否与 CLI 同步，当前 `dsh-tool-workflow` 在 npm 上还是 0.0.1-rc.1，与 CLI 的 0.2.0-rc.2 不一致）。若包版本不同步，退而用 git submodule 锁定 commit + pnpm workspace link。两种方式都不把源码进主干。
- 把 PR #4 对 `tool-workflow`（`architecture.ts`、`architecture-store.ts`）、`core/tools`（`tool-restriction.ts`）、`workflow-ptc`（persona / toolFilter 透传）的改动整理成一个上游 PR；在上游接受前，以 Nexgent 自己的 `@nexgent/tool-architecture` 包实现同样功能（它只依赖 `dsh-tool-workflow` 的 `agent()` 合同）。
- 证据：`docs/validation/*.json` 摘要保留，原始 JSONL 目录移到 GitHub Release 附件或独立仓库，主干只留 SHA-256 manifest。
- CI（GitHub Actions，push 与 pull_request 触发）：Linux 上 `pnpm install --frozen-lockfile`、`pnpm build`、`pnpm test`（vitest，脚本化 provider）；Windows 作为第二条 job，允许失败但要报告。真实模型验证保留为手动 workflow。
- PR 处理：PR #2 合并（纯文档）；PR #1、PR #3 关闭并在描述里指向 `archive/python-host`；PR #4 关闭，描述指向本计划与拆分后的小 PR。
- 入口：删除 README 中 0.8 / 0.9 / 组织 demo / DSH 内核 Python 的五代说明，只描述 `nexgent` 一个入口。

退出门槛：Linux CI 绿；主干无 `runtime/` 源码与 Python 宿主；`nexgent run "任务"` 在 Linux 与 Windows 都能启动 DSH Web Main 并完成一次文件交付（脚本化 provider 在 CI，真实 MiMo 手动）。

### 4.3 阶段 1：组织表示与三种执行形态（约 2 周）

目标：同一个任务可以用直接执行、架构图、具名团队三种形态运行，并产出同一格式的账本。

- `@nexgent/org-schema`：组织定义

  ```jsonc
  {
    "format": 1,
    "members": [ { "id": "impl", "role": "...", "model": "...", "tools": {"allow": [...]} , "persona": "...", "skills": ["..."] } ],
    "structure": { "kind": "direct" | "graph" | "team", "edges": [["impl","review"]] },
    "communication": { "channel": "outputs" | "mailbox", "reviewRequired": ["review"], "escalation": "lead" },
    "rules": [ "每个交付必须附带可执行验证命令", "..." ],
    "budget": { "maxCalls": 40, "maxTokens": 400000 }
  }
  ```

  版本 = 规范化 JSON 的 SHA-256（沿用 PR #4 做法）。`members` 沿用 `architecture` 节点字段；新增的只有 `structure.kind`、`communication`、`rules`、`skills`。字段保持最少，所有字段模型可填。
- `@nexgent/org-runtime`：三种编译目标
  - `direct`：单智能体，基线臂；
  - `graph`：复用 `architecture` 编译器（PR #4 代码）；
  - `team`：启用 DSH `experimental/agent-team` + `tool-agent-team`，Lead 由 `communication.escalation` 指定，`rules` 进入成员 persona 后缀，`reviewRequired` 编译成任务板上的强制审查任务。
- `@nexgent/app` 账本扩展：每条请求记录加上 `orgVersion / memberId / taskId / attempt`；任务结束时写一条 `task-outcome` 记录（评分器结果、总成本、每成员成本、每成员输出是否进入最终交付）。这是阶段 3 归因的数据基础。
- `nexgent run --org <version|file> --form direct|graph|team`。

退出门槛：CI 里一个脚本化任务用三种形态各跑一次，产出三份结构一致的账本；真实 MiMo 手动各跑一次并保留记录。

### 4.4 阶段 2：基线与评价协议（约 2–3 周）

目标：回答“在哪些任务上、哪种组织、以多少成本，确实比单智能体好”。没有这一步，阶段 3 没有优化目标。

- 任务家族（先 2 个，可并行、可验证、有确定性评分器）：
  - A. 多文件代码任务：自建 40–60 题（或 SWE-bench Verified 的小子集），隐藏测试作为评分器；
  - B. 表格 / 数据任务：把 organization-loop 的 Excel / CSV 资产改成有 oracle 的题目，复用 PR #3 的订单核算题；
  - C. 可选：OpenFOAM smoke 作为插件型任务，不进入门控统计。
- 划分：每个家族 `dev / selection / guard / holdout` 四份不重叠，holdout 只在阶段报告里使用，不参与任何采用决定。
- `@nexgent/eval`：`nexgent bench run --family A --split selection --org v --repeats 3 --budget ...`，每次在新进程执行，输出成功率、评分、总成本、每成员成本的均值与置信区间。等预算规则：同样的调用上限与 token 上限，超限按失败计。
- 基线臂：direct 单智能体；固定 graph（实现 + 复核）；固定 team（Lead + 2 成员）。执行模型 `mimo-v2.6-pro`（thinking 关）；改进模型待定，建议比执行模型强或至少开启 thinking。
- 报告格式固定：每家族一张表，行为组织形态，列为成功率 ± CI、成本、成本/成功。

退出门槛：至少一个家族里某种组织形态在等预算下显著优于 direct（≥3 次重复）。如果都没有，换任务家族，不加机制。

### 4.5 阶段 3：组织进化层 v1（约 3–4 周）

目标：从任务反馈自动产生组织变更候选，用留出 + 成本门决定采纳，并在新进程自动复用。

- 归因（`@nexgent/evolve/attribution`）：从账本按成员汇总成本、输出被采用率、失败模式标签（用 MAST 的三类十四种作为标签集）；第一版用简单的“去掉该成员后的边际”估计，Shapley 留到 v2。
- 变更算子（配置空间，四种，对应文献做法）：
  1. 增员：附带入职——新成员先在 `dev` 的 k 个任务上试跑，通过才进 selection；
  2. 减员 / 降级模型：基线锚定接受，质量不降且成本降才接受；
  3. 改角色 / 人设 / 工具掩码；
  4. 改规则 / 通信（`rules`、`reviewRequired`、`channel`）。
  改进器是一个独立的 DSH 会话，输入是基线组织 + 归因表 + 失败样例 + 用户反馈，输出是**一个**结构化变更（schema 校验），不写代码。
- 门控（替换 PR #4 的精确匹配夹具）：
  - selection：候选与基线在 `selection` 划分上各跑 r 次，接受条件为“质量不低于基线 且 成本 ≤ 基线 × (1 − δ)”或“质量显著高 且 成本 ≤ 基线 × (1 + ε)”；
  - guard：`guard` 划分上候选不退步；
  - holdout：只记录，不用于决定；
  - 采用后沿用 PR #4 的激活存储、尝试槽位、独占发布、执行失败回滚；
  - 评价器按“纪元”冻结，改进器不能修改评分器与划分。
- 触发：任务结束后若 `task-outcome` 为失败或用户给出反馈，进入候选队列；批量（每 N 个任务）而不是每任务触发。
- 信息窗口：在 DSH Web UI 上以客户端插件增加“组织”页：当前版本、成员归因、候选与门控结果、成本曲线。

退出门槛：在至少一个家族的 `holdout` 上，进化后的组织等预算优于阶段 2 的最好基线，≥3 次重复；每次采用都能追溯到账本证据；至少一次自动回滚被触发并验证。

### 4.6 阶段 4：跨任务资产与换模型重学（约 3 周）

- 角色与 SOP 以 DSH Skills 格式沉淀（不自造格式）；账本记录 Skill 是否被读取与引用，验证“被用上”。
- 组织版本绑定执行模型身份；更换模型时自动把当前版本降为候选，重跑 selection，比较“沿用”与“重学”。
- 候选来自档案（保留被拒候选与原因），不再是 N=1。

退出门槛：资产在新任务 / 新模型上有正迁移；换模型后重学优于直接沿用（或明确报告无差异）。

### 4.7 阶段 5：递归（视阶段 3 结果而定）

改进器自身的提示、归因方法、接受规则纳入版本；评价器按纪元更新；只有阶段 3 为正才启动。

### 4.8 对 PR #4 的直接处置

如果希望保留 PR #4 的工作成果，建议按下面拆分而不是继续在该分支提交：

| 拆出的 PR | 内容 | 去向 |
| --- | --- | --- |
| 上游 PR | `architecture.ts`、`architecture-store.ts`、`tool-restriction.ts`、`workflow-ptc` persona/toolFilter | `deepseek-ai/deepseek-harness` |
| `feat: nexgent app bundle` | `cordis.patch.yml`、`execution-ledger.ts`、`architecture-activation.ts` | `packages/app/`，约 400 行 + 测试 |
| `test: output-only trial fixtures` | `architecture-trials.ts` 的试用部分 | 降级为 `packages/eval/` 的单元级夹具 |
| `docs: native application evidence` | 七份验证 JSON 摘要 + manifest | `docs/validation/`，原始 JSONL 移出主干 |

`runtime/` subtree 与 Python 宿主不进入任何新 PR。

### 4.9 需要拍板的事项

1. DSH 以 npm 锁定版本还是 git submodule 作为依赖（取决于 npm 包版本是否同步，阶段 0 第一天核实）。
2. Python 宿主是否可以整体归档（PR #1、organization-loop、PR #3 的代码不再维护）。
3. 执行模型与改进模型：是否接受改进器使用更强模型或开启 thinking；阶段 2 的真实预算上限。
4. 任务家族 A 的来源：自建题目还是公开基准子集。
5. Linux 优先、Windows 第二的平台顺序。

## 来源与局限

- 读取了 PR #1–#4 的描述与提交、`main` 与六个远端分支、PR #4 顶端的 `README.md`、`REFACTOR_PLAN.md`、`docs/native-application.md`、`docs/dsh-main.md`、`docs/validation/dsh-main-20261006.md`、`docs/organization-loop.md`、`docs/framework-runtime.md`，以及 `runtime/packages/bundle/nexgent-app`、`tool-workflow`、`workflow-ptc`、`experimental/agent-team`、`goal` 的源码与 README；用 `npm view` 核对了 DSH 包的发布状态。
- 没有在本环境构建或运行 DSH（需要 pnpm 11.7、Node 22.19+ 与 Windows 启动器），也没有调用真实模型；对 PR #4 机制的描述来自源码与其自述验证记录。
- 各阶段的周数是基于改动范围的估计，不是承诺；阶段 2 的结论可能是“没有任务家族上团队优于单智能体”，那时计划会在阶段 2 停下重新选题。
