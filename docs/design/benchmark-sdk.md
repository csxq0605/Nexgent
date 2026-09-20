# Task benchmark SDK：机制收敛与 BBH 迁移

当前产品路径以 `TaskService` 和 `nexgent.task_benchmarks` 为准。第一阶段统一了
TaskService benchmark 的插件合同与发现机制；第二阶段已把 BBH 两任务适配器接到
canonical API。0.8 的 `nexgent.benchmarks` 源码 bundle 接口仍作为兼容层保留，
scientific discovery 尚未迁移。旧 `StudyController`、历史命令、记录读取和恢复语义
保持不变。

## 已实现边界

`nexgent.tasks.benchmarks` 提供显式 `BenchmarkDescriptor`、
`BenchmarkAdapter` Protocol 和 `BenchmarkRegistry`。Workbench 与 OpenFOAM
已经声明 descriptor；BBH 两任务插件提供逐样本 TaskSpec、host-side 隐藏评价器和
无模型 reference AgentPackage。Registry 对每个 entry point 独立加载和校验：一个插件导入失败、
缺少数据、声明不可用或合同错误时，只把该插件列为 unavailable，不阻止其余插件。

安装入口名必须等于 adapter 和 descriptor 的 `id`。Snapshot、任务列表和评价报告
必须是有限 JSON；任务必须有 ID 与非空 objective；可用分数必须是有限数值。任务列表
允许同一 payload 重复出现，因为 guard 等协议会把重复项当成有意义的多重集并另行校验完整性。
Registry 支持 provider 的可选 `from_project(project_root)` 及 adapter 的可选
`availability()`。公开 registry 只返回宿主固定的 unavailable/error 分类，不回显
插件异常或依赖探测原文；这些文本可能包含本机路径、数据集名称或凭据。

`nexgent.domains` 继续独立发现。DomainPack 提供公开工具与环境探针，benchmark
adapter 持有任务采样和隐藏评价权；两者没有合并为同一个插件权限对象。

OpenFOAM evaluator snapshot 现在只包含插件拥有的 schema、runner、工具合同、任务合同
和评价实现。TaskService、工具分发与 package worker 的身份由宿主通过独立
`host_runtime_fingerprint()` 记录，不再由领域插件读取或哈希宿主私有方法源码。
指纹由宿主在 Episode 创建时写入，调用方不能覆盖；执行、恢复和评价前都会与当前
宿主再次核对。它只含固定宿主文件名和 SHA-256，不含插件 snapshot 或评价正文。

共享 outcome policy 只把 `status=failed` 且责任域为 `agent` 或 `protocol` 的终态
记作 observed zero。cancelled、paused、waiting、基础设施故障、不可用或失效的
evaluator 都是 missing。P3 paired selection、deployment guard 与 P5 study 冻结同一
policy；缺失 usage、缺失 evaluator 或不完整任务多重集仍使 gate fail closed。

## 尚未完成

- scientific discovery 仍只使用保留的 0.8 benchmark API；BBH legacy 入口继续保留，
  但新的 TaskService 执行已走 canonical adapter。
- 本阶段不统一两代 benchmark 的记录 schema、缓存或执行主体。
- BBH 的 suite aggregation 当前是插件审计 helper，不是 TaskService 的宿主级服务；
  canonical 成本使用 TaskService ledger，不伪造 legacy 的 source-instruction 数值。
- OpenFOAM 仍是单一 smoke 场景，不具备 confirmatory study 所需的独立统计 cluster；
  descriptor 因此只声明 fixed/recovery。
- Workbench 声明 confirmatory 支持，但真实统计结论仍需预注册、多 seed、独立 cluster
  和实际 provider 运行，确定性合同测试只验证机制。

后续迁移不得把旧 measurement ID 或 study ID 原地解释成 TaskService 证据，也不得把
DomainPack 的公开能力与隐藏 evaluator 权限合并。
