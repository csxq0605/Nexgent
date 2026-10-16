# Nexgent 文档索引

本目录是 Nexgent 下一代应用（TypeScript monorepo，以 Cordis 为运行架构、以 DeepSeek Harness 为只读参考重写）的文档树。起点是 2026-10-07 的评审与计划：[`research/pr4-review-and-plan-2026-10/README.md`](research/pr4-review-and-plan-2026-10/README.md)，下文简称“计划”。计划第 4 节按六步给出每步的参考实现、工作项与验收；本目录的其余文档都挂在这六步之下。

## 目录结构

| 位置 | 内容 | 何时写、何时改 |
| --- | --- | --- |
| [`research/`](research/) | 评审与调研报告（PR 评审、文献调研、参考库分析） | 结论性文档；发布后只勘误，不改写结论 |
| [`adr/`](adr/) | 架构决策记录（ADR），编号递增 | 每个决策一份；要改决策就写一份新 ADR 取代旧的，不改旧文 |
| [`spec/`](spec/) | 规范：数据与文件格式、权限与审批模型 | 先于编码写；每种格式配 schema 与读写测试，二者同步改 |
| [`plan/`](plan/) | 各步骤的任务拆分、分工与文件归属 | 每步开工前写，开工后只记偏差 |
| [`validation/`](validation/) | 各步验收记录、摘要 JSON、SHA-256 manifest | 每步一份记录；见下节 |
| [`reference-map.md`](reference-map.md) | DSH 包 → Nexgent 包 → 处理方式（改写 / 重写 / 不要）的对照表，以及参考库的获取方法 | 每次从参考库改写文件、新增或删除 Nexgent 包时更新 |

仓库根目录另有 [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)（第三方软件声明）；从参考库复制并改写的每个文件都要在其中登记。

代码的说明在各包自己的 README 里：[`packages/kernel`](../packages/kernel/README.md)、[`packages/llm`](../packages/llm/README.md)、[`packages/session`](../packages/session/README.md)、[`packages/workspace`](../packages/workspace/README.md)、[`packages/test-support`](../packages/test-support/README.md)、[`apps/cli`](../apps/cli/README.md)。每份写明用途、公开 API、对应的 DSH 参考与未完成项。它们实现的格式与策略以两份规范为准：[`spec/data-formats.md`](spec/data-formats.md)（`.nexgent/` 下的文件格式、项目配置、会话 JSONL、账本）与 [`spec/permissions.md`](spec/permissions.md)（沙箱模式、路径与命令策略、工具审批、费用上限、密钥存放）。

## 根 README 只描述已验收能力

仓库根目录的 `README.md` 只描述**通过了验收记录**的能力。能力写进 README 需本地测试通过且有验收记录：一项功能在 `docs/validation/` 里有对应步骤的验收记录（本地运行的测试与验收脚本通过；真实模型验收留有摘要）之前，只能出现在本目录的计划、规范与研究文档里，不进入根 README。这条规则来自计划 4.10“文档体系”一行，目的是让 README 的每句话都有证据可查，不再出现五代入口并存的描述。

旧的 Python 代码不在主干上：Python / PyQt 科研 Coding Harness 在分支 `archive/harness-gui`，Python 宿主与 benchmark 插件在分支 `archive/python-host`（`fd0b2f42`）。根 README 只用一节指向这两个分支。

## 验收记录的归属

每一步一份验收记录，位置与命名固定：

- 记录正文：`docs/validation/step-<n>-<yyyymmdd>.md`，按 [`validation/TEMPLATE.md`](validation/TEMPLATE.md) 填写；
- 摘要 JSON：`docs/validation/step-<n>/*.json`（脚本化 provider 与真实模型各一份或多份）；
- manifest：`docs/validation/step-<n>/manifest.sha256`，覆盖该目录下全部摘要文件；
- 原始 JSONL 请求记录不进入主分支，放在 Release 附件，记录正文写明位置与 manifest 摘要。

证据政策的细则见 [`validation/README.md`](validation/README.md)。里程碑与每步的退出门槛见计划 4.7。

## 当前文档一览

| 文档 | 状态 |
| --- | --- |
| [`research/pr4-review-and-plan-2026-10/README.md`](research/pr4-review-and-plan-2026-10/README.md) | 计划，2026-10-07 |
| [`adr/0001-reference-rewrite.md`](adr/0001-reference-rewrite.md) | 已接受：参考重写与计划 4.9 的全部决策 |
| [`adr/0002-claude-platform-route.md`](adr/0002-claude-platform-route.md) | 已接受：模型路由改为 Claude Platform，默认 Claude Sonnet 5.5（决策 3 的默认值被 ADR 0003 替代） |
| [`adr/0003-thinking-on-by-default.md`](adr/0003-thinking-on-by-default.md) | 已接受：执行默认开启 thinking |
| [`adr/0004-execution-forms.md`](adr/0004-execution-forms.md) | 已接受：四种执行形态、子会话、深度 1、成员审批与费用树（步骤 3） |
| [`adr/0005-capability-versions.md`](adr/0005-capability-versions.md) | 已接受：能力包与版本、候选、门控试验、采用规则、回滚与插件审批（步骤 4） |
| [`adr/0006-improvement-jobs.md`](adr/0006-improvement-jobs.md) | 已接受：改进作业的触发、诊断、提议、门控的反馈检查与改进预算（步骤 5，取代 ADR 0005 决策 5 的质量与 unknown 两句） |
| [`adr/0007-gate-cost-rule.md`](adr/0007-gate-cost-rule.md) | 已接受：门控费用规则，质量提高不因费用拒绝、按估算美元比较、超过 2 倍等用户批准（用户 2026-10-13 选 C；取代 ADR 0005 决策 5 与 ADR 0006 决策 6、8 中的费用比条款） |
| [`adr/0008-improver-versions.md`](adr/0008-improver-versions.md) | 已接受：改进器版本（项目级独立版本线，v0 为步骤 5 原文）、元改进作业、父子比较规则 `decideImprover`、评价器纪元、SDK API 6（步骤 6，用户 2026-10-13 “按推荐”） |
| [`adr/0009-comparison-origin.md`](adr/0009-comparison-origin.md) | 已接受：父子比较的起点先找没解决反馈的作业（从它开始时的能力版本起步），找不到就取最近的作业、从反馈当时的能力版本起步；`ComparisonOrigin.kind`（取代 0008 的起点规则；用户 2026-10-13 选 C） |
| [`adr/0010-diagnosis-sees-adopted-components.md`](adr/0010-diagnosis-sees-adopted-components.md) | 已接受：诊断提示列出作业所用能力版本的已采用组件（取代 0008 的“v0 与步骤 5 完全相同”）；比较两臂从反馈任务当时的版本起步（取代 0009 的“开始时的版本”）；用户 2026-10-14 选 A |
| [`adr/0011-measurement-pilot.md`](adr/0011-measurement-pilot.md) | 已接受：步骤 6 测量先在文档写作、文件整理两类新任务上做小试点，加“只记笔记”`memory` 对照臂，开跑前冻结题目、评分与统计（取代步骤 6 分工表已定决定 6、7 的族与臂部分）；用户 2026-10-14 按推荐 |
| [`adr/0012-shared-improver.md`](adr/0012-shared-improver.md) | 已接受：改进器改为用户级共享，能力组件仍在项目；元改进按用户计数与计预算，项目可退出（取代 0008 第 1、3 条的项目级口径）；用户 2026-10-14 按推荐 |
| [`adr/0013-gate-generalization-epoch.md`](adr/0013-gate-generalization-epoch.md) | 已接受：门控新纪元 `adr-0013`，改进作业候选在同类题上不得变差、没有同类题等批准，含原题具体数值的组件退回；用户 2026-10-14 按推荐 |
| [`adr/0014-gate-deliverable-paths-similar-cases.md`](adr/0014-gate-deliverable-paths-similar-cases.md) | 已接受：门控新纪元 `adr-0014`，回放检查按运行自己交付的同类文件找成果（照反馈改名不再判退步），同类题按去掉功能词与纯数字后的内容词重合 ≥ 0.25 判定；用户 2026-10-14 选 B |
| [`adr/0015-gate-feedback-one-time-extras.md`](adr/0015-gate-feedback-one-time-extras.md) | 已接受：门控新纪元 `adr-0015`，反馈检查不要求只针对那一次的附加要求，评审看到全部改动与删除的路径，打平时的偏好评审看到反馈原题的反馈；用户 2026-10-14 要求按系统缺陷修 |
| [`adr/0016-gate-review-both-orders-inputs.md`](adr/0016-gate-review-both-orders-inputs.md) | 已接受：门控新纪元 `adr-0016`，偏好评审每对按两种顺序各问一次、两次一致才计票，评审看到任务的输入文件（xlsx、docx、pdf 转成文字）；用户 2026-10-14 回复“按推荐” |
| [`adr/0017-audit-revised-rules.md`](adr/0017-audit-revised-rules.md) | 已接受：系统设计审查后修订的六条旧规定（编辑工具可覆盖、模型请求退避重试、学习默认开但先告知并封顶、数据移出项目、只读工具与委派并发、费用上限按美元）；用户 2026-10-16 按推荐 |
| [`adr/0018-three-layer-evolution.md`](adr/0018-three-layer-evolution.md) | 已接受：三层进化（经验手册、经过验证的技能与流程库、离线进化执行框架与改进器），每个任务自评，练习题集，经验与技能用户级共享、项目可关（取代 ADR 0006 的触发与单候选作业）；用户 2026-10-16 按推荐 |
| [`adr/0019-evaluation-epoch-practice-set.md`](adr/0019-evaluation-epoch-practice-set.md) | 已接受：评价纪元 `adr-0019`，在练习题集留出题上打分，“更省”单独记账，评分可靠性门槛，怎样才算进化（取代 ADR 0006 决策 6、0007 决策 3、0008 决策 4、0009）；用户 2026-10-16 按推荐 |
| [`adr/0020-desktop-information-architecture.md`](adr/0020-desktop-information-architecture.md) | 已接受：桌面两栏加按需抽屉、能力与设置整页、术语改人话、生成文字用用户语言、深浅两套配色；用户 2026-10-16 按推荐 |
| [`reference-map.md`](reference-map.md) | 步骤 0 建立，随各步更新 |
| [`plan/step-1-work-partition.md`](plan/step-1-work-partition.md) | 步骤 1 分工，开工前定稿 |
| [`plan/step-2-work-partition.md`](plan/step-2-work-partition.md) | 步骤 2 分工与验收设计，用户 2026-10-11 已定 |
| [`plan/step-3-work-partition.md`](plan/step-3-work-partition.md) | 步骤 3 分工与验收设计，用户 2026-10-11 已定 |
| [`plan/step-4-work-partition.md`](plan/step-4-work-partition.md) | 步骤 4 分工与验收设计，用户 2026-10-12 已定 |
| [`plan/step-5-work-partition.md`](plan/step-5-work-partition.md) | 步骤 5 分工与验收设计，用户 2026-10-13 已定 |
| [`plan/step-6-rework-partition.md`](plan/step-6-rework-partition.md) | 步骤 6 返工分工：去掉任务特化、改进器共享、门控防背答案、小试点测量（ADR 0011–0013），用户 2026-10-14 按推荐 |
| [`plan/rework-partition.md`](plan/rework-partition.md) | 重做分工：三层进化、把进化的代价移出主路径、权限与协作翻正、界面重做（ADR 0017–0020），用户 2026-10-16 按推荐 |
| [`spec/data-formats.md`](spec/data-formats.md) | 步骤 1–6 的文件格式；步骤 6 返工（ADR 0012、0013）补上 Nexgent 主目录（用户级配置、用户级改进器版本线与元改进队列）、`improverScope`、`shareImproverEvidence`、同类题规则与具体数值检查 |
| [`spec/permissions.md`](spec/permissions.md) | 步骤 1–6 的权限与审批；步骤 6 返工补上主目录拒绝读写、用户级受保护字段、元诊断只读本批项目、改进器文字的具体数值检查 |
| [`spec/agent-hooks.md`](spec/agent-hooks.md) | 步骤 2：agent loop 挂点、步骤 2 工具、系统提示增量、技能 |
| [`validation/README.md`](validation/README.md) | 证据政策 |
| [`validation/TEMPLATE.md`](validation/TEMPLATE.md) | 验收记录模板 |
