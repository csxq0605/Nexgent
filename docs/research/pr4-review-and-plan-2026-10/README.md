# Draft PR #4 评审与 Nexgent 工程实现计划（2026-10-07）

本文回答两个问题：[Draft PR #4](https://github.com/csxq0605/Nexgent/pull/4)（`refactor/dsh-application`）的内容、定位和方向是否正确；在 2026-10-07 给定的产品目标与六步顺序下，结合 PR #2 调研结论、`roadmap/research-agent-next` 和 REFACTOR_PLAN 历史，接下来应该怎样做工程。全部判断基于 2026-10-07 的分支顶端 `fd0b2f4`，没有运行真实模型。

## 一页结论

1. **方向对了，形态还是偏。** PR #4 终于采纳了 PR #2 的核心建议——以 DeepSeek Harness（DSH）为执行底座，把可进化对象从 15KB 私有 DSL 换成小而规整的配置（节点 = 角色 + 提示 + 依赖 + 模型 + schema + 人设 + 工具掩码）。证据纪律也保持得很好：未知结果不算成功、不宣称 RSI 收益。
2. **拥有 DSH 源码是既定决策，但目前的 fork 没有章法。** 2,377,015 行新增里 13,321 个文件是 DSH 源码的 subtree 快照，Nexgent 自己的 TypeScript 只有约 1,500 行（含测试），分散在上游包里；没有记录上游版本与同步流程。DSH 处于 developer preview，上游 npm 已到 0.2.0-rc.2，仓库固定在 0.1.7-rc.1。要让 fork 可持续，Nexgent 代码必须集中在自己的分组，对上游包的修改最小化并登记，并有定期同步（见 4.0）。
3. **“组织”这一层仍然没有出现。** 可进化对象是静态 DAG；没有花名册、邮箱、任务板、沟通规则、决策权，也没有按成员归因和成本账。DSH 自带的 `experimental/agent-team`（持久邮箱 + 共享任务板）在 Nexgent profile 里没有启用。
4. **采用门是回归夹具，不是任务质量门。** `architecture_trial / adopt / run` 只支持“全局工具为空、输出型图、宿主写死的输入与期望 JSON、精确相等”；selection 只比通过数，没有成本项、没有重复、没有留出集；候选还得由模型或人手工提交，普通反馈→候选的生成器未实现。这与 PR #2 前沿①⑥⑦的要求（等预算、重复、held-out、成本总账）距离很远。
5. **顺序颠倒。** PR #2 建议的阶段 1 退出门槛是“自建执行层代码明显减少”，阶段 2 是“先找到团队确实优于单智能体的任务家族”。PR #4 跳过了这两步，直接把阶段 3 的采用／激活／回滚管道做了第三遍（Python P3 控制面、组织服务门控、DSH 内核 Python 门控、现在的 TS 版），而 45,288 行 Python 宿主仍原样留在仓库里。
6. **可运行性差。** 只有 Windows 启动器，Windows ACL 是唯一验证过的沙箱；根目录 CI 仅手动触发且只跑 Python，TypeScript 运行时在本仓库没有任何 CI；PR #4 没有一次检查运行。
7. **建议：** 以 PR #4 分支为集成分支，但先做横切整理（两平台 CI、证据卫生、Nexgent 代码集中、上游登记），再按给定的六步推进；Python 宿主在步骤 3 删除。第 4 节按六步给出每步 DSH 已提供什么、PR #4 已做到什么、要做的工作、验收与风险。

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

1. **Fork 没有管理成本的措施。** Nexgent 对上游包的实际改动只有几百行，且全部是“给 workflow 节点加几个字段”这类可以上游化的变化；而代价已经出现：PR 无法评审（13,405 个文件）、`pnpm-lock.yaml` 与上游分叉、上游 0.1.7-rc.1 → 0.2.0-rc.2 的变化需要人工合并、没有上游版本登记与同步流程。既然决定拥有源码，就要把 Nexgent 代码集中、把上游改动最小化并登记、把可通用的改动提回上游，否则每次同步都是一次重做。
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
- 需要纠正的部分：无章法的 fork → 有登记、有同步、改动集中的 fork；DAG → 四种执行形态与可版本化的协作方式（成员 + 通信 + 规则 + 技能）；夹具门 → 回放集、重复、留出、成本的评价协议；先机制 → 先把日常任务体验接通；Windows-only → 两平台 CI；五代入口并存 → 一个入口。
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

## 4. 工程实现计划（按六步）

目标与顺序以 2026-10-07 的产品定义为准：以 DSH 源码为基础、使用并改造其 Cordis 运行架构，做成能完成真实任务、持续积累能力并改进自身的 Nexgent 独立应用；用户面对项目、对话、资料和成果；默认模型 `mimo-v2.6-pro`。订单、Excel、科研、OpenFOAM 是应用案例，benchmark 只用于测量。下面每一步给出：DSH 已提供什么、PR #4 已做到什么、要做的工作、验收、决策与风险。

### 4.0 横切安排

**分支与合并。** 以 `refactor/dsh-application` 顶端为新应用的集成分支（保留 PR #4 历史），后续每一步以小 PR 合入该分支；步骤 2 验收通过后把它合入 `main`，旧的 PyQt 科研 Harness 产品归档为 `archive/harness-gui`。PR #1、organization-loop、PR #3 的 Python 宿主在步骤 3 删除时归档为 `archive/python-host`。

**有章法地拥有 DSH 源码。** 这是既定决策，要管理的是成本：
- `runtime/UPSTREAM.md` 记录上游 commit（`46a7f68b`，0.1.7-rc.1）与每次同步；上游 npm 已到 0.2.0-rc.2，建议在步骤 2 完成后做第一次 `git subtree pull` 合并，之后按季度同步。
- Nexgent 自己的包放在新分组 `runtime/packages/nexgent/`（app、capabilities、evolve、ui-nexgent 等），不散落在上游包里；对上游包的直接修改保持最小并列在 `runtime/NEXGENT_CHANGES.md`，其中通用的部分（`architecture` 节点字段、`tool-restriction`）向上游提 PR。
- 不改上游的构建、lint 与 vitest 配置，让上游测试继续可跑。

**CI 先于新机制。** 根目录 GitHub Actions 改为 push / pull_request 触发：Linux job 跑 `pnpm install --frozen-lockfile`、`pnpm run build:lib:host`、Nexgent 分组与被改动上游包的 vitest，以及步骤 1–2 的脚本化 provider 验收脚本；Windows job 跑同样内容外加 ACL 沙箱与 PowerShell 启动器；真实模型验收保留手动 workflow。Python 的 CI 在步骤 3 删除。

**证据卫生。** `docs/validation/` 只保留摘要 JSON 与 SHA-256 manifest，原始 JSONL 移到 Release 附件或独立仓库；每步一份验收记录，不再每个提交一份。

**平台。** 从步骤 1 验收起 Linux 与 Windows 同时通过；沙箱在 Linux 用 `sandbox-local` / `fs-sandbox`，Windows 用 `sandbox-windows-acl`。

### 4.1 步骤 1：建立基于 DSH 的 Nexgent 主应用

DSH 已提供：`app-boot` 的 profile 组合、`agent-loop`、`session-persistence-jsonl` + checkpoint、`fs` / `shell` / `sandbox`、`subagent`、`llm-pi-ai` 的 OpenAI 兼容路由、`credentials-local`、Web / headless / desktop 三个 bundle。

PR #4 已做到：`@nexgent/application` bundle（MiMo 默认、禁用 DeepSeek 账户、品牌、系统提示）、`start.ps1` / `run.ps1`、原生 Session 保存与新进程续聊、真实 MiMo 文件交付。主循环已不经过 Python。

要做的工作：
1. 入口：新增 `runtime/apps/nexgent`（或在 `apps/cli` 加 `nexgent` bin），命令 `nexgent web --project <dir>`、`nexgent run --project <dir> --task "..."`、`nexgent resume <session>`；三者只是同一 Loader 的不同 bundle 选择。PowerShell 启动器改为调用这个 bin，Linux / macOS 用同一 bin。
2. 把 `@nexgent/application` 迁到 `runtime/packages/nexgent/app`，profile 中与产品无关的上游行（账户、遥测、DeepSeek 品牌）集中禁用。
3. 项目数据目录从 `.nexgent/native/` 简化为 `.nexgent/`，内含 `sessions/ materials/ outputs/ capabilities/ ledgers/`。
4. 模型路由保留 thinking 关闭与 `maxRetries: 0`；在 UI 上提供用户可见的“重试本轮”动作，账本仍记录每次请求。
5. 验收脚本 `scripts/accept-step1.mjs`：脚本化 provider 下启动 → 完成一次写文件任务 → 杀进程 → 新进程 `resume` 续聊；在 Linux 与 Windows CI 各跑一次。真实 MiMo 手动各跑一次并留摘要。

验收：通过 Nexgent 入口启动，完成真实任务并保存原生会话，不依赖旧 Python `TaskService`；两种操作系统都通过。

决策与风险：Windows ACL 的 WRITE_OWNER 前提让 Modify-only 目录不可用，产品层要在选择项目目录时检测并提示，而不是在工具调用时失败。

### 4.2 步骤 2：接通完整的日常任务体验

DSH 已提供：`workspace`（工作目录）、`attachment`（**仅图片**）、`context/file-reference`（`@文件` 引用）、`skill-office` 与 `document/office-to-pdf`（Word / Excel / PPT）、`deliverables`（`present` 工具 + 每轮文件变更记录 + `ui-deliverables`）、`feedback`（会话评语与逐条评分，不进模型）、`goal`（跨轮、跨重启的持久目标）、`jobs`（后台工作）、`schedule`、`plan-mode`、`compaction`、`session-checkpoint-policy`、`sdk`（server / client / protocol）。

PR #4 已做到：浏览器 Main 与 headless 会话互通尚未验证；没有资料管理、成果展示与反馈修改的产品流程。

要做的工作：
1. 项目模型：项目 = 工作目录 + `.nexgent/`；Web 侧新增 `ui-nexgent-project`（最近项目、新建、切换）。
2. 资料：“添加资料”把文件复制到 `.nexgent/materials/<id>/` 并以 file-reference 注入对话；非图片附件走工作区文件而不是 `attachment` 包；Office 文件经 `skill-office` 读取。
3. 成果：系统提示要求最终交付必须通过 `present` 声明；`ui-deliverables` 展示文件与每轮变更；`outputs/` 保存每轮快照，供反馈修改时对比。
4. 反馈修改：用户对某个成果提出修改即新的一轮；同时用 `message-feedback` 记录评分与评语，并关联到成果版本（步骤 5 的输入）。
5. 停止与继续：取消当前轮保留已流出文本；跨重启用 `goal` 持久化目标 + session resume；验收包含轮中 `kill -9` 后恢复。
6. CLI 与 SDK：`nexgent run` 使用 headless bundle；SDK 直接暴露 DSH `sdk` server / client 协议，Python SDK 只是其客户端。

验收脚本 `scripts/accept-step2.mjs`：提交资料 → 执行 → 成果文件存在且被 `present` → 提出修改 → 成果更新 → 杀进程 → 重启继续 → 会话历史、资料、成果全部可见；CI 脚本化 provider 两平台通过，真实 MiMo 手动一次。

决策与风险：DSH 上游的 session 格式还在演进（v0→v4 迁移包都在），升级上游时必须跑迁移测试；`attachment` 不支持文档类附件，所以资料流程不能建立在它上面。

### 4.3 步骤 3：迁移已有能力，补齐灵活协作

DSH 已提供：`subagent`（fresh / fork、Claude Code / Codex / ACP provider）、`experimental/agent-team` + `tool-agent-team`（具名队友、持久邮箱、共享任务板，九个工具）、`tool-workflow`（图 / 脚本）、`ptc-runtime`（模型写程序调用宿主函数，TS 与 Python 后端）、`preset/agent-preset(-registry)` + `persona`、`skill-filesystem`（SKILL.md 目录）、`web`、`browser-use`。

Python 资产迁移表：

| Python 资产 | 去向 |
| --- | --- |
| `organization_spreadsheets.py`（读 / 查询 / 写带公式的 xlsx） | `runtime/packages/nexgent/tool-spreadsheet`（TS，SheetJS 或 exceljs），查询用 PTC 函数；读取优先用 `skill-office` |
| `run_python` 受限计算 | `ptc-runtime` TS 后端；需要 CPython 时用其 Python 后端 |
| 公开网页读取 | DSH `web` 组 |
| `.nexgent/skills/*.md`、技能编译器 | `skill-filesystem` 的 SKILL.md 目录，不再编译成 Python 子包 |
| 组织角色与规则、成员目录 | `agent-preset-registry` 中的预设 + 团队模板（JSON） |
| `tasks/` 的 evolution / generation / guards / feedback_trigger / studies | 作为步骤 4–6 的设计依据重写为 TS；不迁移代码 |
| benchmarks（workbench、bbh、scientific_discovery、openfoam） | 任务数据与评分器保留为 `runtime/benchmarks/nexgent/*` 夹具；Python 插件删除 |

要做的工作：
1. 启用四种执行形态：直接执行（默认）；`subagent` 委派；`agent-team`（Lead + 具名队友）；`workflow`（图 / 脚本）与 PTC 代码策略。系统提示只写选择原则，不固定角色与阶段；账本为每轮记录实际采用的形态与成员。
2. 子任务共享资料：委派时传入 file-reference 与资料目录；成员通过 `present` 返回实际成果，Lead 读取后汇总。
3. 迁移上表资产并删除 `src/`、`tests/`、`benchmarks/*` Python 插件、`scripts/*.py`、`pyproject.toml`、`requirements-*.txt`、`run.ps1` 旧逻辑；README 只描述一个入口。
4. 把 organization-loop 的 Excel / 订单任务改成原生验收脚本。

验收：同一任务从 Main 分别用四种形态完成并有实际成果；organization-loop 的表格任务在原生路径复现；Python 代码删除后 CI 绿。

决策与风险：`agent-team` 是 experimental 包，没有稳定承诺；采用后要在 `NEXGENT_CHANGES.md` 记录依赖并在上游同步时重点回归。

### 4.4 步骤 4：让能力变化进入真实运行系统

DSH 已提供：`plugin-manager`（Creator 模式 `install_bundle`，每次需审批，profile 级生效）、`skill` 目录发现、`agent-preset-registry`、`settings` 的 profile patch、`tool-workflow` 的 `architectureVersion`。DSH 没有“版本化能力集 + 门控采用”。

PR #4 已做到：架构定义存储与 `architectureVersion` 复用；输出型成对试用；激活记录（预留槽位、独占发布、回滚）；旁路请求账本。

要做的工作：
1. 能力版本 `CapabilityBundle`（`runtime/packages/nexgent/capabilities`）：内容寻址的清单，包含四类组件——工具（插件 bundle 或 PTC 函数模块）、技能（SKILL.md 目录）、上下文策略（`agent-instructions` / `compaction` / `system-prompt` 的 profile 行）、协作方式（预设、团队模板、架构图）。存于 `.nexgent/capabilities/<version>/`；“当前采用版本”沿用 PR #4 的激活存储。
2. 加载：Nexgent profile 层在组合时解析采用版本，把技能目录、插件 bundle、预设与架构默认值注入 profile；新 Session、新进程自动得到同一版本。
3. 任务内开发与试用：模型可在当前会话写 SKILL.md、PTC 函数模块或插件 bundle，并以“任务局部”作用域试用（`scope` 隔离），不影响其他会话；成功使用的组件成为候选。
4. 门控：把 `architecture_trial` 推广为 `capability_trial`——候选与基线在回放集上各跑 r 次，回放集来自项目历史任务（带宿主可做的确定性检查：文件存在、schema、用户曾运行的测试命令）加审核模型判断；selection 与 guard 不重叠；成本进入接受条件（质量不降且成本下降，或质量上升且成本在上限内）；通过后写入新采用版本，退化回滚。候选不能修改门控配置、权限与预算。
5. 账本扩展：请求记录加上 `capabilityVersion / memberId / executionForm / taskId`，任务结束写 `task-outcome`（检查结果、总成本、每成员成本、哪些组件被实际调用）。

验收：任务 A 开发并使用工具或技能 → 成为候选 → 门控通过 → 新 OS 进程中的任务 B 自动加载并实际调用（账本可证）→ 人为注入退化后自动回滚；被拒候选保留记录，原版本继续可用。两平台 CI 用脚本化 provider 覆盖；真实 MiMo 手动一次。

决策与风险：日常任务多数没有 oracle，审核模型的判断要在证据里与确定性检查分开标记；插件 bundle 在宿主进程内执行、不受沙箱约束，采用前必须经人审批，技能与 PTC 函数可以自动采用。

### 4.5 步骤 5：接入默认的反馈改进流程

DSH 已提供：`feedback`（评分与评语）、`jobs`（后台作业）、`session-query`（读取历史会话）。

要做的工作（`runtime/packages/nexgent/evolve`）：
1. 触发：用户评分 / 评语、显式“改进”动作、或成果检查失败，进入改进作业队列（`jobs`），默认每累计 N 条反馈运行一次，可改为即时。
2. 诊断：独立会话读取原会话、账本与反馈，输出结构化诊断——失败类型（沿用 MAST 的三类标签）、涉及的成员 / 工具 / 技能、按成员的成本与贡献。
3. 提案：一次只提一个类型化候选（新增或修改技能、工具、上下文策略、协作方式之一），由 schema 校验，不写自由代码。
4. 比较与采用：`capability_trial` 在回放集（反馈任务 + 若干不同的历史任务）上比较，走步骤 4 的门控。
5. 界面：`ui-nexgent-improve` 页展示每个候选改了什么、验证结果、费用、是否采用、何时被后续任务使用；失败候选可查看原因。
6. 用户不写评测配置：回放集与检查由宿主从项目历史自动构造；项目级只有“自动改进开 / 关”和预算上限两个设置。

验收：从 Main 提出反馈 → 看到候选 → 看到门控结果 → 下一次任务使用新版本（或看到拒绝原因）；全程不改配置文件。

决策与风险：以项目历史为回放集意味着早期项目样本很少，门控应在历史不足时等待而不是降低门槛（organization-loop 已有同样规则）。

### 4.6 步骤 6：实现递归改进并检验收益

要做的工作：
1. 改进器也是 `CapabilityBundle`：诊断提示、提案算子集合、比较策略参数；有版本，默认版本为步骤 5 的实现。
2. 元提案：改进器可以对自身提出一个类型化变更；新版本必须实际承担下一次改进作业，产生后代候选。
3. 比较：父、子改进器从同一起点（同一项目快照、同一反馈集）各自产生后代，比较后代通过门控的比例、质量与总费用；评价器按纪元冻结，纪元之间才更新。
4. 测量：至少两个任务族（表格 / 数据、多文件代码；OpenFOAM 为可选插件族），`dev / selection / guard / holdout` 不重叠，holdout 只用于报告；每条 ≥3 次重复；费用包含改进本身；报告开发费用能否被后续任务摊薄。
5. 结果如实记录为正、零或负。

验收：一份可复现报告，同时给出能力激活证据、holdout 效果、费用与失败／缺测；没有收益时明确写出。

### 4.7 里程碑

| 步骤 | 估计 | 退出门槛 |
| --- | --- | --- |
| 0 横切（CI、证据、分支） | 1 周 | 两平台 CI 绿；主干无原始 JSONL |
| 1 主应用 | 1 周 | `accept-step1` 两平台通过；真实 MiMo 一次 |
| 2 日常体验 | 2–3 周 | `accept-step2` 通过；合入 `main` |
| 3 迁移与协作 | 2–3 周 | 四种形态各完成一次；Python 删除；CI 绿 |
| 4 能力版本 | 3 周 | 跨任务、跨进程实际调用 + 回滚 |
| 5 反馈改进 | 2–3 周 | Main 内闭环，无手写配置 |
| 6 递归与检验 | 3–4 周 | 可复现报告 |

周数是范围估计；步骤 4–6 的真实模型实验需要提前约定预算与停止条件。

### 4.8 对 PR #4 的处置

- 保留分支作为集成分支，不再直接往上叠加功能提交；本文件与横切改动作为第一个小 PR 合入。
- 下一次提交前先做 4.0 的 CI 与证据卫生，否则后续每一步都无法复现。
- `architecture_trial / adopt / run` 保留为步骤 4 `capability_trial` 的特例与单元夹具；激活存储、账本直接复用。
- PR #4 描述里的验证数字改为引用各步验收记录，不再在描述中罗列。

### 4.9 仍需拍板

1. 步骤 2 后是否以集成分支替换 `main`，并归档现在的 PyQt Harness 产品。
2. 插件 bundle 类候选是否允许在人审批后自动采用，还是永远需要逐次审批。
3. 改进器与审核使用的模型：仍是 `mimo-v2.6-pro` 关闭 thinking，还是允许开启 thinking 或用更强模型。
4. 步骤 6 的任务族与真实模型预算上限。
5. 上游同步节奏（建议步骤 2 后一次、之后按季度）。

## 来源与局限

- 读取了 PR #1–#4 的描述与提交、`main` 与六个远端分支、PR #4 顶端的 `README.md`、`REFACTOR_PLAN.md`、`docs/native-application.md`、`docs/dsh-main.md`、`docs/validation/dsh-main-20261006.md`、`docs/organization-loop.md`、`docs/framework-runtime.md`，以及 `runtime/packages/bundle/nexgent-app`、`tool-workflow`、`workflow-ptc`、`experimental/agent-team`、`goal` 的源码与 README；用 `npm view` 核对了 DSH 包的发布状态。
- 没有在本环境构建或运行 DSH（需要 pnpm 11.7、Node 22.19+ 与 Windows 启动器），也没有调用真实模型；对 PR #4 机制的描述来自源码与其自述验证记录。
- 各步骤的周数是基于改动范围的估计，不是承诺；步骤 4–6 涉及真实模型实验，结果可能为零或负，届时按原定规则如实记录，不以降低门槛换取正例。
