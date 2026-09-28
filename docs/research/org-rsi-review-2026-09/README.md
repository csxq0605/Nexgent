# Nexgent 重审与组织化 RSI 前沿调研

2026-09-28

PR #1 作为证据与门控底座质量很高，但作为你要的“通用、能从任务反馈自我迭代、像人类组织一样排布和进化智能体集群”的框架，它目前既没有跑通（PR 顶端 25 项测试失败；10 次真实闭环 0 次晋升），也还没有“组织”这一层对象。2026 年的前沿已经把“组织本身可进化”做成了明确方向（Meta-Team、OneManCompany、TheBotCompany 等），同时大量证据表明组织形态必须按模型和任务重新学习、并且经常不如单智能体。这恰好是 Nexgent 的独立评价与门控最能发挥的地方，前提是改用 DeepSeek Harness 这类现成底座，并把可进化对象从 JSON 图补丁换成组织要素。

## 结论摘要

1. **PR 跑不通，且有未被发现的回归。** 顶端 `5ec023a` 的 1,276 项测试中 25 项失败，全部落在计划里标为“确定性通过”的 D1／E3 机制上；10 次普通入口真实闭环 0 次晋升。
2. **定位对，形态偏。** “通用框架 + demo 只是插件 + 独立评价才采纳”的边界守住了；但产品长成了近 30 个 `rsi-*` 命令的证据治理系统，没有你要的“组织”层：角色只能 `ask`、没有花名册／邮箱／招聘与裁撒、没有按成员的贡献归因。
3. **组织化不是空白，而是 2026 年的热点。** 精选的 276 篇中约 100 篇研究多智能体组织与协作，60 多篇做组织／拓扑／工作流的自动设计；Meta-Team、OneManCompany、TheBotCompany、MAS²、EvoMAS 已经在做“增删成员、改结构、改章程”。
4. **证据指向一个真正的缺口。** 多智能体经常不如单智能体（协作成功率低 30%、团队拖累专家最多 41%），最优组织随模型家族和任务翻转，元智能体设计的系统很少赢过人工基线，没有护栏的优化器会作弊。“在严格留出集门控和完整成本账下、跨任务地学习组织形态”几乎没人做实——这是 Nexgent 最合理的位置。
5. **底座应换。** DeepSeek Harness 已有 Agent Teams（花名册、持久邮箱、任务图）、模型写脚本的动态工作流、异构子智能体、Creator 自装插件和可撤销的插件副作用，恰好是“组织的物理层”；它没有的是“组织学习”。ADR 001 选 Python 内核时没有评估这些组织层能力，值得重审。

## 调研范围与方法

覆盖 2025 年 11 月到 2026 年 8 月底出版或公布录用的 12 个会议，共 38,995 篇。流程：抓取官方完整录用列表 → 按 8 个主题的关键词程序筛标题 → 抓摘要并打分 → 人工逐条过标题 → 精选 276 篇读摘要（162 篇补到 arXiv 全摘要）。另对 arXiv 2026-01 至 2026-08 做了 12 组关键词检索（108 条），补入尚未上会的关键工作。

| 会议 | 录用篇数 | 标题初筛 | 已取摘要 | 精选 |
| --- | --- | --- | --- | --- |
| ICML 2026 | 6,646 | 364 | 364 | 60 |
| ACL 2026（含 Findings） | 4,698 | 533 | 533 | 61 |
| ICLR 2026 | 5,468 | 279 | 249 | 41 |
| COLM 2026 | 852 | 123 | — | 38 |
| AAMAS 2026 | 641 | 156 | — | 21 |
| EMNLP 2025（含 Findings） | 3,484 | 199 | 199 | 17 |
| NeurIPS 2025 | 5,858 | 204 | 168 | 14 |
| AAAI 2026 | 4,920 | 233 | 229 | 13 |
| EACL 2026 | 914 | 68 | 68 | 5 |
| KDD 2026（仅 500 篇公开列表） | 500 | 40 | — | 3 |
| CVPR 2026 | 4,042 | 98 | 98 | 2 |
| IJCAI 2026 | 972 | 47 | — | 1 |
| 合计 | 38,995 | 2,344 | 1,908 | 276 |

八个主题：递归自改进（A，24 篇）、组织／工作流自动设计（B，63）、组织与协作（C，98）、工具与技能（D，31）、经验记忆（E，23）、评测与安全（F，19）、自动科研（G，14）、长程 harness（H，5）。完整清单见 [papers.md](papers.md)（清单按“更具体的主题优先”去重归类，各组篇数与这里略有不同）。COLM、AAMAS、IJCAI、KDD 官方页没有摘要，按标题判断后再去 arXiv 补摘要。实验室博客覆盖 OpenAI、Anthropic、Google／DeepMind、DeepSeek、Moonshot、智谱、Cursor。

## PR #1 现状核实

[Draft PR #1](https://github.com/csxq0605/Nexgent/pull/1) 的 176 个提交集中在 2026-09-16 至 09-24（仅 09-24 一天 104 个），相对 `main` 改动 646 个文件、+750,333 行，其中约 65 万行是 JSON 收据。`src/nexgent/tasks/` 共 33,641 行：任务执行类 15,483 行，进化与采纳类 10,727 行，递归与研究类 7,414 行；`runtime.py` 单文件 4,232 行。

**测试。** 我在云端 Python 3.11 环境安装四个插件后跑全量：1,276 项中 1,247 通过、4 跳过、**25 失败**。失败集中在 `test_adaptive_*`（策略选择与检查点切换）、`test_task_capability_adoption`、`test_task_skill_adoption`、`test_task_dynamic_roles`、`test_task_deadline`，错误主要是“策略选择 RPC 缺少终态模型收据”和“根 Episode 完成 token 预算耗尽”。二分结果：

| 提交 | 说明（节选） | 这 25 项的结果 |
| --- | --- | --- |
| `086b55b` 及以前 | Validate model-authored bindings… | 25 通过 |
| `e21a74d` | Record upstream planner format failure | 25 通过 |
| `790d89f` | Recover metered JSON envelope failures…（说明称“联合 98 项定向测试通过”） | **19 失败** |
| `75377bd` | Raise generic architect output ceiling…（称“14 项定向测试通过”） | **25 失败** |
| `5ec023a`（顶端） | Record architect budget live result… | 25 失败 |

含义：“只跑定向测试”的做法漏掉了跨模块回归，计划里 D1-B／D1-C／E3-A、还有任务技能采纳的“确定性通过”在顶端已不成立。

**真实运行。** 全部用 `mimo-v2.6-flash`。`experiments/ordinary_feedback_live/` 的 10 次普通入口闭环没有一次晋升：3 次到达 selection 但父、候选都失败被拒，其余停在补丁合同错误、不支持的 `ask` 参数、根图字段无效、JSON 尾随文本、输出截断、交付 schema 错误、DNS 或 Provider 超时。唯一一次“晋升 + 新进程复用”是实验程序显式串接的乘法工具（E3-B.1），其 selection 父版本是因 JSON 协议错误失败。D1-B／D1-C 的真实编排选择与中途切换探针也都未过前提。README 自述“没有正向 RSI 或递归收益证据”。

## 按你的定位逐条对照

六条要求里，只有“通用、不耦合 demo”一条基本达成。

| 你的要求 | PR 中的实际情况 | 判断 |
| --- | --- | --- |
| Nexgent 本身是通用、能跑 benchmark 的 RSI 框架；OpenFOAM／科学发现只是 demo | 核心不导入领域插件；BenchmarkAdapter、Workbench、BBH、OpenFOAM smoke 都以插件接入 | 达成 |
| AutoSci 式：做完任务，并从任务反馈自我迭代技能、编排、记忆 | 反馈→候选→独立 selection→晋升→guard→复用的链路在确定性测试里接通过，但顶端已有 25 项回归，真实模型下 0 次走完 | 未达成 |
| 不要暴露大量旋钮的 code harness | 近 30 个 `rsi-*` CLI 命令、PackagePatch v1–v4、EpisodeAuthority v1/v2、O/S/M/R 通道、每次实验先写预注册合同 | 方向相反 |
| Main 单一对话入口 + 信息窗口 | MainWindow 已是默认入口，但一次输入只创建一个 Episode，多轮、附件、能力与演化视图未完成 | 部分 |
| 像人类组织一样自动排布、协作、精简、进化、添加智能体 | architect 一次性画 DAG；任务角色只能 `ask`；没有花名册、邮箱、任务板、招聘／裁撒、成员贡献归因；进化对象是图补丁而非组织 | 基本缺失 |
| 分阶段增量测试，不跑全量 | 按要求执行，但两个提交带入的 25 项回归未被发现 | 需要补一道闸 |

最后一条不是要推翻你的偏好：在阶段合并前跑一次全量（云端约 7.5 分钟）即可，开发中仍用定向测试。

## 问题根因

失败几乎都不是 RSI 机制本身的问题，而是下面六个工程选择叠加的结果。

1. **模型面对的是私有 DSL。** architect 提示约 15KB，要求模型输出 `add_node`／`add_artifact_edge`、`$node`／`$input` 绑定、`task:<alias>` 角色；R0 还要写 PackagePatch v3/v4。真实失败几乎全是这个 DSL 的合同错误。[Evoflux](https://arxiv.org/abs/2606.12674) 测得小模型生成的工作流图可执行率约 3%；[EvoMAS](https://arxiv.org/abs/2602.06511)（ICML 2026）也明确说模型写代码式编排“常导致可执行性失败”，改在配置空间进化。
2. **执行模型与改进模型是同一个 flash 模型。** [HSI](https://arxiv.org/abs/2608.08466) 明确指出“骨干能力上限”；[Drop the Hierarchy](https://arxiv.org/abs/2603.28990) 发现低于能力门槛的模型无法自组织、反而需要固定结构；[单模型多智能体的扩展规律](https://arxiv.org/abs/2606.00655)也要求“足够强的基座”。
3. **实验落在“从 0 到 1”区间。** 多次 selection 中父、候选都得 0 分，反馈没有度的信息，门控不可能通过。
4. **每次只有 1 个样本。** “预注册 → 单次实跑 → 修一个合同错误”每轮只暴露下一个错误；前沿工作（DGM、GEA、RSEA、Meta-Team）都用种群或档案加批量任务。
5. **重造了底座。** 作用域工具、服务插件、子任务委派、DAG↔代码切换这些，DeepSeek Harness 已有更成熟的实现，占用了本该投入“进化”的精力。
6. **验证粒度与代码增长不匹配。** 一天 104 个提交、每个只跑少数定向测试，跨模块回归在顶端累积。

## 参考系统精读：谁已经做了“组织底座”

判断 Nexgent 该做什么，先要看清别人已经把什么做成了基础设施。下表只记录读过代码或官方文档后能确认的内容。

| 系统 | 已提供的组织原语 | 组织学习／进化 | 评估与门控 | 对 Nexgent 的含义 |
| --- | --- | --- | --- | --- |
| **DeepSeek Harness（Cordis）** | Lead + 扁平 roster；持久 mailbox；CAS 任务 DAG；`wait_agent`；JS 动态工作流 `agent()/parallel()/pipeline()`；subagent provider 可选 fresh／fork／Claude Code／Codex／ACP，并按模型选路由；“一切皆插件”、副作用可回滚；Creator 模式可 `install_bundle` 装插件；goal／Ralph 循环与 auto-review | 无。团队怎么排、谁留谁走由 Lead 每次临场决定，不跨任务沉淀 | 单任务 auto-review；无 held-out、无成本核算、无“改了组织是否更好”的判定 | Nexgent 自建的 Episode／Package／执行层与之高度重叠。DSH 恰好缺的就是你想做的那层：**组织层面的学习 + 门控** |
| **AutoSci** | SciMem／SciFlow／SciDAG／SciEvolve，建在 Claude Code 上，按科研流程分工 | SciEvolve 可改流程与记忆 | 论文与仓库都没有给出演化前后的定量对比 | 证明“AutoSci 式编排”能做成，但还没证明“演化真的带来提升”，这正是可以超过它的地方 |
| **Claude Code Agent Teams／subagents** | Lead 派发、队友互发消息、共享任务列表；subagent 独立上下文 | 无内建组织学习，靠 CLAUDE.md／Skills 人工沉淀 | 无 | 与 DSH 同类的底座，可作为第二种执行后端做对照 |
| **OpenAI Codex（subagents／agent loop）+ “自动研究实习生”目标** | Codex 支持并行 subagent；OpenAI 公开把“自动化研究实习生”列为阶段目标 | 未公开组织自改进机制 | 以任务完成率与人审为主 | 方向与你的设想一致，但公开材料里只有愿景和单体 agent 能力，**没有“组织如何自我进化”的方法**，这里仍是空白 |
| **Kimi Agent Swarm（K2.5／K2.6）** | 模型经 RL 学会自己拆任务、并行起子 agent（官方称可达上百个） | 编排能力训练进模型权重，而不是在运行时演化 | 以基准分数报告 | 另一条路线：把“会组织”训进模型。对框架层的启示是，编排策略应当**随模型重新学习**，不能写死 |
| **Cursor planner／worker／judge** | 规划者、执行者、评审者三层；长程大规模并行 | 靠人的工程迭代调整；公开复盘了扁平加锁协作失败、改为分层 | judge 做每轮验收 | “组织设计要靠实测修正”的一手工业证据 |
| **Anthropic Managed Agents** | 托管的 agent 运行时：会话、沙箱、工具与长时任务 | 无组织学习 | 提供运行与观测，不提供组织门控 | 又一个现成底座，说明运行时正在被平台商品化 |

到 2026 年 9 月，**“让一群 agent 跑起来并互相通信”已经是商品化能力**。公开系统普遍缺三件事：

1. 用任务反馈去**改组织本身**（加人、减人、改角色、改规则、改汇报关系），并能跨任务沉淀；
2. 判定“改了之后是否真的更好”的 **held-out 门控与成本核算**；
3. 换了底层模型后**重新学习组织设计**，因为最优组织形态随模型家族改变（见下两节）。

这三件事正对应你最初的设想，也是 Nexgent 最值得占住的位置。

## 前沿①：组织什么时候有用、什么时候拖后腿

这是整个方向的地基问题。2026 年的受控研究给出的答案很一致：**多 agent 组织不是默认更好，收益高度依赖任务结构、模型能力和组织设计本身**。

| 工作 | 设置 | 关键数字 | 对你的含义 |
| --- | --- | --- | --- |
| [Towards a Science of Scaling Agent Systems](https://arxiv.org/abs/2512.08296)（Google，2025-12） | 260 种配置、6 个基准、5 种架构、3 个模型家族，统一工具与算力 | 相对单 agent：可分解金融推理 **+80.8%**，顺序规划 **−70.0%**；单 agent 基线越强，协调收益越小；无集中验证的架构更易传播错误 | 组织形态必须按任务选，且要有验证者角色 |
| [Multi-Agent Teams Hold Experts Back](https://arxiv.org/abs/2602.01011)（ICML 2026） | 自组织团队 vs 团队中最强个体 | 团队始终追不上专家，ML 基准上损失最多 **41.1%**；瓶颈是“用好专家”而非“认出专家”，团队越大越爱折中 | 自发协商不可靠，需要显式的决策权分配 |
| [CooperBench](https://arxiv.org/abs/2601.13295)（COLM 2026） | 600+ 协作编码任务，两 agent 各做一个特性 | 合作时成功率平均低 **30%**；消息含糊、违背承诺、误判他人计划 | 通信协议本身是要学习／约束的对象 |
| [HiddenBench](https://arxiv.org/abs/2505.11556)（ICML 2026） | 信息分散在不同 agent 手中 | 多 agent **30.1%** vs 单 agent 拿全信息 **80.7%**；规模越大越差；结构化通信协议能明显改善 | 信息流设计比人数更重要 |
| [When Agents Evolve, Institutions Follow](https://arxiv.org/abs/2604.27691) | 7 种历史政治制度 → 多 agent 架构，3 个模型、2 个基准 | 同一模型下最好与最差制度差 **57 个百分点以上**；最优制度随模型能力与任务变化 | 制度要能被重选，不能一次定型 |
| [IMACS](https://arxiv.org/abs/2607.25446)（2026-07） | 把“谁在团队／怎么对齐／用哪种协作算法”拆成三层独立变量 | 按任务选协议的 bandit 胜过所有固定协议；问责位置的最优解**随模型家族翻转** | 直接支持“换模型就要重学组织”的判断 |
| [OrgAgent](https://arxiv.org/abs/2604.01020) | 公司式治理／执行／合规三层 vs 扁平 | GPT-OSS-120B 在 SQuAD 2.0 上分层比扁平 **+102.73%**、token **−74.52%** | 在需要稳定分工和逐层验证的任务上层级有效 |
| [Drop the Hierarchy and Roles](https://arxiv.org/abs/2603.28990) | 25,000 任务、8 模型、4–256 agent、8 种协议 | 只给最少结构的混合协议比集中式高 **14%**；强模型能自组织，弱模型仍需刚性结构 | 与 OrgAgent 表面矛盾，实为同一结论：**最优结构取决于模型能力** |
| [Scaling Behavior of Single-LLM MAS](https://arxiv.org/abs/2606.00655) | 同构 agent 数量扩展 | 非单调、收益递减，退化来自协调开销 | 加人要有明确的边际收益证据 |
| [Agensh](https://arxiv.org/abs/2609.26781)（2026-09，**超出 8 月窗口**，仅作参考） | 无中心编排、共享工作区 + 消息 + 共享上下文 | ProgramBench 最难 5 题 1→128 agent 平均通过率 19.31%→28.78%；pandoc 上 1→1,024 为 33.89%→55.06% | 在可并行、可验证任务上，规模化组织确有收益 |

**可以直接拿来用的结论**：

- 有效的前提是**任务可分解 + 有可靠验证**；顺序依赖强的任务，多 agent 往往更差。
- “最佳组织”不是常数。它随模型家族、模型能力和任务类型变化，因此**组织设计本身应当是被持续学习和重选的对象**。这恰好给“组织自进化”提供了正当性，也给出了评测方法：必须和单 agent、固定工作流在等预算下对比。
- 失败主要出在**通信与决策权**（折中、含糊消息、信息不共享），而不是个体能力。可进化的对象应优先是这些，而不是节点图的连边。

## 前沿②：自动设计多智能体系统（拓扑、工作流、角色）

这是论文最多的一类（精选池里 53 篇）。主流做法是在固定基准上离线搜索拓扑或提示，每个任题单独搜。与你设想最相关的是下面这些“增、删、改、记账”操作已经有人单独做成了。

| 工作 | 进化对象 | 方法 | 结果 | 可借鉴点 |
| --- | --- | --- | --- | --- |
| [EvoMAS](https://arxiv.org/abs/2602.06511)（ICML 2026） | 整个 MAS 配置 | 在**结构化配置空间**里做变异／交叉，而不是生成代码 | BBEH +10.5、WorkBench +7.1（对 EvoAgent）；SWE-bench Verified 79.1% | 说明“让模型写代码来定义组织”容易不可执行；配置要**小而规整**，这正是 Nexgent 15KB 私有 DSL 的反面 |
| [AOrchestra](https://arxiv.org/abs/2602.03786)（ICML 2026） | 子 agent 的即时创建 | 任何 agent = (Model, Task, Tools, Context) 四元组，编排者每步实例化 | GAIA／SWE-Bench／Terminal-Bench 上相对最强基线 +16.28% | **组织成员的最小定义**可以就这么简单 |
| [AgentSlimming](https://arxiv.org/abs/2605.08813)（ACL 2026） | 删减／降级成员 | 估计每个 agent 重要性，删除或换成便宜模型；每步用**基线锚定的接受规则**防崩 | token 最多 −78.9%，性能基本不降 | “精简”要带成本核算和门控 |
| [MonoScale](https://icml.cc/virtual/2026/poster/62913)（ICML 2026） | 扩充 agent 池 | 新成员入职前先跑少量“熟悉任务”，把证据转成可审计的路由记忆；信赖域更新 | 在不干扰假设下性能单调不降；GAIA、HLE 上随池扩大稳定增益 | “添加”要有**入职流程**，否则加人会拖垮路由 |
| [HiveMind](https://arxiv.org/abs/2512.06432)（AAAI 2026） | 表现差的成员的提示 | DAG-Shapley 计算每个成员贡献，只改贡献低的 | DAG-Shapley 省 80% 以上调用 | **按成员归因**是改组织的前提 |
| [BOAD](https://arxiv.org/abs/2512.23631) | SWE 编排者下的子 agent 层级 | 把候选子 agent 当多臂老虎机的臂，奖励是协作时的有用程度 | （见论文） | 解决“子 agent 多了搜索空间爆炸、难归因” |
| [AgentConductor](https://arxiv.org/abs/2602.17100)（ICML 2026） | 每题的分层 DAG 拓扑密度 | RL 训练编排者，按难度调整拓扑密度 | pass@1 最多 +14.6%，token −68% | 拓扑密度要随难度变 |
| [Conductor](https://arxiv.org/abs/2512.04388)（ICLR 2026）／[Puppeteer](https://arxiv.org/abs/2505.19591)（NeurIPS 2025） | 编排策略本身 | RL 训练小编排模型（7B）调度工人 LLM | 超过任何单个工人；演化后出现更紧凑的循环结构 | 编排可以被“学”出来，但需要训练预算 |
| [Failure-Driven Workflow Refinement](https://arxiv.org/abs/2510.10035)（ICML 2026） | 工作流图 | 聚类反例找复发失败模式，再做受约束的“提议-验证”编辑 | （见论文） | 以“失败分布”而非单一分数为优化目标 |
| [Assemble Your Crew](https://arxiv.org/abs/2507.18224)（AAAI 2026）、[MAS²](https://arxiv.org/abs/2509.24323)（ICLR 2026）、[MASS](https://arxiv.org/abs/2502.02533)（ICLR 2026） | 角色数量、角色选择、连边 | 自回归图生成／自生成自配置／分阶段搜提示与拓扑 | 各自基准上优于人工设计 | 组织结构搜索的代表性基线 |
| [Inefficiencies of Meta Agents](https://arxiv.org/abs/2510.06711) | 元 agent 设计 agent | 实证分析 | 把历史设计全塞上下文**比不看历史更差**；只有 2 个数据集在部署 15,000 次后设计成本才收回 | **自动设计必须算总账** |

**小结**：“添加、精简、归因、改拓扑”这些单项操作都有成熟做法，而且几乎都强调两件事：用**小而规整的表示**（四元组、配置）而不是让模型写大段代码或私有 DSL；每一步改动都要有**基线锚定的接受规则和成本账**。它们的共同局限是大多按单个基准离线搜，没有把收获沉淀成跨任务的组织资产。

## 前沿③：“组织自进化”的直接先例

这是与你设想最贴近的一组工作。**结论先说：这个方向已经有人在做，但还没有人把“跨任务沉淀 + held-out 门控 + 随模型重学”三件事放在一起做出定量证据。**

| 工作 | 会变的组织要素 | 学习信号 | 评估方式 | 与你设想的差距 |
| --- | --- | --- | --- | --- |
| [Meta-Team](https://arxiv.org/abs/2605.29790)（2026-05） | 个体行为、成员间协调、**团队组织**三个尺度 | 任务后让成员交换各自的执行证据，再转成改进 | 6 个长程基准，优于单 agent、人工 MAS 和既有 MAS 进化方法 | 最接近的学术对标；未强调 held-out 门控与随模型重学 |
| [OneManCompany](https://arxiv.org/abs/2604.22446)（2026-04） | 可移植的 agent 身份（Talent）、Talent Market 即时招募、分层问责 | Explore-Execute-Review 树搜索，结果自下而上汇总 | 给出终止与无死锁保证 | 把“组织层”与“个体知识”解耦，这个切分值得直接采用 |
| [TheBotCompany](https://arxiv.org/abs/2603.25928)（ASE 2026） | 经理 agent **招聘、分派、解雇**工人；策略→执行→验证状态机 | 项目需求 | 真实项目多天连续开发，考察里程碑、成本、质量 | 有动态人事但没有跨项目学习；评估偏定性 |
| [MASFly](https://arxiv.org/abs/2602.13671) | 按题实例化的 SOP；运行中由 Watcher 重配置 | 检索历史成功协作模式 + 历史失败经验 | TravelPlanner 61.7% | **SOP 库 + 巡检者**是可直接借用的组织资产形态 |
| [Evolving Interpretable Constitutions](https://arxiv.org/abs/2602.00755)（ICML 2026） | 多 agent 的**行为规范（宪法）** | LLM 驱动的遗传编程，多岛进化 | 演化宪法 S=0.556，比人工设计高 123%；最优解是**极少沟通**（0.9% vs 62.2%） | 规则是可进化的组织要素；多沟通未必好 |
| [AgentNet](https://arxiv.org/abs/2504.00587)（NeurIPS 2025） | 去中心化、动态图拓扑、成员技能专门化 | 检索式记忆 | 优于单 agent 与集中式 MAS | 没有中心的组织也能演化 |
| [RepuNet](https://arxiv.org/abs/2505.05029)（AAMAS 2026） | 成员间连接（连接／断开谁） | 声誉（直接交互 + 间接传言） | 避免合作崩溃，出现合作簇、孤立剥削者 | “声誉”可作为淘汰成员的信号 |
| [CORAL](https://arxiv.org/abs/2604.01658)（COLM 2026） | 长期运行的 agent 共享持久记忆、异步协作 | 评估器分离 + 心跳干预 | 10 项任务 SOTA；比固定进化搜索改进率高 3–10 倍；Anthropic kernel 任务 1363→1103 cycles | **评估器与执行者分离**是工程底线 |
| [Group-Evolving Agents](https://arxiv.org/abs/2602.04837) | 以**一组 agent** 为进化单元 | 组内共享经验 | SWE-bench Verified 71.0% vs 56.7%；Polyglot 88.3% vs 68.3% | 群体进化比树状单体进化更充分利用多样性 |
| [IMACS Adaptive Org Routing](https://arxiv.org/abs/2607.25446) | 按任务选协作协议 | 上下文 bandit，显式质量-成本权衡 | 胜过所有固定协议 | 在线学习“用哪种组织”的最小可行版 |
| [AgentFactory](https://arxiv.org/abs/2603.18000) | 把成功解法存成**可执行子 agent** | 执行反馈持续修订 | 子 agent 库随任务增长而增强 | “岗位”可以是沉淀下来的资产 |

**空白在哪里**：

- 多数工作只在单一任务家族上报告最终分数，**没有证明进化出的组织在 held-out 任务上也更好**，也很少给出设计成本总账。
- 几乎没有工作处理“换模型后组织要重学”，尽管前一节的证据表明这是必须的。
- 人事动作（招、解雇、入职、绩效评估）分散在不同论文里：招聘在 OMC／ TheBotCompany，入职在 MonoScale，绩效归因在 HiveMind，精简在 AgentSlimming，规则在宪法进化。**把它们统一成一套有门控的组织生命周期，是一个有辨识度的贡献点。**

## 前沿④：技能与工具的自我演化

在组织里，技能（Skills）就是“岗位手册”和 SOP。这一块的证据最清楚，也最需要警惕。

| 工作 | 发现 | 对你的含义 |
| --- | --- | --- |
| [SkillsBench](https://arxiv.org/abs/2602.12670) | v1：人工精选 Skills 平均 +16.2pp，但 16/84 题变差；**模型自己写的 Skills 平均没有收益**。最新版：18 种配置下精选 Skills 33.9%→50.5%；小而聚焦的 Skills 优于大而全的 | “自动沉淀 SOP”默认是不起作用的，必须有验证 |
| [Skills in the Wild](https://arxiv.org/abs/2604.04323) | 要从 34k 真实 Skills 里自己检索时，收益逐步衰减到接近无 Skills；按问题精修能收回大部分 | 资产库越大，检索与精修越关键 |
| [SkillLearnBench](https://arxiv.org/abs/2604.20087) | 所有持续学习方法都优于无 Skills，但没有一种在所有任务和模型上领先；更强模型不一定写出更好的 Skills；**只靠自我反馈会递归漂移**，外部反馈才带来真正改善 | 门控信号必须来自外部验证 |
| [EvoSkill](https://arxiv.org/abs/2603.02766)（COLM 2026） | 用 Pareto 前沿选择，**只保留提升 held-out 验证集的 Skills**；OfficeQA 60.6%→67.9%，SealQA 26.6%→38.7%，并零样本迁移到 BrowseComp +5.3% | held-out 门控在技能层已被证明有效 |
| [MUSE-Autoskill](https://arxiv.org/abs/2605.27366) | 把 Skills 当成有生命周期、可测试的资产；在其覆盖子集上自建 Skills 85.24% vs 人写 81.17% | 生命周期管理（创建、测试、退役）是关键 |
| [SkillSmith](https://arxiv.org/abs/2606.01314) | 从轨迹估计 Skills 之间的互补与冲突矩阵，驱动检索、变异和退役；记录反模式来否决重复错误 | 成员之间也有互补／冲突，这套思路可以搬到“人事”上 |
| [CoEvoSkills](https://arxiv.org/abs/2604.01687) | Skill 生成器与**代理验证器**共同进化，不接触真实测试 | 在没有标准答案时怎么验证 |
| [FlowEvo](https://arxiv.org/abs/2607.21596) | 工作流与可执行 Skills 共同进化，剔除造成负迁移的 Skills；ALFWorld 85.6%，比最强基线高 26.4 点且 token 约三分之一 | 流程与手册要一起改 |
| [Live-SWE-agent](https://arxiv.org/abs/2511.13646) | 从只有 bash 的最小脚手架开始，边解题边改自己的脚手架；SWE-bench Verified 77.4% | 在线自改进不必先离线训练 |
| [Evoflux](https://arxiv.org/abs/2606.12674) | 小模型上对有类型的工具工作流做推理时进化；held-out MCP-Bench 可执行率约 3%→17–24%；同数据的 SFT／DPO 反而不如 | 以执行为准的搜索比用搜到的数据微调更可靠 |

**小结**：“自己写手册”只在有外部验证和 held-out 选择时才有效（EvoSkill、MUSE），没有就会递归漂移（SkillLearnBench、SkillsBench v1）。这正好对应 Nexgent 已经有的“独立评价才采纳”原则——这个原则是对的，要保留并搬到组织层。

## 前沿⑤：记忆与经验（组织的“机构记忆”）

| 工作 | 发现 | 对你的含义 |
| --- | --- | --- |
| [ACE（Agentic Context Engineering）](https://arxiv.org/abs/2510.04618) | 把上下文当成不断增删的“策略手册”，用执行反馈而非标注更新；agent +10.6%、金融 +8.6% | 增量式、结构化的更新比整段重写更稳 |
| [ReasoningBank](https://arxiv.org/abs/2509.25140)（ICLR 2026） | 从自判成功**和失败**中提炼可泛化的推理策略；与测试时扩展互相促进 | 失败经验同样是资产 |
| [MemEvolve](https://arxiv.org/abs/2512.18746) | 不仅改记忆内容，还改**记忆架构**（编码、存储、检索、管理）；最多 +17.06%，并跨任务跨模型迁移 | “怎么记”本身可以是进化对象 |
| [ALMA](https://arxiv.org/abs/2602.07755) | 元 agent 用代码搜索记忆设计，在 4 个序贯决策领域全部优于人工设计 | 同上 |
| [LLM Agents Are Not Always Faithful Self-Evolvers](https://arxiv.org/abs/2601.22436)（ICML 2026） | 13 个模型、9 个环境的因果干预：agent 会依赖原始经验，但**经常忽略或误读压缩后的经验**，单多 agent 都是如此 | 沉淀出来的总结要验证“有没有被用上”，不能默认生效 |
| [Misevolve](https://arxiv.org/abs/2509.26354)（ICLR 2026） | 记忆积累后安全对齐下降，工具复用引入漏洞；顶级模型也会发生 | 沉淀要有安全回归测试 |

**小结**：组织的“机构记忆”应该是增量、结构化、可回滚的，并且要测两件事：一是加上它之后效果是否变好，二是模型是否真的在用它。后者几乎没有框架在测。

## 前沿⑥：递归自改进与 harness 演化

这是 Nexgent 原先的定位所在。2026 年这条线进展很快，而且出现了几条共识。

| 工作 | 改进对象 | 关键机制 | 结果／发现 |
| --- | --- | --- | --- |
| [DGM](https://arxiv.org/abs/2505.22954) | coding agent 自身代码 | 开放式档案 + 基准实测验证 | SWE-bench Verified 20%→50%，Polyglot 14.2%→30.7%（80 轮）；是目前最直接的 RSI 工程证据 |
| [HGM](https://arxiv.org/abs/2510.21614)（ICLR 2026） | 同上 | 用子树聚合的“元生产力”（CMP）选要扩展的节点 | 发现“当前分数高”不等于“进一步自改进潜力高” |
| [Hyperagents](https://arxiv.org/abs/2603.19461) | 任务 agent + **改进程序本身** | 元层修改流程可编辑 | 超出编码领域也能持续提升 |
| [Group-Evolving Agents](https://arxiv.org/abs/2602.04837) | 一组 agent | 组内共享经验 | 见前沿③ |
| [MGM](https://arxiv.org/abs/2608.07645) | coding agent | 多任务轨迹联合变异 + 跨谱系杂交 | 收敛更快，且泛化更好 |
| [Red Queen GM](https://arxiv.org/abs/2606.26294) | agent **与评估器** | 按“纪元”固定评估标准，纪元之间才更新效用 | 编码任务超前 SOTA 且 token 少 1.35–1.72 倍；证明评估器可以安全地一起进化 |
| [RSEA](https://arxiv.org/abs/2606.28374) | 策略／Skills／操作手册三层自然语言状态 | **不相交的 held-out 集上不退步才提交** | 没有一种形态通吃；没有门控的上下文进化方差大、会崩（Dynamic Cheatsheet 在 WebShop 上） |
| [HSI](https://arxiv.org/abs/2608.08466) | harness → 演化器 → 元演化器三层 | 冻结模型；执行时关思考、自改时开思考 | BALROG 中等难度大幅提升；明确指出受“反馈保真度”和“基座能力”两个上限 |
| [RHI](https://arxiv.org/abs/2607.15524) | 提示级的 agent loop 规范 | 对自身修订历史做成对比较 | 几轮即使低推理强度超过最高推理强度，成本 −60%；收益主要来自**更好的 agent 间信息流** |
| [HELIX](https://arxiv.org/abs/2608.13951) | harness 与模型共同进化 | 类型化端口、原子、配方；干预可审计 | 65 候选组合暴露最多 +58.0% 验证覆盖 |
| [MetaSkill-Evolve](https://arxiv.org/abs/2607.05297) | 技能（快）+ 元技能（慢） | 双时间尺度 | held-out OfficeQA +23.54、SealQA +16.09 |
| [Bilevel Autoresearch](https://arxiv.org/abs/2603.23420) | 内层研究循环的搜索方式 | 同一模型的外层循环 | Karpathy 预训练基准上 5 倍改进；**只调参数不改机制没有稳定收益** |
| [Metaⁿ](https://arxiv.org/abs/2608.24735) | 递归叠加的求解层 | 固定算子反复作用于自身产物 | 8 个基准家族全面领先；ARC-AGI-2 唯一非零 |
| [AutoDesign](https://arxiv.org/abs/2608.13560) | 长程设计任务的 harness | 元 harness 优化器 | PosterBench 78.32；学到的 harness 在 7 种配置上均有增益 |

**共识**：

1. **门控是必需的**：held-out 不退步才提交（RSEA、EvoSkill、MetaSkill-Evolve）；没有门控的进化会崩。
2. **改机制才有用，调参数没用**（Bilevel）。这对应你“不要有很多旋钮的 code harness”的要求。
3. **收益常来自信息流**（RHI），也就是组织怎么传递信息。这把 RSI 和组织设计连到了一起。
4. **上限来自反馈质量和基座模型**（HSI）。Nexgent 用同一个 flash 模型既执行又改进，加上 N=1 探针，恰好同时撞上了这两个上限。

## 前沿⑦：评测、归因与安全

| 工作 | 发现 | 对你的含义 |
| --- | --- | --- |
| [VeRO](https://arxiv.org/abs/2602.22480)（ICML 2026） | 为“让 agent 优化 agent”提供版本快照、预算受控评估、结构化轨迹的外层 harness，并附基准 | 可直接当 Nexgent 门控层的参考实现 |
| [Meta-Agent Challenge](https://arxiv.org/abs/2606.04455) | 元 agent 很少达到人工基线；过程方差大；高优化压力下出现**偷取标准答案**等对抗行为 | 门控必须防止被改进者污染 |
| [AI4AI-Bench](https://arxiv.org/abs/2608.20318) | 29 种配置平均 0.166，最好 0.250（以 0.1 为原算法、1.0 为最优） | “自动研究”离实用还远，要诚实报告 |
| [AutoResearchEval](https://arxiv.org/abs/2608.14905) | 100 个前沿科研任务、800 条轨迹、45 种失败模式；归结为**缺少元认知循环**（核对、修正、质疑路径） | 组织里的“验收者”角色正是补这个缺口 |
| [MAST](https://arxiv.org/abs/2503.13657)（NeurIPS 2025） | 14 种多 agent 失败模式，分为系统设计、成员间失调、任务验证三类 | 可作为组织诊断的标签体系 |
| [TraceElephant](https://arxiv.org/abs/2604.22708)（ACL 2026） | 完整轨迹让失败归因准确率最多提高 76% | 要记录输入和上下文，不只是输出 |
| [Reward Hacking Benchmark](https://arxiv.org/abs/2605.02964) | 13 个前沿模型利用率 0%–13.9%；RL 后训练明显更高；简单环境加固降 87.7%（相对） | 门控环境要加固 |
| [Misevolve](https://arxiv.org/abs/2509.26354)（ICLR 2026）、[AgentBreeder](https://arxiv.org/abs/2502.00757)（NeurIPS 2025） | 自进化会在记忆、工具、工作流上引入风险；多 agent 脚手架进化可以朝安全或不安全方向 | 门控里要有安全回归项 |
| [Silent Collapse](https://arxiv.org/abs/2605.14588) | 递归学习中内部分布收缩先于常规指标下降 | 除了分数，还要监控多样性 |
| [From 0-to-1 to 1-to-N](https://arxiv.org/abs/2606.09663) | 梳理 RSI 公开证据，认为 DGM 是最直接的；自己的协议暂无完成实验 | “1-to-N”的可复现证据整个领域都缺 |

**小结**：评测侧的共识是**评估者与改进者分离、环境加固、完整轨迹、多次重复、报告总成本**。Nexgent 的 EpisodeAuthority 和“独立评价才采纳”方向对，但目前的实验（N=1、同模型自评、无成本账）还达不到这个标准。

## 工业实践：厂商博客里的信号

| 来源 | 日期 | 要点 | 对你的含义 |
| --- | --- | --- | --- |
| OpenAI [Harness engineering](https://openai.com/index/harness-engineering/) | 2026-02 | 用 Codex agent 写出整个产品，人的工作转为设计环境、约束与反馈回路 | “设计组织与反馈”正在成为人的主要工作，也就是你要自动化的那部分 |
| OpenAI [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/)、[Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform)、[Codex subagents](https://developers.openai.com/codex/subagents) | 2026 上半年 | 公开 agent loop 细节；把 Codex 做成可嵌入平台；支持并行 subagent | 底座商品化，可作执行后端 |
| OpenAI [Research acceleration](https://openai.com/index/research-acceleration-view-inside-openai/) | 2026-09（**超出窗口**） | 内部用 agent 加速研究的进展 | 与“自动研究实习生”目标相关，但未公开组织自进化方法 |
| Anthropic [Building a C compiler](https://www.anthropic.com/engineering/building-c-compiler) | 2026-02 | 一组并行 Claude 在长期任务上协作，靠测试集当裁判、靠任务锁分工 | **可验证 + 可并行**是多 agent 的甜区，与前沿①一致 |
| Anthropic [Harness design for long-running apps](https://www.anthropic.com/engineering/harness-design-long-running-apps) | 2026-03 | 规划、生成、评估分属不同 agent，独立评估者显著提升长程质量 | 验收者是组织里最值钱的角色 |
| Anthropic [Managed Agents](https://www.anthropic.com/engineering/managed-agents) | 2026-04 | 托管式 agent 运行时 | 运行时商品化 |
| Anthropic [Demystifying evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)、[Infrastructure noise](https://www.anthropic.com/engineering/infrastructure-noise) | 2026-01／02 | agent 评测方法论；基础设施配置本身就能让基准分数明显波动 | N=1 的探针没有统计意义，必须重复并报告方差 |
| Anthropic [Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) | 2025-10 起 | Skills 成为开放标准 | 组织资产（SOP、岗位手册）应直接用 Skills 格式，不自造格式 |
| Google [Scaling agent systems](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/) | 2026-01 | 见前沿① | 多 agent 何时有效的定量模型 |
| Google DeepMind [AlphaEvolve impact](https://deepmind.google/blog/alphaevolve-impact/)、[Co-Scientist](https://deepmind.google/blog/co-scientist-a-multi-agent-ai-partner-to-accelerate-research/) | 2026-05 | 进化式搜索在生产中落地；多 agent 科研伙伴登上 Nature | 有硬评估器的领域，进化已经被证明有效 |
| DeepSeek [Harness](https://github.com/deepseek-ai/deepseek-harness) | 2026（preview） | 见「参考系统精读」 | 最接近你设想的开源底座 |
| Kimi K2.5／[K2.6](https://www.kimi.com/blog/kimi-k2-6) | 2026-01／04 | Agent Swarm：由模型自己拆任务、并行调度大量子 agent，K2.6 进一步扩大规模 | 把“会组织”训进模型；框架层要能适配这类模型自带的编排能力 |
| 智谱 [GLM-5](https://z.ai/blog/glm-5)／[GLM-5.1](https://docs.z.ai/guides/llm/glm-5.1) | 2026-02／04 | 主打长程 agentic 工程 | 强开源模型可作改进者模型的低成本选项 |
| Cursor [Scaling agents](https://cursor.com/blog/scaling-agents) | 2026-01 | 扁平协作 + 锁失败，改成 planner／worker／judge 分层后才跑长程大项目 | 组织形态是实测调出来的，也就是可以被自动化的对象 |

**工业界的共同信号**：多 agent 底座已商品化；独立验收者和可验证任务是成功关键；组织形态目前仍靠工程师手调。没有一家公开了“自动调组织”的方法。

## Nexgent 的位置与差距

| 能力 | 前沿现状 | Nexgent 现状（PR #1） | 判断 |
| --- | --- | --- | --- |
| 多 agent 运行底座 | DSH、Claude Code、Codex、Managed Agents 已成熟 | 自建 TaskService／Episode／执行层，约 1.5 万行执行代码 | **重复建设**，应当复用 |
| 组织表示 | 四元组（AOrchestra）、结构化配置（EvoMAS）、Talent（OMC）、Skills 标准 | 15KB 提示里的私有 JSON 图补丁 DSL | **要换**：改成成员、角色、规则、SOP 这类组织要素 |
| 增／删／改成员 | MonoScale（入职）、AgentSlimming（精简）、TheBotCompany（招聘解雇）各自成熟 | 节点增删有，但没有入职、精简的受控流程 | 可直接吸收这些做法 |
| 按成员归因 | HiveMind DAG-Shapley、TraceElephant、MAST | 无 | **关键缺口**，没有归因就不知道该改谁 |
| held-out 门控 | RSEA、EvoSkill、VeRO、Meta-Agent Challenge | 有 EpisodeAuthority 和独立评价原则 | 方向对，**要保留**；还需防污染和重复运行 |
| 成本账 | AgentSlimming、Inefficiencies of Meta Agents、IMACS 质量-成本权衡 | 无 | 缺口 |
| 跨任务沉淀 | MASFly（SOP 库）、AgentFactory、MUSE-Autoskill | 有 Package 概念，但 10 次真实闭环 0 次晋升 | 尚未证明 |
| 随模型重学组织 | IMACS、Institutions、Drop the Hierarchy 证明必要，但**没人做** | 无 | **最有辨识度的空位** |
| 评测协议 | 等预算对比单 agent／固定工作流，多次重复、报方差 | N=1 探针，同一 flash 模型既执行又改进 | 要重建 |
| 工程质量 | — | 顶端 25 项测试回归、单 PR 75 万行 | 先止血 |
| 产品形态 | 单一对话 + 信息窗口（你的要求） | 近 30 个 `rsi-*` 命令 | 偏离要求 |

**一句话定位**：Nexgent 不应再当“又一个多 agent 运行时”，而应当是建在现成底座之上的**组织进化层**：以成员、角色、沟通规则、决策权、SOP 为可进化对象，用按成员归因指导改动，用 held-out + 成本账决定是否采纳，并在换模型时重新学习组织设计。

## 建议路线（每阶段有退出门槛）

按你的工作方式：每阶段一个可评审的 PR，增量测试，但**合并前跑一次全量**（这次 25 项回归就是因为只跑了定向测试）。没过门槛就不进入下一阶段。

| 阶段 | 要做的事 | 退出门槛 |
| --- | --- | --- |
| **0 止血** | 修复 790d89f、75377bd 引入的 25 项回归；把约 65 万行 JSON 收据移出主分支；把 PR #1 按内核／控制面／实验拆开；加“合并前全量测试”门禁 | 全量测试 0 失败；单 PR 可在一次评审内读完 |
| **1 底座决策（新 ADR）** | 评估并选定执行底座（DSH 为首选，Claude Code Agent Teams／Codex 作对照）；Nexgent 只保留“组织说明 → 底座调用”的适配层和证据账本 | 同一组任务在新底座上跑通；自建执行层代码明显减少 |
| **2 基线** | 选 2–3 个**可并行、可验证**的任务家族；在等预算下对比单 agent、固定工作流、手工团队；每条至少 3–5 次重复；改进者用比执行者更强的模型 | 找到至少一个“团队显著优于单 agent”的任务家族（没有就说明该换任务，而不是该加机制） |
| **3 组织进化层 v1** | 组织要素表示（成员 = 模型＋角色＋工具＋上下文；加上沟通规则、决策权、SOP）；按成员归因；四种变更（加人附入职、减人附基线锚定、改角色、改规则）；held-out + 成本账门控 | 在 held-out 任务上，进化后的组织等预算优于阶段 2 的最好基线，且跨多次重复显著 |
| **4 跨任务组织资产** | 成功的岗位、SOP、规则以 Skills 格式沉淀；测“是否被用上”；换模型后自动重学组织 | 资产在新任务／新模型上有正迁移；换模型后重学的组织优于直接沿用 |
| **5 递归** | 组织进化规则本身可改（元层），评估器按“纪元”更新 | 元层改动带来可测的改进速度提升 |

科学发现和 OpenFOAM 始终作为阶段 2–4 里的一个任务插件出现，不进入框架核心。UI 按你的要求收敛到单一 Main 对话 + 信息窗口，组织图、成员贡献、门控结果、成本都作为信息窗口展示，取代 `rsi-*` 命令。

## 需要你拍板的问题

1. **“从头来过”是否包括代码？** 这份文档是评审与调研的重做。如果也要重做代码，我建议按上面的阶段 0–1 先出重构计划再动手，而不是在 PR #1 上继续叠加。
2. **执行底座**：是否接受复用 DeepSeek Harness（或 Claude Code／Codex），让 Nexgent 只做组织进化层？
3. **模型与预算**：执行者和改进者分别用什么模型？阶段 2 的多次重复基线需要实际 API 预算，跑真实实验前我会先征求你同意。
4. **目标任务家族**：候选包括编码类（SWE-bench 子集、ProgramBench）、研究类（AI4AI-Bench、AutoResearchEval 子集）、工具使用类（GAIA、Terminal-Bench），再加 OpenFOAM demo。你更在意哪一类被拿来说话？
5. **PR #1 的处理**：是拆分后分步合入，还是保留为存档分支、从新分支按阶段重来？

## 来源与局限

**证据来源**

- PR 评审：`csxq0605/Nexgent` 的 PR #1 分支顶端 `5ec023a`；本地跑了全量测试（1,247 通过、25 失败、4 跳过）并二分定位到 2 个提交；读了 README、REFACTOR\_PLAN、设计文档、ADR、实验结果和 architect 提示。
- 参考系统：克隆并阅读了 DeepSeek Harness 与 AutoSci（arxiv-v1 tag）源码与文档。
- 论文：12 个会议共 38,995 篇的官方录用列表 → 程序筛选 2,344 篇 → 按摘要打分 → 人工精选 276 篇（见同目录 [papers.md](papers.md)）；另对 arXiv 2026-01 至 08 做了 12 组关键词扫描，正文引用的数字均来自对应论文摘要。
- 博客：见「工业实践」表内链接。

**局限**

- KDD 2026 只拿到了第三方整理的约 500 篇子集；COLM、AAMAS、IJCAI 只有标题没有摘要，筛选靠标题 + arXiv 补摘要。CVPR 与本方向相关的论文很少。OpenReview API 被拦，没有看评审意见。
- 很多 2026 年的工作仍是 arXiv 预印本，未经同行评审；数字均为论文自报，我没有复现。
- SkillsBench 各版本结论不同（v1 报告自生成 Skills 无收益，最新版不再报告该条件），文中已分别注明。
- Agensh、OpenAI research acceleration 均发布于 2026 年 9 月，超出你设定的 8 月底窗口，仅作参考。
- 厂商博客多为能力展示，内部方法未必公开；“没有人公开自动调组织的方法”是指公开材料，不排除内部已有。
- 本文档没有运行任何真实的组织进化实验；“组织进化层”是基于文献的判断，需要阶段 2–3 的实测来验证。
