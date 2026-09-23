# ADR 001：以 Python Episode 内核作为 Nexgent 的生产执行边界

日期：2026-09-24。状态：**已决策；B–G 实现与 RSI 效果仍待验证。** 关联[重构计划](../../REFACTOR_PLAN.md)、[固定源码对照](../research/kernel-reference-audit-20260923.md)、[两路线实验与失败记录](../../experiments/kernel_spike/RESULTS.md)及[任务中能力授权合同](task-time-capability-authority.md)。

## 决策

保留 Python `TaskService`／`EpisodeStore` 为唯一生产任务执行与控制边界，在其上抽取有版本的服务、provider、能力实例、执行循环和上下文策略接口。`TaskService` 的既有入口作为兼容 facade，Episode 持有权限、模型和工具调用前准入、预算、结果、恢复与独立评价的权威身份。工具／服务插件与执行程序通过作用域和版本合同接入，不另建第二套任务账本。

[DeepSeek Harness 固定提交](https://github.com/deepseek-ai/deepseek-harness/tree/46a7f68b0922371ce7144b668b90e377d8e799f4)及 Cordis 保留为服务／provider／模型工具分层、Agent 作用域、disposer、session 事件及可替换 loop 的源码参考和对照实验后端，**不**作为当前 Nexgent 生产执行后端。此选择不是断言 Python 现有插件体系更完整，也不是断言 DeepSeek 的真实模型路线永远不可用。

## 实测依据

| 判据 | Python TaskService 路线 | 固定 DeepSeek Harness 路线 |
| --- | --- | --- |
| 同一真实模型任务的权威账本 | `mimo-v2.6-flash` 在同一 Episode 完成两次 JSON ask、一次已安装工具调用、结果工件和预算记录；新增租约模式的同题实测包含创建后挂载与完成后释放，原始 SQLite 可重开核对 | 第一次 MiMo 原生 tool call 和结果 42 持久化；第二次响应未形成约定 JSON final，整轮未交付；其执行从未进入 Nexgent 事前准入／计费 |
| 作用域和版本 | 已安装工具的 Episode 租约、活动 inventory、handler 身份声明、effect／预算检查、释放、委派收窄与重启漂移拒绝有定向证据；尚无模型新建能力名或服务插件 | Agent 作用域工具处理器注册／释放、兄弟 Agent 不可见有固定 adapter 运行证据；profile 插件在进程启动前加载，非任务中新插件安装 |
| 恢复和外部操作 | 既有 Episode RPC 对完成结果复用、未知操作禁止自动重发；租约薄片验证已完成结果释放后可复用，尚无新插件外部副作用对账 | 两组 Windows 进程终止实验中，固定 adapter 对已持久结果不重发、未知结果报告 `TOOL_OUTCOME_UNKNOWN`；不证明任意真实模型 exactly-once 或外部业务对账 |
| 评价与历史兼容 | 普通任务和 benchmark 已共用 Episode、工件及评价入口；仍需把新 Definition／Instance 身份接入候选与研究执行器 | 独立 Nexgent 诊断 Episode 仅评价外部收据内部一致性，原 DeepSeek 任务未获 Nexgent 事前授权、预算、恢复或任务质量评分；历史研究与产品控制面需生产桥接 |
| 当前迁移负担 | 在已有 Python 核心上抽离多处直接依赖，构建插件生命周期和隔离运行环境，工作量实际且尚未完成 | 需要跨语言事前准入线性化、session／Episode／调用 ID 映射、结果和成本结算、可信完成、未知结果对账、评价来源、Python O/S/M/R 与 benchmark 迁移，并维持 Node/pnpm 上游版本；当前没有通过这些门槛的桥 |

DeepSeek 的原生模型工具调用是当前 Python JSON 交互所缺少的能力；它的 Agent 作用域和可替换服务也更成熟。这些优点成为 B–D 的接口要求。选择 Python 的决定来自**已运行的权威 Episode 链**以及避免在尚无可信生产桥接时维护两个任务内核，而不是以现有代码量、测试数量或某个 demo 的成功代替架构判断。

## 安全与证据边界

两条路线都未证明模型生成插件的安全隔离。Python `package_worker` 是受限语言／审计 worker，不是 OS 容器；现有 `handler_digest` 是受信 provider 声明，尚非装载字节的独立测量。DeepSeek Agent scope 控制处理器可见性和生命周期，不能当作 OS 沙箱，其诊断 profile 插件在宿主进程执行。外部调用与文件／进程／网络能力只能在实际验证对应运行环境后开放。

真实 MiMo＋租约实测的 `spike.multiply` 仍由宿主预写、在运行前挂载，模型没有自己实现它。一次正确答案不是跨任务收益；一次桥接诊断 `accepted/1.0` 只表示外部收据内部一致性。当前没有真实的工具／服务插件开发、采用后新任务复用或递归改进收益结论。

## 实施迁移清单与出口

1. **B：宿主授权与版本层。** 把冻结权限从候选工具名迁到 effect、具体操作、凭据句柄、资源和委派边界；保留旧 `capabilities` 为兼容的初始实例。定义内容寻址的 `CapabilityDefinition`、Episode `CapabilityInstance`、provider 生命周期及调用收据。装载时核对实际 bundle、入口、依赖和环境摘要，记录卸载清理。已提交的预安装工具租约只是底层过渡件。
2. **C：任务中自主开发。** 固定开发能力让模型提交新名工具和服务／策略插件的源码、接口、依赖及测试；先在受控 worker 构建／试装，更新当前任务 inventory，再实际调用或激活。首片仅允许 `local_compute` 与受控工件读取；真实文件、网络、进程和外部业务操作须有对应隔离及授权实测。无模型调用的构建测试不能替代真实自主开发。
3. **D：可替换执行。** 保留现有 DAG 与代码路径，但把 agent loop、planner、router、上下文选择和消息策略作为有版本的执行能力；同一 Episode/RPC／预算边界可运行直接、图或代码策略。参考 AutoSci 的技能／图更新及 ADAS/AFlow 的可执行程序／工作流搜索，但不把科研阶段或固定角色写进核心。
4. **E–F：采用和研究。** 普通任务反馈关联实际 Definition／Instance 调用，候选在冻结 evaluator 和资源规则下独立 selection／guard；新进程的新任务按自身授权解析 adopted release。比较固定、同资源单体、仅记忆和完整系统，并单独评估改进器后代效用。允许零或负结果。
5. **G：产品。** Main 与 benchmark 读取同一 Episode、能力版本、轨迹和候选状态；修复默认项目目录持久化，并以真实任务和证据展示，不用 OpenFOAM demo 充当框架验收。

若后续 DeepSeek 后端能以同一真实模型任务证明 Nexgent 的事前准入、成本结算、完成、恢复、独立评价和安全生命周期，并有可测的更低迁移负担，可重新提交 ADR。单独修复 final JSON 解码或再跑固定 adapter 不足以推翻本决策。
