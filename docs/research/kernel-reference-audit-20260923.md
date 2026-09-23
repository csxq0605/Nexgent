# Stage A1：内核参考与现有实现对照

日期：2026-09-23。状态：**源码审查，非运行效果。** 比较合同见 [Stage A 小样](../../experiments/kernel_spike/CONTRACT.md)，阶段验收见[当前计划](../../REFACTOR_PLAN.md)。

## 固定版本和证据边界

| 来源 | 固定身份 | 本阶段读取重点 |
| --- | --- | --- |
| Nexgent | `3919a0d`；其他未提交的 benchmark／memory 诊断不进入基线 | `src/nexgent/tasks/{runtime,tools,store}.py`、`src/nexgent/models/gateway.py` |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/46a7f68b0922371ce7144b668b90e377d8e799f4) | `dsh-v0.1.7-rc.1` → `46a7f68b0922371ce7144b668b90e377d8e799f4`；vendored Cordis core／loader 上游 `56b3d4f725681cf4556c1a8695a709cc3b6eed74` | [架构](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/docs/architecture.md)、[插件管理](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/packages/boot/plugin-manager/README.md)、[vendor 版本和本地修改](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/vendor/README.md) |
| [AutoSci](https://github.com/skyllwt/AutoSci/tree/6bc834a805a1744959a9983809e5d6f0263ef791) | 论文 `arXiv:2605.31468v1`，`arxiv-v1` 注释标签所指 `6bc834a805a1744959a9983809e5d6f0263ef791` | [论文](https://arxiv.org/abs/2605.31468v1)与[源码执行器](https://github.com/skyllwt/AutoSci/blob/6bc834a805a1744959a9983809e5d6f0263ef791/scidag/executor.py)分开判断 |
| [ADAS](https://arxiv.org/abs/2408.08435v2)、[AFlow](https://arxiv.org/abs/2410.10762v4) | `2408.08435v2`、`2410.10762v4` | 编程式 Agent 与工作流搜索是阶段 D–F 的机制参考；不用于证明当前内核已自进化 |
| [RHI](https://arxiv.org/abs/2607.15524v1)、[HSI](https://arxiv.org/abs/2608.08466v1) | `2607.15524v1`、`2608.08466v1` | 信息流、执行循环和改进器自身的可变性留待阶段 D–F 实验 |

上述 DeepSeek 提交是本次冻结的比较对象，不代表其 API 长期稳定。该版本根包声明 Node `^22.19.0 || >=24.0.0` 和 `pnpm@11.7.0`；本机初查为 Node `24.15.0`、pnpm `11.19.0`，仍须实测安装和运行。AutoSci 的领域研究阶段留在 demo，Nexgent 借鉴的是技能／编排／反馈的更新机制。

## 已核对的实现差距

| 问题 | Nexgent `3919a0d` | 参考机制与小样要检验的事 |
| --- | --- | --- |
| 工具注册 | `ToolRegistry.register` 接收含可调用宿主 `handler` 的 `ToolSpec`；`discover` 从已安装的 `nexgent.domains` entry point 加载 | DeepSeek 的 [服务定义、provider、consumer](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/docs/architecture.md#capability-seams) 是可替换能力的三个角色，consumer 常为模型工具，但不必须；其作用域只对显式支持的注册表生效，小样必须实测目标工具注册表 |
| 使用边界 | `TaskService.create` 把工具描述和 capabilities 写入 Episode；`_invoke("tool")` 检查 grant、effect、schema 并留收据 | 装入后模型是否能重新发现工具；另一任务和卸载后是否不可用；现有收据如何携带 handler 版本 |
| 执行策略 | `TaskService` 负责 `_dispatch`、`_invoke` 和工作流编译／执行；已有 pending DAG 修订与恢复 | DeepSeek 把 agent loop 作为可替换插件；小样检查替换循环需要桥接的状态、模型消息与恢复字段 |
| 事件与恢复 | `EpisodeStore` 记录 RPC 开始／结束、任务节点和工具事件，未知外部效果要求恢复检查 | DeepSeek session log 区分持久事实与运行中事件；小样需实际核对可重建模型输入和 Nexgent Episode 映射，不能仅列接口 |
| 新能力开发 | `develop_skill` 编译受限 Python 子包，已有真实代码生成和手工诊断子任务执行 | DeepSeek 的 Creator 通过工作区写 bundle、再用 Plugin Manager 持久安装；只读 `tool-cordis` 不直接创建动态定义。其 [插件管理说明](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/packages/boot/plugin-manager/README.md#use-this-package)指出每次修改需相应授权，安装后宿主代码在工作区沙箱外、同进程执行。模型生成的不可信代码仍需 Nexgent 的隔离执行方案。阶段 C 验收此能力，A 只用手写工具 |
| 评价与版本 | Nexgent 有 AgentPackage、benchmark 和 selection/guard 身份；目前没有工具／服务插件候选类型 | DeepSeek 解决可扩展运行问题，独立后代评价与 RSI 采用仍需由 Nexgent 实现和验证 |

参考系统的能力按**论文主张、源码合同、实跑结果**分别记录。AutoSci 论文描述 SciDAG 条件路由，已固定的 `arxiv-v1` 执行器没有条件边运行分支，故阶段 D 不从论文描述推断该源码已提供条件执行。

DeepSeek 的[作用域原语](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/packages/core/scope/README.md)是可信、同进程的 agent/group 注册范围；它本身不是安全沙箱，也不使任意服务自动具备任务隔离。插件配置和依赖清理有生命周期机制，但插件管理安装失败可能留下下载／构建副作用，启用或移除也不能按一个布尔 `installed` 概括。小样须记录实际操作阶段及残留。

DeepSeek [session/event 与 live agent 事件](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/docs/architecture.md#events)分别承载持久事实与过程通知；流式块在最终 settlement 前不是持久证据。其工具调用日志中的名称、参数和结果不足以证明 Nexgent 的 handler／插件版本被激活，桥接层须另存可验证的摘要。`AgentLoop` 可通过配置替换，但一个 AgentRegistry 仅有一个 factory 位；不同任务同时用不同 loop 需要另设隔离实例或代理分派，不能从“可替换”推断“逐任务并列”。

逐项源码核对：[Creator 的只读接口检查](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/packages/extensions/tool-cordis/README.md#L12-L28)、[动态定义 runner 的信任边界](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/packages/extensions/cordis-host-runner/README.md#L12-L54)、[Creator 开发流程](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/packages/preset/agent-preset/skills/cordis-plugin-development/SKILL.md)、[插件管理操作与权限](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/packages/boot/plugin-manager/src/tools.ts#L13-L43)、[工具事件字段](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/packages/core/session/src/types.ts#L357-L395)、[AgentFactory 单槽接口](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/packages/core/agent/src/index.ts#L167-L202)。

Windows 小样运行条件：该版声明 Node `^22.19.0 || >=24.0.0` 与 `pnpm@11.7.0`。本机 Node `24.15.0` 符合范围，但全局 pnpm `11.19.0` 不等于固定版本，应在独立检出中固定 11.7.0。源码路径需构建后经命名 `dsh` profile 运行，Nexgent 桥接使用独立 SDK/headless 进程及其 JSON-RPC／事件接口；不把 TypeScript Cordis 树直接载入 Python 宿主。Windows 插件和 ACL sandbox 的实际工作情况仍待 A2 实跑，文档描述不能当作结果。

## A1 对 A2 的约束

两条后端使用[同一任务、工具、收据及失败条件](../../experiments/kernel_spike/CONTRACT.md)。DeepSeek 的 Cordis 是其底层插件框架，不另算第三条路径。Nexgent 不预先决定整体迁移；Python 路径必须测真实可替换接口，DeepSeek 路径必须测真实运行与 Episode 投影。阶段 A 结束前不把参考仓库的插件热装等同于安全隔离，也不把同题小样等同于 RSI 收益。
