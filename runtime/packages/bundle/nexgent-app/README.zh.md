---
description: "随 Nexgent 浏览器与 headless 应用构建的 MiMo 默认配置。"
kind: "package-bundle"
---

# @nexgent/application

[English](README.md) | 中文

## 概述

随应用提供的 `nexgent` 和 `nexgent-run` profile 使用 MiMo-V2.6-Pro、原生工具和持久会话完成通用任务。这个私有应用层提供默认模型、身份提示、本地请求记录和遥测策略。它随应用源码构建，用户无需将它单独安装到外部 DSH 中。宿主配置的输出型成对试用使用同一原生执行路径。自动候选选择和采用仍是独立的后续工作。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

应用自带的 profile 在继承的 base 与浏览器或 headless 配置之后包含本层。仓库根目录的 `start.ps1` 与 `run.ps1` 选择这些 profile。密钥由原生凭证服务从 `NEXGENT_API_KEY` 读取。接口覆盖通过原生模型配置完成。架构图由原生 workflow 工具执行，定义保存在项目数据目录中。新 Session 可显式执行保存的 `architectureVersion`；这不会自动选择或采用该版本。

插入的 `nexgent-architecture-trials` 行加载 `@nexgent/application/trials`。默认 `plans` 为空，不向模型暴露试用工具。宿主通过原生 profile 补丁提供计划：每项包含 `id`、`description`、`baseline` 图，以及非空的 `cases`；用例包含唯一 `id`、JSON `input`、`outputNode` 和 JSON `expected`。规则和基线在组合时验证并复制，之后修改部署对象不会改变已激活计划。配置项 `maxCaseMs` 和 `maxTotalAgents` 限制每个用例，默认分别为 180000 毫秒和 32 个成员。

存在计划时，`architecture_trial` 接受 `planId`，以及候选 `architecture` 或保存的 `architectureVersion`，两者必须且只能提供一个。基线与候选通过原生 workflow 引擎分别执行相同输入，创建全新成员并继承任务权限。宿主编译将所有成员的全局工具范围替换为空允许列表，保留原生作用域内的结构化输出。本模式评价产生输出的图，不能评价写文件或依赖工具的候选。图摘要仍只标识定义；试用记录还标识执行模式和编译脚本。

宿主将实际选定节点的输出与冻结 JSON 按结构精确比较。只有所有候选输出匹配，且两组均有已知结果时，候选才通过。不匹配记为 `fail`；执行失败、缺失输出、取消和清理失败记为 `unknown`。每个运行均在记录用例结果前完成资源释放。每次调用中每个用例仅执行一次，不重试或替换抽样。卸载会取消并等待活跃调用结束。试用记录同步落盘失败时，调用返回错误并留下不完整记录，不能产生成功试用。通过不会采用版本，也不代表相对改进。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

[配置补丁](cordis.patch.yml) 按行身份替换默认值。继承的 Agent 拥有模型执行、文件工具和持久化；本层不增加 Python 执行器、模型网关或逐任务 SDK 载体。用户仍可通过原生配置面覆盖 profile。观察器不拥有跨服务可变关系，因此不发布不变式伴随文件；插入行的所有者维护其不变式。[Profile 加载](../../boot/app-boot/README.zh.md) 和[基础运行时](../base/README.zh.md) 分别拥有组合与执行。

应用的 `ExecutionLedger` 观察原生 `llm/stream` 瀑布，包括成员与辅助调用。每次组合在应用数据目录的 `execution-ledgers` 中拥有一个独占 JSONL 文件，每次追加同步落盘，组合卸载时关闭。开始与结算记录保留路由、调用方提供的 Session 身份、用途、终止状态和最后一次上报的用量。记录排除提示正文、密钥和提供者错误正文。缺失或无效用量保持显式；推理 token 是输出的子集，不重复相加。关闭记录包含存储失败次数。读取器拒绝无效记录、重复结算、不完整行和关闭后的追加。缺少关闭记录或存在未结束请求时，不宣称观察完整。本旁路记录不增加已发布 Session 事件或版本。

配置计划后，父 agent（智能体）看到计划身份、说明、试用工具指导、自己的候选调用，以及包含 `pass`、`fail` 或 `unknown`、用例结果和 `adopted: false` 的 JSON 汇总。预期值不进入工具 schema、成员输入或返回汇总。原生成员会话保留提示和实际输出。`architecture-trials` 下的试用记录将父会话、workflow 和成员身份关联到 `execution-ledgers`；基线与候选定义保存在 `architectures` 下。缺失终止记录表示观察不完整。不改变已发布 Session 类型。

</details>

<a id="model-experience"></a>
## 模型体验

间接影响；每个插入行对应模块的原生行为见上文。

#### KV 缓存影响

应用身份提示会改变系统前缀。继承的提示与模型提供者包负责请求组装和缓存；本层不测量缓存节省。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 冻结 JSON 比较覆盖输出型图。工具与代码工件试用、独立 selection 和回归 guard、自动采用及后续任务选择仍待迁移。应用宿主可以访问计划和本地记录；它们不是隐藏的留出语料，也不能抵御拥有宿主权限的 agent 篡改评价器。
- 流观察包括回放与中间件响应；适配器内部的传输重试不会分别被观察。本地、未签名的记录不是账单或独立 selection guard。存储告警、缺失用量分桶和未完成生命周期会阻止相应核算声明。
- 应用保留平台隔离要求；Windows ACL 错误仍返回工具失败，不授予不受限执行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
