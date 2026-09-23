# 任务中能力开发的授权与作用域合同

日期：2026-09-24。状态：**设计约束，不是完成声明。** [当前计划](../../REFACTOR_PLAN.md)的 A3 租约薄片只验证已安装工具的任务级激活；它不能作为 B/C 的完整内核出口。

## 关键纠偏

`TaskService.create()` 当前要求 `capabilities` 中每个工具名已安装，且 Episode 冻结名称列表。`EpisodeStore.mount_capability()` 的初版还要求租约名称位于该列表；现有执行路径尚未使用租约。因此，“初始名称上限 + 激活租约”能验证预安装工具的装卸与收据，却无法让模型在任务中创造一个事先不知道名称的新工具。后续不能靠预列举所有可能名称、全局注册表写入或重写原始 Episode 合同绕过这一限制。

稳定授权应冻结**允许的操作类别、资源边界和凭据句柄**，而不是未来能力的名字。宿主在能力试装前检查实际实现、依赖和声明操作是否落在该授权内。新增工具名属于当前任务候选实例，不自动成为其他任务的默认能力，也不自动取得新的文件、进程、网络或外部业务操作权限。

## 分层身份

| 对象 | 宿主必须持久绑定的最小内容 |
| --- | --- |
| EpisodeAuthority | 允许的 effect／具体外部操作、受托运行环境、凭据句柄范围、预算、委派继承规则及版本 |
| CapabilityDefinition | 内容寻址 ID、逻辑名、类型、接口版本、schema、入口、依赖锁、构建产物／运行环境摘要、声明操作和来源任务／工件 |
| CapabilityInstance | 定义 ID、Episode／会话作用域、状态与 revision、实际 provider 身份、健康和清理结果 |
| InvocationReceipt | 定义与实例版本、handler／bundle 摘要、输入、准入与资源预留、结果或未知状态、调用路径 |
| CandidateRelease | 父代、任务反馈、开发检查、独立评价、适用范围、激活证据、采用／回滚关系 |

同名实现的变化是新的 Definition，需显式替换旧实例；不能把不同 handler 悄悄绑定到原租约。调用完成后保留其已冻结身份与结果，释放实例只阻止**新**调用。若外部结果未知，先要求状态核对，不自动重发。旧 `capabilities` 列表作为兼容入口转换为初始授权／实例，不再定义可开发能力空间的上限。

## 最小宿主流程

```text
模型发现缺口 → 编写 bundle 与测试 → 隔离构建／检查
    → stage_definition(bundle_ref, build_receipt)
    → mount(episode, definition_id, authority_revision, expected_instance_revision)
    → inventory 重新发现 → 模型实际调用／激活
    → task feedback → 候选评价 → adopted release → 新任务解析与使用
```

`stage_definition` 不执行未审查源码于宿主进程。`mount` 必须在安全暂停点原子检查：当前 Episode 授权、依赖锁、effect 与具体操作、隔离检查、provider 可用性、版本及预算。`inventory` 只显示当前有效实例。`release` 先关闭新调用准入，再清理事件订阅／进程／依赖，并分别记录成功和失败。工具、服务、执行循环、上下文策略可共享版本和生命周期合同，但各自有不同激活适配器；不能把服务插件伪装成工具处理器。

## 对照与验收

- [DeepSeek Harness 固定源码对照](../research/kernel-reference-audit-20260923.md)提供 Agent 作用域注册和服务／provider／模型工具分离的参考。Nexgent 还需保持原 Episode 的事前准入、成本、恢复与独立 evaluator 身份；外部日志事后投影不足以替代。
- [AutoSci 论文和发行分支边界](agent-architecture-vnext.md#13-autosci-来源实现边界与借鉴范围)提示技能、图与反馈更新都是演化对象；科研流程只是任务插件场景。[ADAS](https://arxiv.org/abs/2408.08435v2)和[AFlow](https://arxiv.org/abs/2410.10762v4)将完整可执行智能体／工作流作为搜索对象，因此租约只是激活机制，不能替代行为候选及效果比较。
- A3 的验收是已安装工具的任务级租约进入真实执行路径、卸载、恢复与收据。B/C 的验收另需真实模型在未知工具名下开发 Definition、隔离试装、重新发现并调用；服务／策略插件必须另行验证。E/F 再证明独立采用和未见任务效果，允许零或负结果。

现有 `ToolSpec.handler_digest` 是可信 provider 提交的身份声明，不能单独证明运行中的字节确实与摘要一致。B 阶段需在装载时核对构建包／入口摘要，并把环境及依赖固定。A3 测试对该字段的相等检查只表明恢复时声明没有漂移。

## C1 首个可执行切片

优先做**未知名称的新工具**，不先扩到网络／进程插件，也不引入固定团队或 DAG。任务保留冻结的 `EpisodeAuthority v1`：允许的能力类型、effect、具体操作、工件范围、受控运行环境、凭据句柄、开发／调用预算和版本摘要。旧 `capabilities` 只兼容为初始预安装工具实例。模型通过固定开发能力提交源码、接口和测试；宿主在受控子进程环境内检查后保存内容寻址 Definition，再于 Episode 的串行安全点挂载 Instance。工具名无需出现在初始列表，下一次模型请求看到重新计算的 active inventory 并实际调用它。

实施路径优先复用现有 `task_skill_compiler` 的提案／AST 检查、`make_package`／`verify_package` 的包身份、`run_package` 的受控 Python worker，以及 Episode RPC、资源预留和事件账。动态定义和实例单独存储；生成代码不写入全局 `ToolRegistry`，不在宿主 Python 进程中运行。调用收据须关联 authority、Definition、Instance、bundle／入口／运行环境摘要及 worker 结果。`stage_definition` 的静态检查不能冒充实际调用或独立评价。

首片定向验证：一项固定模型替身任务从空 inventory 生成新名工具、试装、重新发现并调用，同时验证越权与兄弟 Episode 不可见；一次重启后继续调用／释放／篡改拒绝；一次限额真实模型运行，必须同时留下模型、定义、实例与调用收据。受控 Python worker 不是 OS 安全容器，首片仅允许 `local_compute` 与受控工件读取、空外部依赖和空凭据。其他 effect 需有实际隔离后再开放。此切片不算 E 的跨任务采用：新任务只能从独立评价通过的 release 解析 Definition，并重新接受自身授权检查。
