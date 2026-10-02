# 通用框架入口

2026-10-02：组织提案是一个应用能力，不能定义框架的能力上限。默认 Main、
`nexgent run` 和 Python 的 `Nexgent` 现在组合相同的 `TaskService`。
没有另建执行器、工具协议或一套候选发布账本。

## 已接通的结构

| 部分 | 复用的实现 | 普通入口中的行为 |
| --- | --- | --- |
| 任务执行 | TaskService / Episode | 工具、子任务、成果、预算和恢复使用同一运行时 |
| 执行策略 | AgentPackage / package channel | 默认 Python 决策循环；应用可替换整个执行程序，不要求组织提案或 DAG |
| 成员与协作 | delegate / parallel / artifact | 成员有任务内名称、职责、独立执行过程；共享实际输入和交付引用，负责人读取再汇总 |
| 工具 | ToolRegistry / ToolProvider | 工作区能力成为一个提供者；应用可注册自己的成熟工具，框架不认识其业务含义 |
| 评价 | 既有 evaluator adapter | 固定宿主评价程序另开只读 Episode，不加载任务生成的工具或可修改评价提示 |
| 反馈 | 既有 Episode 事件与输入工件 | 用户反馈、对话交付和按反馈重跑跨进程保留 |
| 跨任务改进 | 既有 AutoEvolution / EvolutionService | 项目配置的策略继续负责候选、比较、门控与发布；新任务解析当前包版本 |

工作区文件读写、公开网页读取、CSV/Excel 和计算工具是可替换的提供者能力。
执行器及通用评价器没有 Excel 工具名、特定题目或组织候选格式的判断。
自动授予工作区基础工具；领域插件保留在注册表中，须按任务明确授予。

## 使用与组合

```python
from nexgent import Nexgent

agent = Nexgent("my-project")
task = agent.create("完成任务", inputs={"material": {"facts": [1, 2, 3]}})
result = agent.run(task["id"])
agent.feedback(task["id"], "后续需要更清楚地说明验证方法")
```

创建 `Nexgent(root, tools=registry, package=package, evaluator=adapter)` 可替换
工具注册表、初始执行策略和独立评价器。沿用现有 `ToolSpec` handler
`(arguments, ToolContext)`、`make_package()` 和评价 adapter 合同；不要求私有 DSL。
也可传入 `benchmarks={adapter.id: adapter}` 组合现有 BenchmarkAdapter，供项目改进
策略调用；宿主负责在重启时提供同一版本的 adapter，或将其安装为已有评价插件。
`package` 是新 channel 的初始版本，不能借构造函数覆盖已有部署。
也可显式选择已注册的 `package_channel`；同一任务冻结所选包及已授予工具的版本。

模型通过已有 `develop_tool` / `develop_service` 在受限 worker 中创建纯计算工具、
或上下文服务。成员通过普通 `delegate` 创建，`task.agent` 含 `name` 和
`instructions`；其职责不会增加权限。返回的 `output_refs` 是实际成果引用。

配置自动改进时，反馈包会纳入相同包版本下的真实委派成员。成员成功使用的工具
或服务可进入与主任务相同的候选、独立 selection、guard 和发布流程；只有实际
通过门控的包版本会影响新任务。普通入口提供有限计算额度，显式预算仍优先。

```powershell
nexgent --root ./my-project run "完成任务" --attach ./input.json
nexgent --root ./my-project feedback EPISODE_ID "反馈"
nexgent --root ./my-project learn EPISODE_ID
nexgent --root ./my-project run-resume EPISODE_ID
nexgent-gui --project ./my-project

# 原组织提案应用及既有历史数据仍可使用
nexgent --root ./my-project run "组织应用任务" --organization-demo
nexgent-gui --project ./my-project --organization-demo
```

`run-list` 同时列出框架任务和旧组织记录；旧记录 ID 的反馈、学习和恢复保持兼容。
模型配置仍可通过 `--model-root` 复用已有目录。

旧组织应用仍使用兼容服务，尚未迁成此框架上的 AgentPackage 策略。
保留历史行为不等于已完成应用迁移。

## 尚未完成

这次完成的是通用框架组合与实际入口接线，不是完整 RSI 的完成声明。

- 无项目改进策略时，任务开发的工具仍是任务内能力；保存反馈和重跑不会自动发布。
  界面明确显示持续改进未配置。
- 配置后的跨任务候选与发布复用[已有改进策略](guides/ordinary-auto-evolution.md)。
  新默认 Python 策略下的自主候选、实际发布和后续任务复用还须真实验证。
- 通用宿主插件开发、服务接口扩展、记忆策略和改进策略自身的修改仍未完整接入。
- 交付评价为开发反馈；它不是隐藏任务集上的收益证明。执行程序中的自检也不能
  冒充这个独立评价。评价失败保留实际交付，并显示验收失败或缺测。

工具、服务和执行策略候选已复用同一套现有门控。成员能力发布、跨进程加载和拒绝
回退已通过 Python 策略集成验证；真实模型自主完成候选生成与发布仍待验证。
公开组合接口的[普通 Main 发布与复用](validation/member-capability-release-20261002.md)
使用确定性 Python 应用，不代表真实模型自主改进。
不能用另一个定制 demo 的成功或组织提案采纳来替代这项工作。

本轮[真实入口与失败记录](validation/framework-runtime-20261002.md)区分普通交付、
反馈续用、机制检查和尚未通过的多成员能力开发整轮。
