# ADR 0005：能力版本、候选、门控试验与回滚

- **状态**：已接受
- **日期**：2026-10-12
- **依据**：计划 [4.4](../research/pr4-review-and-plan-2026-10/README.md) 与 4.5；步骤 4 分工表 [`docs/plan/step-4-work-partition.md`](../plan/step-4-work-partition.md)（“已定的决定”9 项，用户 2026-10-12 确认“都可以”）；PR #4 归档分支 `archive/python-host` 的 `architecture-activation.ts`、`execution-ledger.ts`、`architecture-trials.ts`。
- **替代**：无。本 ADR 补充 ADR 0001 中“能力改进”相关的决策，定步骤 4 的格式与规则。

## 背景

步骤 4 对应产品目标 ③：能力的变化进入真实运行系统，并能门控采用与回滚。步骤 3 之前，项目只有用户维护的技能与预设；模型在任务中写出的可复用函数、技能或协作方式不会留下来，也没有办法比较“改了以后是否更好”。PR #4 留下了可复用的机制（内容寻址的架构文件、带摘要链的采用历史、试验收据），步骤 4 把它们推广到全部能力组件，并接到会话、账本与 SDK。

## 决策

1. **能力包按项目、按内容寻址。** 一个能力包是完整的组件集合（不是增量），版本是规范化清单的 SHA-256；没有组件时是 `baseline`。范围是项目（决定 1），存放在 `.nexgent/capabilities/<version>/`。组件分四类七种：工具（`function-module`、`plugin`）、技能（`skill`）、上下文策略（`context-policy`）、协作方式（`preset`、`team-template`、`architecture`）。契约 `capabilities.ts`。
2. **采用历史是摘要链。** `activation/<n>.json` 逐个修订，`previous` 是上一个文件原始字节的 SHA-256，以 `link` 独占发布；链尾是采用中的版本。每个会话在打开时固定一个版本（`session.start.capabilityVersion`），运行中的采用不影响已打开的会话。
3. **候选来自 `capability_propose`，且组件必须真被用过。** 模型用 `capability_draft` 在本会话草稿区写组件，用 `capability_try` 只在本会话装载，再用 `capability_propose` 提出候选；宿主核对每个组件在试用后至少被成功用过一次（决定 2），否则拒绝。成员看不到这三个工具（`MEMBER_DENIED_TOOLS`）。
4. **门控在任务结束后自动运行。** 提出候选的任务结束后，宿主在独立进程里对过去的任务做重放试验（决定 3）：选择集至少 2 个、守护集至少 1 个用例，每臂每例重复 2 次；每个候选有自己的试验预算，用尽即以 `unknown` 结束。重放从任务开始时的快照起步，所以从步骤 4 起每个根任务开始时都拍内容寻址的快照（`.nexgent/snapshots/`，总量 200 MiB，决定 7）。
5. **采用规则是确定的。** 质量 = 确定性检查通过率；任何 `unknown` 即拒绝；守护集不得退步；质量提高且 token 不超过基线 1.2 倍才采用；打平时成本更低可采用，否则由评审模型投票（决定 4）。评审默认 `claude-sonnet-5-5`、thinking 开，可改为 `claude-opus-5-5`（决定 5）。纯函数 `decideTrial` 固定这一规则。
6. **回滚。** 装载校验失败立即回滚；采用后前 3 个根任务检查通过率低于门控测得的基线，或新组件连续出错 3 次，自动回滚（决定 6，`decideUsageRollback`）；用户也可手动回滚。回滚是一个新修订，不删除任何文件。
7. **插件两次审批。** 插件在宿主进程内执行，试用与采用各需用户批准一次，任何沙箱模式下都问、每次都问，批准不改变会话权限（决定 9，`permissions.md` §插件安装审批）。验收主链只用技能与函数模块。
8. **权限字段不进能力包。** 上下文策略的 schema 是封闭白名单；`.nexgent/config.json` 的 `capabilities` 设置与 `approvals`、`costCaps`、`sandboxMode` 一样，写入总要审批（H13）。
9. **账本与证据。** 每条记录带 `capabilityVersion`；试验运行在项目副本里，但账本记录写进真实项目账本并带 `trialId` / `arm`；`task.outcome` 增加 `componentsUsed` 与 `memberCosts`；每个决定写一条 `capability.decision`。试验收据与决定文件写一次、不改。

## 后果

- **契约**：新增 `capabilities.ts`、`step4-tools.ts`；`session.ts`（四种记录、`capabilityVersion`）、`ledger.ts`（归属字段、`componentsUsed`、`memberCosts`、`capability.decision`、`TaskCheck.target`）、`config.ts`（`capabilities` 节、`GUARDED_PROJECT_CONFIG_FIELDS`）、`collaboration.ts`（`MEMBER_DENIED_TOOLS`）与 `packages/sdk/src/api.ts`（API 版本 4，`capabilities.*` 方法与事件）同步修改。SDK 方法在实现落地前报 `internal`。
- **格式**：新记录与字段在会话 JSONL v1 与账本 v1 内追加；步骤 3 的会话与账本照常读出。能力文件与快照的 schema 是 `packages/session/schema/capabilities.v1.schema.json`。
- **实现分工**：按步骤 4 分工表；kernel 的记录白名单、`capabilityVersion` 写入与 `.nexgent/snapshots/` 布局归 kernel 一侧的工作包。
- **不做**：跨项目或用户级能力库；能力包的签名与分发；自动生成检查以外的质量度量；步骤 5 的反馈触发改进（`autoImprove` 仍关）。
