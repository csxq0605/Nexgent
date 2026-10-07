---
description: "随 Nexgent 浏览器与 headless 应用构建的 MiMo 默认配置。"
kind: "package-bundle"
---

# @nexgent/application

[English](README.md) | 中文

## 概述

随应用提供的 `nexgent` 和 `nexgent-run` profile 使用 MiMo-V2.6-Pro、原生工具和持久会话完成通用任务。这个私有应用层提供默认模型、身份提示、本地请求记录和遥测策略。它随应用源码构建，用户无需将它单独安装到外部 DSH 中。独立候选选择与架构进化尚未进入这些 profile。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

应用自带的 profile 在继承的 base 与浏览器或 headless 配置之后包含本层。仓库根目录的 `start.ps1` 与 `run.ps1` 选择这些 profile。密钥由原生凭证服务从 `NEXGENT_API_KEY` 读取。接口覆盖通过原生模型配置完成。架构图由原生 workflow 工具执行，定义保存在项目数据目录中。新 Session 可显式执行保存的 `architectureVersion`；这不会自动选择或采用该版本。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

[配置补丁](cordis.patch.yml) 按行身份替换默认值。继承的 Agent 拥有模型执行、文件工具和持久化；本层不增加 Python 执行器、模型网关或逐任务 SDK 载体。用户仍可通过原生配置面覆盖 profile。观察器不拥有跨服务可变关系，因此不发布不变式伴随文件；插入行的所有者维护其不变式。[Profile 加载](../../boot/app-boot/README.zh.md) 和[基础运行时](../base/README.zh.md) 分别拥有组合与执行。

应用的 `ExecutionLedger` 观察原生 `llm/stream` 瀑布，包括成员与辅助调用。每次组合在应用数据目录的 `execution-ledgers` 中拥有一个独占 JSONL 文件，每次追加同步落盘，组合卸载时关闭。开始与结算记录保留路由、调用方提供的 Session 身份、用途、终止状态和最后一次上报的用量。记录排除提示正文、密钥和提供者错误正文。缺失或无效用量保持显式；推理 token 是输出的子集，不重复相加。关闭记录包含存储失败次数。读取器拒绝无效记录、重复结算、不完整行和关闭后的追加。缺少关闭记录或存在未结束请求时，不宣称观察完整。本旁路记录不增加已发布 Session 事件或版本。

</details>

<a id="model-experience"></a>
## 模型体验

间接影响；每个插入行对应包负责该行的模型可见行为。

#### KV 缓存影响

应用身份提示会改变系统前缀。继承的提示与模型提供者包负责请求组装和缓存；本层不测量缓存节省。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- Python 评价器、selection、guard 和版本采用尚未保护原生会话。独立试用与候选采用仍待迁移。
- 流观察包括回放与中间件响应；适配器内部的传输重试不会分别被观察。本地、未签名的记录不是账单或独立 selection guard。存储告警、缺失用量分桶和未完成生命周期会阻止相应核算声明。
- 应用保留平台隔离要求；Windows ACL 错误仍返回工具失败，不授予不受限执行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
