# Nexgent 实现与目标／来源对照账本

日期：2026-09-24。每个阶段提交更新本表，按**目标合同 → 实际代码和运行收据 → 论文／参考源码的机制 → 未通过的出口**记录。状态只用“目标已定义”“实现中”“确定性通过”“真实任务通过”“独立效果通过”，不凭文件存在判完成。正式验收以[当前计划](../../REFACTOR_PLAN.md)各阶段出口为准；旧实验的成功与失败保留在[研究索引](README.md)。

| 阶段 | 目标与来源 | 当前实际证据 | 出口状态／下一项 |
| --- | --- | --- | --- |
| A 内核选型 | [同题小样](../../experiments/kernel_spike/CONTRACT.md)；[DeepSeek 架构](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/docs/architecture.md)服务／provider／工具分离 | [A1 固定源码对照](kernel-reference-audit-20260923.md)；[A2/A3 运行记录](../../experiments/kernel_spike/RESULTS.md)：Python 真实 MiMo 与已安装工具的任务级租约已在同一 Episode 完成，含挂载、预算、调用、交付和释放；委派约束与重启漂移拒绝另有确定性测试。DeepSeek Agent 作用域处理器通过，真实 MiMo 原生 tool call 与工具结果通过但 final JSON 解码失败；外部原执行未受 Nexgent 准入／计费。两组 Windows 固定 adapter 进程终止恢复通过 | [ADR 001](../design/adr-001-python-episode-kernel.md)选 Python Episode 单一生产边界；A 选型出口完成，负结果保留；真正任务中插件开发属于 C，未完成 |
| B 能力内核 | [固定 DeepSeek scoped registry 源码](kernel-reference-audit-20260923.md)、可替换 loop；[新名称授权合同](../design/task-time-capability-authority.md) | 已安装工具的 Episode 租约；冻结 EpisodeAuthority v1/v2、内容寻址 tool 与 `model_context.v1` service Definition、Episode-local Instance、动态 inventory、释放和重启身份核对。新增受信宿主 `ToolProvider v1` 注册与版本化 inventory：现有 TaskService 分发入口不变，替换后新任务调用新 provider；旧租约对版本／声明摘要漂移拒绝。定向并发快照验证清单不会混读两个版本。任务内工具和服务仍限无凭据、无外部依赖的受控 Python | B 的受信工具 provider 子接口通过定向测试，整体出口未过：尚无任务／会话作用域 provider 生命周期、调用排空、服务／执行策略统一接口、依赖安装解析或实际加载字节测量；上下文服务只改变模型 payload，不改变执行组织 |
| C 自主能力开发 | DeepSeek Creator 的发现／管理入口；通用工具与服务插件双对象 | [真实工具收据](../../experiments/kernel_spike/evidence-python-dynamic-tool-live-20260924.json)：空清单起步，模型写 `multiply_integers` 源码／schema，stage/mount、重新发现、调用返回 42；同一 Episode 模型 2 次、工具 1 次、7 节点。默认任务种子另有[真实服务收据](../../experiments/kernel_spike/evidence-python-service-seed-live-20260924.json)：模型写并激活 `comparison.criteria`，后续 3 次模型调用经过服务，5 次模型调用总计 11,889 prompt / 770 completion token、节点 15、零自动重试，交付 A。确定性任务另验证工具替换和服务释放／替换。**Main 界面仍采用另一图编排种子，未接入**。两次真实任务都在题目／实验合同中明确要求开发能力，没有测模型自主判断是否有必要开发 | **C1 工具与服务切片均有真实任务内开发使用证据**；C 完整出口未过：自主缺口判断、隔离测试反馈修复、外部依赖／操作、跨任务采用、独立效果与 RSI 净收益均未证明 |
| D 执行与编排 | [AutoSci 论文版本](https://github.com/skyllwt/AutoSci/tree/arxiv-v1)技能／图更新、[ADAS](https://arxiv.org/abs/2408.08435v2)代码 Agent、[AFlow](https://arxiv.org/abs/2410.10762v4)工作流搜索 | 既有真实模型完成 7 节点 DAG；确定性图执行验证任务内工具／服务开发。PackagePatch v4 的 DAG↔代码双向切换保留后端与激活身份检查。同包双 O 候选的真实 gateway 选择路径已绑定决策、模型调用、预算和实际后端；root 绝对截止时间贯穿恢复和各后端。D1-C 有反馈检查点、原子交接工件及同 Episode DAG→entry 运行路径，离线四条件预检通过。[D1-B 真实探针](../../experiments/strategy_selection/RESULTS.md)的主任务失败；[D1-C 首批探索性尝试](../../experiments/strategy_checkpoint/RESULTS.md)四行均在 base 草稿前提失败，selector 0 次，未到切换或恢复；合同运行时仍标草案 | D1-B/C 机制有确定性覆盖，但真实模型编排效果未获支持；D1-C 不能声称真实切换成功，也不能把探索性尝试称为预注册确认。D 整体出口未过：冻结对照与独立效果未证明；v4 生成器尚未产生切换候选 |
| E 持续进化 | AutoSci SciEvolve、Nexgent 候选／评价／guard 合同；[普通任务反馈进化合同](../design/ordinary-feedback-evolution-v1.md) | 图候选确定性采用复用；真实 O/S 未晋升、M abstain。一次 MiMo 编写的纯工具经配对、晋升、guard 后在新进程独立任务复用；父版因 JSON 协议失败，候选成本更高，采用链由实验程序启动。`context.feedback` 经事件链核验后只投影有界公开信号。新增宿主显式挂载的终态触发／持久 outbox，以及公开反馈到开发 Episode、候选路径选择和现有生成／采用服务分派的机制；止于 `candidate_ready`／弃权／拒绝，21 项反馈相关定向测试通过。Main／CLI 尚无默认策略源与后台 drain；默认 R0 无独立规划入口 | 单项跨任务继承机制有真实模型证据；自动开发仅有确定性机制，未进入产品默认路径或真实模型自主缺口判断。候选自动独立评价采用及多任务净收益未达 E 出口 |
| F 效果与递归 | [RHI](https://arxiv.org/abs/2607.15524v1)信息流、[HSI](https://arxiv.org/abs/2608.08466v1)三级更新及后代评价 | `TaskService.benchmark` 现在能接收宿主显式授权的 EpisodeAuthority，普通任务与 benchmark 共用 `create/run/_ask` 路径；确定性 benchmark 中服务开发、激活、模型调用和独立评价已纵向跑通，CLI 亦可传该授权。尚无正式多任务研究或真实跨任务净收益／递归收益 | benchmark 的能力开发入口确定性通过；未开始正式研究；先完成 C–E 实际路径与冻结对照协议 |
| G 产品 | Main 展示同一任务／版本／能力身份 | Main 保留 graph seed，以显式受限 v2 EpisodeAuthority 创建任务；新版本化 `nexgent-main-capabilities-v1` channel 避免静默覆盖旧 `nexgent-main` 登记；证据栏展示工具／服务 Definition、Instance 和服务应用身份，隐藏源码与模型 payload。界面仍是一次输入创建一个 Episode，未实现原任务多轮继续 | 最小能力证据视图确定性通过；尚未达到 Main 持久多轮、候选采用／回滚及产品出口 |

更新规则：每条新“已实现”要附代码和定向运行证据；“效果改善”另附独立任务、父子对照、成本与失败。上游参考固定 SHA／论文版本；确需升级时注明迁移影响。负结果和基础设施问题也追加，不删除前一次结论。子智能体审查、手写小样及模型替身均不能替代 Nexgent 产品的自动执行证据。

## 2026-09-24 Main 图执行实测与差距更新

[四次限额 MiMo 收据](../../experiments/kernel_spike/RESULTS.md)均未通过独立任务质量检查。真实模型能生成服务 Definition、图中的读工件／激活／模型节点；首次将工件 ID 当数据，第二次绑定带点的服务接口键失败，第三次服务抹掉模型输入却因交付 schema 泄露 A 而机械完成，第四次把绑定语法写成普通字符串并在激活时失败。第三次的服务确实作用于两次模型请求，但不构成任务成功。已为普通 Main 图加路径安全的服务状态投影、提示读工件并保留原输入字段，给实验加独立事实检查，并让服务激活的参数错误在图编译时被拒绝；22 项相关定向测试通过。`nexgent-main-capabilities-v2` 是新基线 channel，旧 channel 身份不静默改写。

与 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的作用域服务相比，目前仍只有窄的 Python 上下文服务，没有通用 provider 生命周期。与 [AutoSci 论文版本](https://github.com/skyllwt/AutoSci/tree/arxiv-v1) 的 SciDAG／SciEvolve、[ADAS](https://arxiv.org/abs/2408.08435v2) 的可执行智能体搜索、[AFlow](https://arxiv.org/abs/2410.10762v4) 的图搜索相比，本轮只验证了生成图的执行和失败边界；**没有**反馈选择出的图版本、跨任务采用、同资源对照或改进收益。D/E/F 出口保持未通过。

E0 前置改动：`EvolutionService.plan_pair/plan_monitor` 新增宿主授予的冻结 `EpisodeAuthority` 和摘要；配对父子两臂、监控 Episode 均由该计划传入同一授权，benchmark 任务行不能自行提供授权。既有任务来源技能的选择／晋升／guard／新任务复用测试在有授权、无授权两种模式下均通过。这只解决未来能力候选的公平执行条件，未将动态工具／服务 Definition 放入可发布包，也未证明其调用激活或 RSI 收益。

E1 新增[惰性 CapabilityRelease v1](../design/capability-release-v1.md)及 11 项来源／篡改测试。它从源 Definition 验证并冻结纯能力的源码、schema、interface 和 creator 谱系，但不具备部署权；与 DeepSeek 的作用域实现不同，此对象预备进入 Nexgent 的候选选择链，与 AutoSci/ADAS/AFlow 的可遗传行为候选作机制对照。目前它尚未进入 AgentPackage、配对评价或新任务，E 出口仍未通过。

E2-A 将纯工具与 `model_context.v1` 服务列为 AgentPackage manifest v2 的 S 组件，PackagePatch v3 能声明对应新增／修改；Generation 与 Evolution 解析这些组件，并要求运行轨迹中同时有模块加载及组件激活收据。100 项定向测试通过。此处借鉴 [ADAS](https://arxiv.org/abs/2408.08435) 和 [AFlow](https://arxiv.org/abs/2410.10762) 的可执行候选思想，尚未证明候选在新任务实际运行、独立效果或晋升收益。下一步 E2-B 接入后续任务运行时，再做 E3 的任务来源候选与配对评价。

E2-B 将包内工具和 `model_context.v1` 服务接到新任务的实际执行路径：工具清单与工作流节点带冻结的 S 组件身份，调用受 schema／effect／root 预算约束；服务默认作用于后续模型输入，任务内有效服务可覆盖它。完成的工具调用或服务加后续完成的模型调用才生成 `execution.activated_components`，同时记录源码路径。六项新增用例和相邻旧路径合计 28 项通过，失败运行不产生激活。与 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) 的作用域服务借鉴在此是明确的包组件加运行收据；与 [AutoSci](https://arxiv.org/abs/2605.31468) 的跨项目版本化更新相比，E2-B 单独尚未验证任务来源候选的晋升和继承，也未证明效果。

E3-A 新增 `TaskCapabilityAdoptionService`：只有创建 Episode 实际成功使用过的 Definition，才可转换为惰性 Release／PackagePatch v3 候选；原始 Definition 保持 Episode origin 约束。工具与服务各自的确定性纵向用例均走通反馈冻结、候选生成、同预算独立配对、行为激活门、晋升、guard，以及重建 TaskService 后新 Episode 自动复用；未使用和陈旧版本被拒。4 项新测试通过，连同 E2 的激活／运行时共 12 项通过。这里把 [AutoSci](https://arxiv.org/abs/2605.31468) 的反馈到版本化能力，以及 [ADAS](https://arxiv.org/abs/2408.08435)／[AFlow](https://arxiv.org/abs/2410.10762) 的可执行候选评估接到 Nexgent 的通用任务包；但模型边界是确定性替身，且未验证单独 OS 进程、真实模型的增益或跨任务族迁移，因此不计作 E 出口和正向 RSI 结果。

E3-B [真实 MiMo 两次独立尝试](../../experiments/kernel_spike/RESULTS.md)：v1 是试验程序的提案包装解析失败；修订后的 v2 由模型写出通用纯工具，经一次独立 selection 晋升、guard，再由单独 OS 进程的新整数任务自动调用并留下组件激活证据。父版本 selection 的模型响应不是合法 JSON，候选额外的工具工作使归一化成本更高。这个结果填补了 DeepSeek 式任务内开发到 AutoSci 式版本化复用的**单个机制样本**，但不构成 ADAS/AFlow 所要求的跨任务搜索效果证据。当时 E 尚缺普通反馈自动触发，F 仍缺多任务族、对照重复及递归改进实验。

E3-B.2 将普通 Main／CLI 接到项目配置的持久反馈协调器：真实 R0 先看公开反馈与宿主候选收据，选择放弃、任务来源工具／服务／编排采用或通用包补丁，再由宿主独立配对、晋升、guard 与后续加载证据决定保留。这落实 [AutoSci](https://arxiv.org/abs/2605.31468) 的任务图／能力更新与 [ADAS](https://arxiv.org/abs/2408.08435)、[AFlow](https://arxiv.org/abs/2410.10762) 的可执行候选外层评价，但仍没有它们所需的多任务搜索收益证据。[首次真实普通入口收据](../../experiments/ordinary_feedback_live/RESULTS.md)到达独立 selection 并正确拒绝父、候选均失败的编排候选；未到 guard 和真实模型下一任务复用。成功采用／guard 回滚／复用目前只有确定性纵向测试。下一步先做同任务族的真实闭环，再作固定编排、等预算单智能体、仅记忆与完整系统对照。

[同任务族 READY 探针](../../experiments/ordinary_feedback_live/WORKBENCH_ALIGNED_RESULTS.md)仍为负：模型源任务的 DAG 在绑定 `result` 时失败，R0 将已归档但未完成的整图选为 `episode_os`，独立 Workbench selection 父、候选均为 0，宿主拒绝晋升。这说明 AutoSci 式图更新在 Nexgent 中不能等同“图已生成”：图必须先有可复用的运行证据，再允许直接采用；失败图应转入可证伪的修补路径。框架现已在候选目录和采用服务两层阻止失败整图原样进入候选。此修正未重新运行冻结探针；不重标旧负结果，也未证明修补能力有效。

[图绑定修复探针](../../experiments/ordinary_feedback_live/WORKBENCH_BINDING_REPAIR_RESULTS.md)将前述失败落成通用编译预检：静态工具的可信输出 schema 进入图编译，错误字段绑定在调用工具前拒绝并反馈给图修复；失败后结构化节点／路径诊断可安全投影到 R0。真实 MiMo 来源图发生两次编译拒绝和修图，越过旧 `inspect.result` 问题，却在交付占位 digest 失败。R0 只产出一个 `architect-role` 包补丁，独立 selection 父、候选又各自失败、均为 0，未晋升或复用。相对于 AutoSci 的 SciEvolve、AFlow 的多候选反馈搜索，此处仍缺评价失败驱动的开发期修复与候选竞争；不能用编译器修复或一个候选的存在声称持续进化。

[普通反馈到有界编排搜索探针](../../experiments/ordinary_feedback_live/WORKBENCH_SEARCH_FLOW_RESULTS.md)把 AutoSci／AFlow 式生成—开发反馈—修复结构接到真实 Main／CLI 来源。R0 真实选中 O 搜索，两个 MiMo 候选生成尝试都因补丁合同拒绝而终止，仍没有开发资格评价或独立 selection；这是明确的负结果。当前 repair brief 只有 `generation_PackageError` 等粗类，未携带宿主已知的安全 schema 路径。下一个机制改进是结构化补丁验证诊断及再次实测候选是否能到评价边界，而非宣称编排收益。

[固定错误码后机制复测](../../experiments/ordinary_feedback_live/WORKBENCH_SEARCH_REPAIR_RESULTS.md)首次让真实 MiMo 生成有效 O 候选，并用新的 development seed 14 运行父／候选配对；候选在执行前因不支持的 `ask` 参数失败，父版发布 schema 亦失败，第二次修复生成了无效工作流 JSON。新错误码路径在该次运行未触发，不能归因于其效果；重要的新证据是模型搜索已实际进入开发评价与反馈迭代，但仍没有 selection 资格或独立收益。对应 AutoSci／AFlow 的可执行候选搜索，现在需进一步把静态图可执行性和公开节点失败接入修复，而不是继续测候选数量。

[候选预检探针](../../experiments/ordinary_feedback_live/WORKBENCH_PREFLIGHT_RESULTS.md)没有触及预检：来源遇 DNS 解析失败且计量未知，两次生成都未形成候选。它揭示旧反馈入口错误地将基础设施故障当能力缺口，已在捕获前加状态与完整计量门。此结果仍不能证明候选预检的真实成本节省或搜索收益；后续试验必须先取得有效来源反馈。

E3-B.2 后续修复把开发配对中宿主已识别的候选工作流接口、工件 schema、模型 JSON 错误压缩为固定枚举，交给下一次修复；父臂或候选臂的基础设施失败直接终止资格证据。未知错误保持泛类，原始异常和私有评价不出宿主边界。41 项编排定向测试及 17 项生成修复测试通过。此处完善 AutoSci／AFlow 式搜索的反馈质量，但尚未产生合格候选、selection／guard 或新任务复用；真实收益仍待实跑。

[下一次真实普通任务探针](../../experiments/ordinary_feedback_live/WORKBENCH_CANDIDATE_REPAIR_RESULTS.md)由 R0 再次进入 O 搜索，但两次合法 O 补丁分别引入不支持的 `ask` binding 和无效根图字段，执行投影均未变。宿主正确拒绝空编排增量，但两个具体原因被折叠成同一错误码，造成修复信息丢失。现将静态图接口预检提前并识别无效根字段，提示语同步列出宿主实际支持的字段。此修复只由定向测试验证，真实调用仍停在 development 之前；与 AutoSci／AFlow 的有效图搜索相比仍缺合格图、独立 selection、guard 与复用收据。

[图预检机制探针](../../experiments/ordinary_feedback_live/WORKBENCH_GRAPH_PREFLIGHT_RESULTS.md)未到候选阶段：来源任务协议失败后，默认 R0 规划的 MiMo 响应虽有完整 JSON 对象，仍带尾随文本，严格网关拒绝并终止反馈工作。该探针不评价前述图预检。研究上这属于上游格式可靠性与成本问题；必须保持一次响应一次计费和完整对象合同，新的恢复机制也须记录调用与失败，不可事后从旧响应截取前缀宣布成功。自动选择、候选搜索、独立评价的真实稳定闭环仍待建立。

D1-A 已按[执行策略切换检查点](../design/adaptive-orchestration-switch-v1.md)落地：显式 PackagePatch v4 仅覆盖 entry↔workflow 切换，`activation_targets` 等于改动组件减去下线旧 orchestrator；v3 仍按旧相等合同。两方向候选均走真实 `TaskService` 后端和演化配对验证，篡改源码摘要、原生后端身份、空目标及夹带未激活组件会拒绝。`strategy_entered` 只记录入场尝试，完成态 `active_strategy` 才是激活证据。与 AutoSci SciDAG/SciEvolve、AFlow 代码工作流搜索、ADAS 程序化 Agent 候选的对照因此从“静态双后端”推进到“可检验切换补丁”；模型还不能在任务中生成或选择此切换，不能声称编排已自进化。

D1-B 前置采用真实默认开放循环代码和 Main DAG 组成单包双 O 候选，并把候选集合和模型决策拆成纯合同；候选来源、组件、后端及摘要只能由宿主填，模型只提交选择、依据、停止条件和可缺省成本估计。随后 `TaskService.run` 在冻结同包候选时通过真实 gateway 请求一次选择，把模型／预算收据及决策身份写为可恢复 Episode 事实，再分派到被选的真实后端；异常选择不静默回退，未知模型结果不自动重发。完成的策略必须留下 `active_strategy`，演化门对任意 O 目标都验证实际激活，不能只靠源码加载。集成与恢复的定向测试通过。root 绝对截止时间现已贯穿选择器、受控代码、图准入及恢复；未知已入场模型调用保持待核对。真实 MiMo D1-B 探针按预注册合同判负：两个主任务均失败，结构化三服务审查选成开放循环，H1–H4 均不通过。D1-C 增加确定性检查点、模型选择边界、同一 Episode 原子交接与恢复；生产 Main 图提案可声明检查点，默认开放循环先读取 handoff，宿主固定的 `StrategyStart` 保留来源而不伪造模型调用。[策略设计检查点](../design/adaptive-orchestration-switch-v1.md)仍将 AutoSci 图更新、AFlow／ADAS 外层搜索与 Nexgent 的中途交接分开。[D1-C 首批探索性尝试](../../experiments/strategy_checkpoint/RESULTS.md)四条件离线预检通过，但四个真实模型草稿均未通过 base-policy 前提，故未准入 selector；运行时合同仍标“草案；不得运行”，不能算正式预注册确认。接口与评分不一致须在新 READY 合同中先修正；真实中途切换与恢复仍未知，不能重标旧结果。
