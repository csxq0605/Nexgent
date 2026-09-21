# ExecutablePlan v1 与 AgentPackage manifest v2

日期：2026-09-21。本文描述提交 `a2bd721`、`f017f0d`、`0a7c60d`、`9c612c0` 与 `658e316` 落地后的当前合同和结论边界。

## 1. 位置与范围

Nexgent 是通用、可运行 benchmark 的反馈驱动 RSI 智能体框架。科学发现、OpenFOAM、Workbench 和 BBH 是解耦的 demo 或 benchmark 插件；它们可提供任务、工具、数据、运行环境和 evaluator，但不定义核心的 role、workflow、计划执行、修订、恢复或演化语义。

本纵切面解决一个工程断点：AgentPackage 中的角色、工作流和 O/M/S 分类此前可以作为文件或设计概念存在，却没有共同的强类型计划身份贯穿真实运行、修订与恢复。manifest v2 提供包内声明，`nexgent.executable-plan.v1` 提供执行合同，`TaskService` 将两者连接到实际能力调用和宿主账本。

它没有证明模型会设计更好的工作流、从反馈产生有效 component 变更或获得递归收益。

## 2. manifest v2：包内权威声明

manifest v2 保留 `execute` 和可选 `improve` entry，并增加四个必填注册项：

- `roles`：可选 prompt resource 与去重的核心 capability 列表；
- `workflows`：包内 JSON resource、输入/输出 JSON Schema 与可选并行上限；
- `components`：稳定 component id 到 `class`、`kind`、`ref` 的映射；
- `orchestrator`：指向一个 O 类 entry 或 workflow component。

component class 只能是 O（编排）、M（记忆策略/数据接口）或 S（技能与提示协议）；kind 只能是 role、workflow、skill、entry 或 resource。宿主验证所有引用存在、同一个 `(kind, ref)` 不重复注册、同一文件没有冲突分类。v2 child 不能降级成 v1；父子共同拥有的稳定 component id 不能改变 class、kind 或 ref。

这些规则给演化和审计提供权威身份，但当前 BehaviorPatch 仍以文件 path 为直接变更目标。由 stable component id 贯穿反馈、补丁和评价属于下一阶段。

## 3. ExecutablePlan v1：可执行图合同

当 manifest-v2 的 `execute` orchestrator 指向 workflow component 时，`TaskService` 加载不可变包内已注册 workflow，并在执行前编译成 `nexgent.executable-plan.v1`。计划包含：

- 具备内容身份的 node、operator、role/component 引用和局部上限；
- 分开的 control binding 与带 schema 引用的 artifact binding；
- v1 合同中的 `all`、`any` 或 `quorum` join policy；当前 workflow 编译器只产生 `all` / `any`；
- `route`、`retry`、`continue`、`fail_plan` 或 `partial_delivery` failure action；
- 显式 plan revision 和每个节点的不可变 attempt/artifact/failure receipt 引用。

局部上限只能收紧 root Episode budget。控制环中的每个节点必须声明迭代上限；重试必须声明足够的 attempt 上限。当前 workflow 编译器使用显式 bounded loop node，不接受任意 raw graph cycle。

运行前，宿主把 workflow 引用解析回同一冻结 manifest：`ask` 必须绑定已注册 role component，role 必须拥有所需 capability；`skill` 必须绑定包内已注册 skill component；`tool` 必须同时存在于宿主 registry 与 Episode capability lease。`join` 和 `loop` 是宿主本地节点，不能伪装成 role/component。执行随后走已有的模型、技能、工具、委派、工件读取/发布和记忆能力路径。

首版不是开放式的模型生成调度器。workflow 和可选 revision 目标在 AgentPackage 建立时已经冻结；模型不能在运行中注入新 operator、工具权限或未登记 workflow。

## 4. Revision：只替换 pending 子图

workflow 可以登记有界 revision rule：某个节点的持久 receipt 满足条件后，切换到同一包内另一个已注册 workflow。每次 revision 递增同一个 plan id，并显式列出 `replaced_node_ids` 与可选原因引用。

宿主只允许替换仍为 pending 的子图。正在运行或已经完成、失败、跳过、取消的节点及其定义、输入依赖和执行证据不能被新计划覆盖；替换边界外的节点与边必须保持不变。这个限制使 checker 反馈能够改写后续 repair/delivery 路径，同时保留已发生工作及其成本。

## 5. Recovery：宿主账本优先

每次节点状态变化与 revision 后，运行器保存当前 plan、revision history、node execution 和 node receipt 投影。恢复时不直接信任这份投影，而是重新：

1. 从当前不可变 package resource 编译同 revision 的预期 plan，并比较身份；
2. 核验所有输入/输出 artifact 仍存在且对 Episode 可见；
3. 对终态非本地节点匹配宿主 RPC journal 的 method、params、package digest、状态和结果；
4. 只复用通过上述检查的终态节点，不重放已确认的模型、工具或其他外部工作。

如果节点已经 admission 为 running 却没有 durable outcome，或计划、receipt、RPC、artifact 任一证据不一致，Episode 进入 `recovery_required`。宿主不会把未知副作用当成安全重试。这是 recovery safety，不是自动完成任意中断任务的保证。

## 6. 与 O/M/S 演化的关系

当前纵切面已经把 O 类 workflow orchestrator、role 和 S 类 skill/prompt component 连接到真实执行，也为 M component 提供了 manifest 身份。`MemoryService` 另有候选、release、snapshot 与 CAS 晋升/回滚合同，但 M component 身份尚未贯穿 plan node、memory release 和演化收据；P3 mutation policy 也仍以 path 与 O/M/S class 为主。

因此下一完整切片应依次完成：

1. **component-targeted evolution**：feedback、BehaviorPatch、activation probe、selection 和 guard 使用同一稳定 component id；
2. **M routing**：计划显式绑定冻结 memory release/snapshot，并区分 M-policy 与 M-data；
3. **P4 recoverable cycle**：将 R self-update、meta trial/decision、promotion、guard 和 rollback 纳入持久、可恢复、单次 claim 的 cycle。

这些步骤不得放宽 evaluator、usage、snapshot、selection、promotion 或 guard gate。

## 7. 证据等级与可声称结论

当前 manifest-v2/ExecutablePlan 纵切面的证据是 **E0 工程合同**：定向确定性测试覆盖注册拒绝、能力解析、并行 role、join/checker、pending 子图 revision、持久 receipt 与恢复不重放。它支持“声明、实际 runtime、revision 和 recovery 已连通”的结论。

P3 的正向 exporter 与一次性 qualification runner 已存在，但真实 E1 model generation activation 尚未执行。执行需要把审查后的脱敏 FeedbackBundle、目标 component 内容和 mutation policy 发送给已配置的外部 provider；当前没有这项外部发送授权。

因此目前不能声称：

- 模型根据反馈生成了有效 component 变更；
- manifest-v2 角色或 workflow 在真实 provider 上优于旧执行路径；
- MemoryService 已形成 M-RSI；
- P4 已在真实模型下可恢复地递归改进；
- OpenFOAM 或科学发现 demo 证明通用、跨域或统计 RSI 效益。

P1 的真实 MiMo 普通任务交付和 P2 的真实 OpenFOAM smoke 仍是各自执行路径的有效证据，但它们不替代 E1 反馈生成激活，也不提高 RSI 效益的结论等级。

## 8. 相关合同

- [vNext 智能体架构](agent-architecture-vnext.md)：整体对象、信任边界与阶段验收；
- [MemoryService 生命周期](memory-service-lifecycle.md)：M-data 候选、release、snapshot 与当前权限边界；
- [P3 反馈演化控制面](p3-feedback-evolution-control-plane.md)：反馈、候选生成、选择、晋升与 task guard；
- [P4 递归改进器控制面](p4-recursive-improver-control-plane.md)：R self-update、meta evaluation、R channel 与 guard；
- [分阶段重构计划](../../REFACTOR_PLAN.md)：下一纵切面、依赖与验收顺序。
