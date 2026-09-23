# Nexgent 实现与目标／来源对照账本

日期：2026-09-24。每个阶段提交更新本表，按**目标合同 → 实际代码和运行收据 → 论文／参考源码的机制 → 未通过的出口**记录。状态只用“目标已定义”“实现中”“确定性通过”“真实任务通过”“独立效果通过”，不凭文件存在判完成。正式验收以[当前计划](../../REFACTOR_PLAN.md)各阶段出口为准；旧实验的成功与失败保留在[研究索引](README.md)。

| 阶段 | 目标与来源 | 当前实际证据 | 出口状态／下一项 |
| --- | --- | --- | --- |
| A 内核选型 | [同题小样](../../experiments/kernel_spike/CONTRACT.md)；[DeepSeek 架构](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/docs/architecture.md)服务／provider／工具分离 | [A1 固定源码对照](kernel-reference-audit-20260923.md)；[A2/A3 运行记录](../../experiments/kernel_spike/RESULTS.md)：Python 真实 MiMo 与已安装工具的任务级租约已在同一 Episode 完成，含挂载、预算、调用、交付和释放；委派约束与重启漂移拒绝另有确定性测试。DeepSeek Agent 作用域处理器通过，真实 MiMo 原生 tool call 与工具结果通过但 final JSON 解码失败；外部原执行未受 Nexgent 准入／计费。两组 Windows 固定 adapter 进程终止恢复通过 | [ADR 001](../design/adr-001-python-episode-kernel.md)选 Python Episode 单一生产边界；A 选型出口完成，负结果保留；真正任务中插件开发属于 C，未完成 |
| B 能力内核 | [固定 DeepSeek scoped registry 源码](kernel-reference-audit-20260923.md)、可替换 loop；[新名称授权合同](../design/task-time-capability-authority.md) | 已安装工具的 Episode 租约；冻结 EpisodeAuthority v1/v2、内容寻址 tool 与 `model_context.v1` service Definition、Episode-local Instance、动态 inventory、释放和重启身份核对。确定性纵向任务开发未知名称工具并调用；另有任务开发服务、激活、重启后在真实 `_ask` 边界执行上下文变换，收据绑定 Definition／Instance／Authority／worker。两类均限无凭据、无外部依赖的受控 Python；服务调用与工具调用共用 root `max_tool_calls`，每次 worker 限 20 万 trace 事件；尚未按实际 worker 指令数计入跨调用 work units | 工具与首个服务子路径确定性通过；B 整体出口未过：缺通用 provider/依赖解析、实际清理和可替换执行策略。此服务只改变模型可见 payload，不改变执行组织 |
| C 自主能力开发 | DeepSeek Creator 的发现／管理入口；通用工具与服务插件双对象 | [真实工具收据](../../experiments/kernel_spike/evidence-python-dynamic-tool-live-20260924.json)：空清单起步，模型写 `multiply_integers` 源码／schema，stage/mount、重新发现、调用返回 42；同一 Episode 模型 2 次、工具 1 次、7 节点。默认任务种子另有[真实服务收据](../../experiments/kernel_spike/evidence-python-service-seed-live-20260924.json)：模型写并激活 `comparison.criteria`，后续 3 次模型调用经过服务，5 次模型调用总计 11,889 prompt / 770 completion token、节点 15、零自动重试，交付 A。确定性任务另验证工具替换和服务释放／替换。**Main 界面仍采用另一图编排种子，未接入**。两次真实任务都在题目／实验合同中明确要求开发能力，没有测模型自主判断是否有必要开发 | **C1 工具与服务切片均有真实任务内开发使用证据**；C 完整出口未过：自主缺口判断、隔离测试反馈修复、外部依赖／操作、跨任务采用、独立效果与 RSI 净收益均未证明 |
| D 执行与编排 | [AutoSci 论文版本](https://github.com/skyllwt/AutoSci/tree/arxiv-v1)技能／图更新、[ADAS](https://arxiv.org/abs/2408.08435v2)代码 Agent、[AFlow](https://arxiv.org/abs/2410.10762v4)工作流搜索 | 既有真实模型完成 7 节点 DAG；新增确定性完整图执行分别验证 `develop_tool → 动态名称 tool → publish` 和 `develop_service → activate → 后续 ask → publish`，图编译无授权时拒绝；架构仍保留 architect／pending 修订。反馈后的第二版图与非 DAG 策略切换尚无真实任务证据 | 能力开发算子进入编排路径，尚未达 D 出口；需真实中途策略修改、非 DAG 后端及独立效果对照 |
| E 持续进化 | AutoSci SciEvolve、Nexgent 候选／评价／guard 合同 | 图候选确定性采用复用；真实 O/S 未晋升、M abstain | 未达新出口；需任务来源的工具／服务插件在独立任务采用和调用 |
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

E3-B [真实 MiMo 两次独立尝试](../../experiments/kernel_spike/RESULTS.md)：v1 是试验程序的提案包装解析失败；修订后的 v2 由模型写出通用纯工具，经一次独立 selection 晋升、guard，再由单独 OS 进程在新整数任务上自动调用并留下组件激活证据。父版本 selection 的模型响应不是合法 JSON，候选额外的工具工作使归一化成本更高。这个结果填补了 DeepSeek 式任务内开发到 AutoSci 式版本化复用的**单个机制样本**，但不构成 ADAS/AFlow 所要求的跨任务搜索效果证据。E 仍缺普通反馈自动触发，F 仍缺多任务族、对照重复及递归改进实验。
