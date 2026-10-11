# 旧 RSI 分支复核与前沿调研（截至 2026-08-31）

2026-10-11

本文有两部分。第一部分是对 PR #1、PR #2 和 `feature/organization-loop` 的复核，快照日期为 2026-10-05。这三条线已被 2026-10-07 的[评审与计划](../pr4-review-and-plan-2026-10/README.md)取代，现在只作历史记录，用来核对新计划是否已经吸收其中的教训。第二部分调研 2025 年 11 月到 2026 年 8 月底的会议论文、预印本和厂商博客，并对应到计划中还没开始的步骤 3–6。

## 一页结论

1. **旧 RSI 线在 10-05 时还没有真实模型下的正向改进证据。** PR #1 顶端全量测试 25 项失败；organization-loop 修好了这 25 项，又引入 2 项。真实模型下，有效的组织采纳只有 1 次，而且回归检查用的是同一道题；默认框架路径没有一次真实发布，规划器反复选择 `no_change`。
2. **卡住旧线的不是机制，而是三个条件**：执行者和改进者用的都是同一个 flash 模型；任务太简单，没有改进余量；每次只有 1 个样本，selection 复用开发来源。现行计划已经换用 Claude Sonnet 5.5，并规定了 `dev / selection / guard / holdout` 分离和至少 3 次重复，这三点已被吸收。仍要防的是“只跑定向测试”带来的跨模块回归：旧线上发生了两次，而 CI 现在只能手动触发。
3. **前沿的共识可以直接作为步骤 4–6 的设计约束**：
   - 门控要用不相交的 held-out 集、多次重复，提交时取历史最优版本而不是最后一个。
   - 模型自己写的技能，没有外部验证时平均没有收益。
   - 沉淀下来的经验要测“是否真的被用上”。
   - 多智能体不一定比单智能体好，必须在同等预算下对比。
   - 已公开的有效案例都具备三个条件：强执行者、外部硬评估器、大样本。
4. **最接近 Nexgent 步骤 5 的工业实例是 OpenAI 的 Tax AI（2026-05-27）**。它的流程是：专家纠错，形成结构化 trace，把重复失败变成 eval 集，由 Codex 修改 harness，回归测试后上线。机制并不复杂，收益来自大样本和专家反馈。

## 方法与局限

- **仓库复核**：在 Python 3.11 云端环境安装四个 benchmark 插件，用 `QT_QPA_PLATFORM=offscreen pytest -q` 跑全量测试，失败测试逐提交二分定位。阅读了 `REFACTOR_PLAN.md`、`docs/framework-runtime.md`、`docs/organization-loop.md` 和 `docs/validation/` 下 10-02 到 10-05 的记录。
- **文献**：[PR #2 的 papers.md](https://github.com/csxq0605/Nexgent/blob/research/org-rsi-review-2026-09/docs/research/org-rsi-review-2026-09/papers.md) 已从 12 个会议的录用列表中精选了 276 篇，本文不重复。本文只抽查其中的关键引用，并补充它没有覆盖的预印本、CVPR 和厂商博客。
- **局限**：
  - 本次环境的网络策略拦截了 arxiv.org、openai.com 和 alignment.anthropic.com。下文的数字来自搜索结果中的摘要和二手报道，没有逐篇读全文，也没有复现。
  - 抽查的引用（HSI、Meta-Team、Towards a Science of Scaling Agent Systems、OneManCompany）都真实存在。只有一处数字不一致：Google 那篇的摘要写 180 种配置，PR #2 写的是 260。
  - 标有“窗口外”的条目发布于 2026-09 之后，仅作参考。

## 第一部分：旧 RSI 线复核（快照 2026-10-05）

### 1.1 三条线

| 线 | 时间 | 内容 | 本地复核 |
| --- | --- | --- | --- |
| PR #1 `refactor/scientific-rsi` | 09-16 → 09-24 | 176 个提交，+750k 行，其中约 65 万行是 JSON 收据。Python Episode 内核、能力发布与门控、O/S/M/R 通道 | 全量 **25 失败 / 1247 通过 / 4 跳过**，与 PR #2 报告一致；失败集中在 `test_adaptive_*`、`test_task_capability_adoption`、`test_task_skill_adoption`、`test_task_deadline` |
| PR #2 `research/org-rsi-review-2026-09` | 09-28 | 纯文档：重审加 276 篇论文；建议以 DSH 为底座，Nexgent 只做“组织进化层” | 抽查的引用均真实存在 |
| `feature/organization-loop`（未开 PR） | 09-29 → 10-05 | 在 PR #1 之上再加 23 个提交、+9.7k 行。09-29 新增 `OrganizationService`；10-02 改为通用框架 `Nexgent(root)`，组织降级为 `--organization-demo` | 全量 **2 失败 / 1444 通过 / 4 跳过**。PR #1 的 25 项已修复；`51088b8` 引入 2 项稳定失败：`test_product_workflow.py::test_main_default_strategy_finishes_published_work_in_both_completion_forms` 期望 3 次模型调用，实际只有 2 次 |

### 1.2 评价

**做得好的地方**

- **证据纪律严格**：负结果都保留；“确定性机制 / 真实执行 / 独立效果”分开标记；远端结果未知的调用不重放；费用缺失时不拿已知小计冒充总数。
- **独立评价器、门控、guard 回滚的原则正确**，与第二部分的前沿共识一致。
- **organization-loop 的成员表示改成了 `name + instructions`**，方向接近 AOrchestra 的四元组，比 PR #1 约 15KB 的私有图补丁 DSL 合理。

**问题**

1. **两周内定位换了三次。** 能力内核 RSI（09-23）→ 组织服务（09-29）→ 通用框架加组织 demo（10-02）。每次都保留上一套，最后三条执行路径并存。
2. **门控在统计上无法得出可信结论。** selection 复用开发来源任务，guard 只有 1 个历史任务；评价器默认与执行器是同一个模型；每轮 N=1。在这种规模下，“+0.1 分或减少 20% 消耗”的阈值落在噪声范围内。
3. **学习信号太弱。** 真实任务多是本来就能通过的简单题（CSV 汇总、比价），而且执行者与改进者都是 `mimo-v2.6-flash`，所以规划器反复选择 `no_change`。
4. **只跑定向测试，回归在顶端堆积。** PR #1 的 `790d89f`、`75377bd` 共带入 25 项失败，organization-loop 的 `51088b8` 又带入 2 项，两次都是在合并前全量测试时才暴露。

**真实模型证据汇总（10-05）**

- 组织 demo 有两次真实采纳：
  - 2 名成员精简为 1 名，有效，但回归检查用的是同一道题；
  - 另一次由评价器忽略“不生成文件”的约束导致误采纳，已作废。
- 默认框架路径：真实发布 0 次。正向发布、效率发布、修正后学习这三条闭环都只在模型替身下通过。

### 1.3 现行计划是否已经吸收

| 教训 | 现行计划（10-07）中的对应 | 状态 |
| --- | --- | --- |
| 执行者和改进者模型太弱 | ADR 0002 / 0003：Claude Sonnet 5.5，默认开 thinking | 已吸收 |
| 重造底座 | ADR 0001：以 Cordis 为运行架构，DSH 作只读参考重写 | 已吸收（方式与 PR #2 建议的“直接复用”不同） |
| N=1、selection 复用来源 | 步骤 4 的 `capability_trial`：每臂跑 r 次，selection 与 guard 不重叠；步骤 6 的 holdout 只用于报告，每条至少 3 次重复 | 已写入计划，步骤 4–6 未开始 |
| 评价器与改进者同步变化 | 步骤 6：评价器按纪元冻结 | 已写入计划 |
| 只跑定向测试导致回归 | 每步有验收脚本；CI 改为手动触发（用户 10-11 决定） | **部分吸收**：建议合并到集成分支前在本地跑一次完整的 `pnpm test` 和 `accept-step*` |
| 简单任务没有改进余量 | 步骤 6 至少覆盖两个任务族 | **待补**：任务族的基线成功率最好落在 20–80% 之间 |
| 经验是否真的被用上 | 步骤 4 的账本记录“实际调用的组件” | 已吸收 |

## 第二部分：前沿进展（2025-11 → 2026-08-31）

### 2.1 会议

| 会议 | 与本项目最相关的工作 | 要点 |
| --- | --- | --- |
| ICLR 2026 | [DGM](https://iclr.cc/virtual/2026/poster/10007327)（poster） | 用开放式档案保存 coding agent 自己改出的版本，每次改动都在基准上实测；SWE-bench 20%→50%，Polyglot 14.2%→30.7% |
| | [HGM](https://iclr.cc/virtual/2026/oral/10009360)（oral） | 用子树聚合的“元生产力”（CMP）选择下一个扩展节点；当前分数高，不等于继续自改进的潜力高 |
| | [RSI Workshop](https://recursive-workshop.github.io/papers.html)（110 篇） | 口头报告：Agent0、Contextual Drag、元学习 agent 记忆设计、PostTrainBench |
| ICML 2026 | EvoMAS、AOrchestra、Multi-Agent Teams Hold Experts Back、Evolving Interpretable Constitutions、LLM Agents Are Not Always Faithful Self-Evolvers、VeRO、MonoScale | 结构化配置优于让模型写代码；团队相对最强个体最多损失 41%；压缩后的经验常被模型忽略；VeRO 提供 agent 优化 agent 用的外层 harness（详见 PR #2） |
| AAAI 2026 | HiveMind、Assemble Your Crew | 用 DAG-Shapley 做成员贡献归因；自回归生成组织结构 |
| ACL 2026 | AgentSlimming、TraceElephant | 精简成员可省最多 78.9% token，配基线锚定的接受规则；完整轨迹让失败归因准确率最多提高 76% |
| COLM 2026 | CooperBench、EvoSkill、CORAL | 两个 agent 协作时成功率平均低 30%；只保留能提升 held-out 集的技能；评估器与执行者分离 |
| NeurIPS 2025 | AgentNet、MAST、Puppeteer | 去中心化组织；14 种多智能体失败模式（步骤 5 沿用它的三类标签）；RL 训练的编排器 |
| CVPR 2026 | [Dejavu](https://openaccess.thecvf.com/content/CVPR2026/html/Wu_Dejavu_Towards_Experience_Feedback_Learning_for_Embodied_Intelligence_CVPR_2026_paper.html)、[EvoNav](https://openaccess.thecvf.com/content/CVPR2026/papers/Dai_History_to_Future_Evolving_Agent_with_Experience_and_Thought_for_CVPR_2026_paper.pdf)、EchoTrail-GUI（Findings） | 集中在具身和 GUI 方向的经验记忆自进化，对 Nexgent 只有间接参考价值 |

### 2.2 窗口内的预印本（PR #2 未覆盖或需强调）

| 工作 | 日期 | 发现 | 对 Nexgent 的含义 |
| --- | --- | --- | --- |
| [PAST-Bench](https://arxiv.org/abs/2608.04003) | 08-05 | 26 个任务家族、204 个 episode；每个家族都配“去掉持久化”的对照组，衡量保留下来的经验是否带来后续增益 | 步骤 5–6 的评测可直接参考：同一任务族内，比较“有能力版本”和“无持久化”两条线 |
| [RSIBench-Data](https://arxiv.org/abs/2607.25886) | 07-28 | 在固定资源下比较 Claude Code 和 Codex：58% 的设置能在首个有效结果上继续改进，但 **78% 的搜索最终提交的结果比已见峰值差** | `capability_trial` 和改进作业应保留并提交历史最优版本，不能默认最后一个 |
| [HSI](https://arxiv.org/abs/2608.08466) | 08 | 冻结模型，分三层：harness、改写 harness 的演化器、改写演化器的元演化器；BabyAI +39.3%，Crafter +33.0% | 明确指出两个上限：反馈保真度和骨干能力 |
| [AI4AI-Bench](https://arxiv.org/abs/2608.20318) | 08 | 29 种配置的平均分 0.166，最好 0.250 | 自动研究离实用仍远，步骤 6 的报告要如实写零或负结果 |
| [Self-Improvements in Modern Agentic Systems](https://arxiv.org/abs/2607.13104) | 07 | 综述，把自改进分为两类：改模型本身，或改 scaffold（提示、记忆、工具、控制逻辑） | Nexgent 的 `CapabilityBundle` 属于后一类 |
| [Meta-Team](https://arxiv.org/abs/2605.29790) | 05 | 在个体、成员间交互、团队组织三个层面做协同自进化 | 步骤 3 的 team 形态和步骤 5 改“协作方式”时的直接对标 |
| [Red Queen GM](https://arxiv.org/abs/2606.26294)、[RHI](https://arxiv.org/abs/2607.15524)、RSEA、MetaSkill-Evolve | 06–07 | 评估器按纪元更新；信息流是收益的主要来源；不相交的 held-out 集上不退步才提交 | 计划第 4.6 节已采用纪元冻结 |

### 2.3 厂商博客与报告

| 来源 | 日期 | 要点 | 对 Nexgent 的含义 |
| --- | --- | --- | --- |
| OpenAI [Building self-improving tax agents with Codex](https://openai.com/index/building-self-improving-tax-agents-with-codex/) | 05-27 | 与 Thrive 合作的 Tax AI：专家纠错→结构化 trace→重复失败变成 eval 集→Codex 定位并修改 harness→回归测试后上线。处理了 7000 份申报；字段正确率达到 75% 的申报占比在 6 周内从 25% 升到 86%；改进的是 harness 而不是模型 | **步骤 5 最直接的工业模板**。差别在于有专家反馈和大样本 |
| OpenAI [自动研究实习生](https://www.helpnetsecurity.com/2026/09/07/openai-research-automation-intern/) | 09（窗口外，数据截至 8 月中） | 研究组织内每个人类工作日对应 3.1 个 agent 工作日；研究者推理费用中位数超过每天 600 美元 | 人仍负责定优先级和评估结果 |
| Anthropic Agent Teams（随 Opus 4.6 发布） | 02 | lead 加多个 teammate，点对点邮箱，共享任务列表 | 组织运行底座已商品化；步骤 3 的 team 形态可以参照 |
| Anthropic [Harness design for long-running apps](https://www.anthropic.com/engineering/harness-design-long-running-apps) | 03 | 规划、生成、评估分属不同 agent | 独立评估角色是关键 |
| Anthropic [Automated Alignment Researcher](https://www.anthropic.com/research/automated-researchers-mitigate-alignment-failures) | 04-14 首版；08 月论文 [2608.28945](https://arxiv.org/abs/2608.28945) | 首版：9 个 Opus 4.6 agent 在并行沙箱中运行，通过论坛共享发现，评分走远程 API；5 天恢复 97% 的性能差距（人类研究者 7 天为 23%），花费约 1.8 万美元。论文版：覆盖 10 类对齐失败，能泛化到 held-out 基准，优于 28 位人类研究者 | **评分接口放在 agent 外部、并行种群、共享发现**，这三点可用于步骤 6 |
| Google [Towards a science of scaling agent systems](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/)（[2512.08296](https://arxiv.org/abs/2512.08296)） | 01（博客） | 相对单 agent，从 +80.8%（可分解的金融推理）到 −70.0%（顺序规划）都有；单 agent 基线越强，协调收益越小；没有集中验证的架构更容易传播错误 | 步骤 3 的四种协作形态要和单 agent 在同等预算下对比 |
| Google DeepMind [Co-Scientist](https://deepmind.google/blog/co-scientist-a-multi-agent-ai-partner-to-accelerate-research/)、[AlphaEvolve impact](https://deepmind.google/blog/alphaevolve-impact/) | 2026 | Co-Scientist 发表于 Nature；AlphaEvolve 并入 Gemini for Science 的 Computational Discovery | 有硬评估器的领域，进化搜索已经落地 |
| Kimi [K2.5 技术报告](https://arxiv.org/abs/2602.02276) | 01–02 | 用 PARL 把“何时并行、开几个子 agent”训进权重；最多 100 个子 agent，延迟最多降到 1/4.5 | 一部分编排能力会被训进模型；框架层的协作方式要能随模型重新选择，不应写死 |
| Kimi K2.6（[报道](https://www.marktechpost.com/2026/04/20/moonshot-ai-releases-kimi-k2-6-with-long-horizon-coding-agent-swarm-scaling-to-300-sub-agents-and-4000-coordinated-steps/)） | 04-20 | 300 个子 agent，4000 个协调步骤 | 同上 |
| 智谱 [GLM-5.1](https://docs.z.ai/guides/llm/glm-5.1) | 04 | 单任务可自主运行 8 小时；600 多轮迭代、6000 多次工具调用后仍有进展；50 个 kernel 优化问题上几何平均提速 3.6 倍 | 可作为长程改进作业的备选模型（当前路由只走 Claude Platform） |
| 智谱 GLM-5.2（[报道](https://www.verdent.ai/guides/what-is-glm-5-2)） | 06-13 | 744B MoE，1M 上下文，MIT 开源 | 同上 |
| [DeepSeek Harness](https://thenewstack.io/deepseek-harness-open-source-plugins/) | 08 | 一切皆插件；社区有 agent-teams 插件（14 个协调工具，持久状态） | 已作为只读参考（ADR 0001） |

### 2.4 共识

1. **门控**：不相交的 held-out 集、多次重复、保留历史最优版本（RSEA、EvoSkill、RSIBench-Data）。没有门控的上下文进化会崩溃。
2. **自生成资产默认无效**：模型自己写的技能，没有外部验证时平均没有收益（SkillsBench）；只靠自我反馈会递归漂移（SkillLearnBench）；压缩后的经验常被忽略（Not Always Faithful Self-Evolvers）。
3. **协作不是默认更好**：收益取决于任务能否分解、有没有可靠验证、模型能力强弱（Google、CooperBench、Teams Hold Experts Back）。
4. **有效案例的共同条件**：强执行者、外部硬评估器、大样本（Tax AI、AAR、AlphaEvolve、DGM）。
5. **改机制才有用，只调参数没用**（Bilevel Autoresearch），收益常来自信息流（RHI）。

## 第三部分：对步骤 3–6 的建议

| 步骤 | 可借鉴 | 风险与建议 |
| --- | --- | --- |
| 3 迁移与协作（subagent、team、workflow、ptc） | Anthropic Agent Teams、DSH agent-teams 插件、AOrchestra 四元组 | 四种形态各完成一次只能证明能运行。建议在验收记录里加一组同等预算下的单 agent 对照，哪怕只跑一个任务；没有对照时，不宣称协作带来了收益 |
| 4 能力版本 `CapabilityBundle` | EvoSkill（held-out 选择）、MUSE-Autoskill（生命周期）、DGM 档案 | 回放集来自项目历史，早期样本很少。建议在门控里写明：提交历史最优版本（RSIBench-Data）；验证“实际调用”而不只是“已加载”（计划已有）；加一项安全回归（Misevolve） |
| 5 默认反馈改进 `@nexgent/evolve` | OpenAI Tax AI 的流程；MAST 三类标签；Failure-Driven Workflow Refinement 按失败聚类 | 旧线反复 `no_change` 的教训：反馈任务如果本来就能通过，就没有可学的东西。建议优先用失败或被纠正过的任务触发改进，并把重复出现的失败沉淀成回放集里的检查项（与 Tax AI 的做法相同） |
| 6 递归与检验 | HGM 的 CMP、Red Queen 纪元、PAST-Bench 的无持久化对照、AAR 的外部评分 API | 任务族的基线成功率最好落在 20–80% 之间；同时报告改进本身的费用和收回期（Inefficiencies of Meta Agents）；防止被改进者污染评估器（Meta-Agent Challenge 中出现过偷取标准答案） |

## 来源

**仓库**：`csxq0605/Nexgent` 的 `refactor/scientific-rsi@5ec023a`、`research/org-rsi-review-2026-09@85f67de`、`feature/organization-loop@2663a1a`，以及 `main@77ed63b6` 上的计划与 ADR。

**论文与博客**：见正文表格中的链接。PR #2 中未在本文重复的论文，见它的 [papers.md](https://github.com/csxq0605/Nexgent/blob/research/org-rsi-review-2026-09/docs/research/org-rsi-review-2026-09/papers.md)。

**窗口外，仅作参考**：OpenAI 自动研究实习生公告（2026-09）、Anthropic 关于 Claude 主导 26% 研发工作的报道（2026-09）、Agensh（2026-09）、RRSI（2026-09）、VERSE（2026-10）。
