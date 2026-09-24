# D1-C 反馈检查点真实模型探针：预注册合同草案

日期：2026-09-24。合同修订：`2026-09-24/D1-C.2`（首次 Provider 请求前修正 no-gap 的最终版本号矛盾）。状态：**草案；不得运行。代码前提已有定向测试，但四条件离线预检和冻结运行清单尚未完成。**

本合同预注册一个任务类型无关的运行时机制探针：同一普通任务 Episode 从冻结 DAG 开始，在持久化、可归因的中途反馈检查点，由真实 MiMo v2.6-flash 决定继续 DAG 或切换到同包受控代码入口。若切换，入口必须读取冻结 handoff，沿用同一根预算和绝对截止时间，再交付最终工件。

三服务发布审查只是结构化、可确定性评分的普通测试设置。核心机制、状态、预算、恢复和评价合同不得包含发布领域专用分支，也不得把该设置的单次结果外推为通用编排收益。

## 1. 已有证据边界

### 1.1 D1-B 真实负结果必须保留

[`../strategy_selection/CONTRACT.md`](../strategy_selection/CONTRACT.md) 预注册了启动时 DAG／开放循环选择。[`../strategy_selection/RESULTS.md`](../strategy_selection/RESULTS.md) 中 `d1b-live-20260924b` 使用真实 MiMo v2.6-flash，四个 Episode 共准入 21 次模型调用、预留 47,600 completion tokens。两个主任务均失败；三服务发布审查被选为 `ordinary-open-loop`，随后用尽单 Episode 八次模型调用预算而未交付。H1–H4 全部不通过。

D1-C 不得覆盖、重标或解释为修复该负结果。本合同冻结初始 DAG 是为了隔离“中途反馈能否造成真实后端交接”这一新假设；它不重新检验 D1-B 的启动选择，也不证明 MiMo 能在任务开始时选对策略。

### 1.2 当前只存在确定性机制材料

当前代码和定向测试已覆盖：完成节点反馈触发检查点、选择继续或 DAG→entry、非归因反馈不调用 selector、提交后恢复不重复计费。它们使用测试包和 gateway test double，不是生产 adaptive package 的真实模型证据。

本合同没有成功结果。完成实现、离线测试或产生收据本身也不能提前记为 D1-C 通过。

## 2. 研究问题与结论上限

研究问题：在初始策略、任务、候选集合、模型、预算和反馈判据全部冻结后，一项普通任务产生由宿主确定性验证的协议缺口时，真实 MiMo v2.6-flash 能否在持久检查点选择受控代码入口；新入口能否读取准确 handoff，在同一 Episode 和剩余预算内修复交付，并在中断恢复后保持 exactly-once 身份？

若所有预注册假设均通过，只允许报告：

> 一个普通任务上的真实 MiMo D1-C DAG→entry 检查点机制样本得到支持；切换、handoff 消费、最终交付和恢复均有收据。

不得据此宣称：

- 自适应策略优于固定 DAG、固定 entry、单智能体或同预算 review/revise；
- D1-B 启动选择得到支持；
- 跨任务学习、候选晋升、持续演化、递归改进或 RSI 效益；
- 发布审查是核心内置领域；
- entry→DAG、多次切换或任意后端切换已经实现。

## 3. 预注册假设与直接判负

| 编号 | 假设 | 支持条件 | 直接判负 |
| --- | --- | --- | --- |
| H1 | 检查点反馈来自真实、可验证的协议缺口 | 主切换样本的已发布 DAG 草稿先以版本 1、base-policy 证据引用通过完整的独立质量检查，再因冻结 update 的实质变化未通过 updated policy；反馈由宿主 validator 生成并绑定两个 policy digest、草稿工件 digest 和逐项失败 | 草稿本来就不满足 base policy 的完整交付合同；缺口只由模型自述；update 未实质改变判定；或反馈缺少来源摘要 |
| H2 | MiMo 反馈后选择并实际进入 entry | checkpoint selector 的 observed model 为 `mimo-v2.6-flash`，返回冻结 entry ID；checkpoint/handoff 原子提交；旧 DAG pending publisher 未运行；真实 controlled-code worker 进入并形成完成态 `active_strategy` | 无合法选择、选择 continue／未知候选、只从 manifest 推断切换、旧 pending 节点运行、或目标后端未完成 |
| H3 | 切换实际消费 handoff | 新 segment 的第一个 host action 是读取 checkpoint 绑定的准确 handoff；完成前再次核验同一 artifact/digest；最终工件能追溯到 feedback、updated policy 和前段草稿 | 未读 handoff、读错 handoff、读取发生在首个模型／发布动作之后、无模型调用时绕过读取、或最终结果没有使用 update |
| H4 | 切换形成有效交付 | `D1C-SWITCH-PRIMARY` 和 `D1C-SWITCH-RECOVERY` 均通过路线无关的确定性满分门 | 机械 `completed` 但质量未通过；评分器收到策略／checkpoint 信息；或额外未登记调用解释完成 |
| H5 | 机制有特异性且可恢复 | no-gap 与 infrastructure 控制均不调用 checkpoint selector、不切换且通过各自任务门；恢复样本不重复 selector、validator、entry RPC、工件或 deadline | 无缺口仍切换；基础设施反馈被当成 agent/protocol 缺口；恢复重放、替换工件、重置截止时间或重复计费 |

只有 H1–H5 全部满足，才记为“支持 D1-C 单个机制样本”。任何一项失败均保留原始收据并报告失败阶段，不以修改 prompt、任务、模型、预算或额外尝试替换该行。

## 4. 运行前必须满足的前提与状态

以下四项是执行本合同的硬前提。前三项属于生产执行路径，第四项隔离 D1-B 的启动选择负结果。代码路径已有定向测试；仍须完成第 5、9、11 节的四条件离线预检、评价器隔离和冻结运行清单，才可发起 Provider 请求。

1. **生产 DAG 暴露 checkpoint：代码路径已实现，真实任务待验。** `994c6ae` 让生产 adaptive package 的 DAG／GraphProposal 声明并编译 `strategy_checkpoint_rules`；模型图提案到真实默认 entry 的定向纵向测试通过。真实 MiMo 是否生成有用检查点尚未验证。
2. **生产 entry 能读取 handoff：代码路径已实现，真实任务待验。** `994c6ae` 让同包默认受控代码 entry 在任何后续模型、工具、技能或发布动作前读取 `strategy_handoff_ref`，并把准确工件提供给任务智能体。
3. **完成态 handoff 消费不变量：已实现，真实任务待验。** `66bd44c` 要求 switched entry 的第一个宿主调用读取准确 handoff，且在完成和写入 `active_strategy` 前再次核验；零模型调用、先发布后读取的负测试均拒绝。该确定性测试不能替代生产 entry 的真实运行收据。
4. **宿主冻结 `StrategyStart`：代码路径已实现，真实任务待验。** `d404efb` 提供版本化、持久、宿主生成的 start record，将初始组件固定为 DAG，绑定 package/candidate/source digest 与来源 `host_policy`，并留下不含模型收据的决策事件。探针的 policy ID 固定为 `d1c_experimental_intervention`；不得通过真实启动 selector 或人工预填假的模型 receipt 达到这一点。

关闭前提后，须为每项增加定向离线测试，并把测试名称、执行 commit 和结果摘要写入 run manifest 的 preflight；本合同正文不因实现细节修复而回写成功声明。

## 5. 冻结系统身份

首次 Provider 请求前生成只读 `run_manifest`，至少冻结：

1. Git commit、dirty 状态；dirty 时记录全部执行源码逐文件 SHA-256。
2. AgentPackage ID/digest、公开 entry、候选集合及其 digest。
3. 两个候选且只能是：
   - `checkpoint-release-dag`：`kind=workflow`、`backend=executable_plan`；
   - `handoff-recovery-entry`：`kind=entry`、`backend=controlled_code`。
4. DAG workflow、entry source、checkpoint selector prompt、宿主 validator source、任务输入、公开 prompt、deliverable schema 和 evaluator 的 SHA-256。
5. `StrategyStart` schema、record digest、初始 DAG component/source digest。
6. 每个 Episode 的条件 ID、输入 digest、故障注入点和固定执行顺序。

任何身份变化终止该 attempt。修复后只能创建新 contract revision、attempt ID、manifest 和收据目录；不得覆盖旧行。

## 6. 真实模型与资源上限

模型配置沿用 D1-B 已审计边界：

- provider：`mimo`
- endpoint：`https://token-plan-cn.xiaomimimo.com/v1`
- configured / observed model：`mimo-v2.6-flash`
- credential reference：`NEXGENT_API_KEY`，凭据本身不得写入 prompt、日志或收据
- SDK 自动重试：`0`
- 每个模型调用 provider attempt：`1`

若任一已返回模型收据的 observed model 不是 `mimo-v2.6-flash`，该 Episode 记为配置失败，不计作 selector 或任务能力结果。

每个 Episode 使用同一根预算，DAG 草稿、checkpoint selector、entry 修复与 reviewer 全部计入：

| 资源 | 单 Episode 上限 |
| --- | ---: |
| 模型调用 | 5 |
| completion-token reservations | 12,000 |
| 本地 validator tool calls | 1 |
| tool work units | 1 |
| 运行节点 | 32 |
| DAG `max_parallel` | 4 |
| 绝对 wall clock | 180 秒 |

批次硬上限：4 个 Episode、20 次 started 模型调用、48,000 completion-token reservations、4 次 validator tool call、4 tool work units、128 个节点。达到任一上限即停止整个批次。恢复不得重置根 deadline 或预算。

## 7. 普通任务设置

### 7.1 公开任务

输入包含 base release policy、atlas／borealis／cygnus 三份独立服务报告，以及一个在草稿完成后由冻结 DAG 交给 validator 的 policy update。公开 prompt 为：

> 使用适用的发布政策逐项审查三份服务报告，并给出整个发布的结论。发布前可能出现经过验证的政策更新；最终审查必须使用最新适用政策并引用实际使用的输入工件。每个服务列出六项检查结果、是否通过及仅由输入支持的 blockers；总体结论严格应用 overall rule。按给定 schema 返回一个 JSON 对象。

公开文本不提 selector、DAG、entry、候选 ID、切换或预期路线。

### 7.2 冻结输入

Base policy：

```json
{
  "revision": 1,
  "service_pass_requires": {
    "tests_passed": true,
    "coverage_at_least": 80,
    "open_sev1": 0,
    "open_sev2": 0,
    "rollback_minutes_at_most": 15,
    "evidence_age_hours_at_most": 24
  },
  "overall_rule": "approve_only_if_every_service_passes"
}
```

服务报告沿用 D1-B 的公开值：atlas coverage 91、无 sev、rollback 12、age 3；borealis coverage 88、一个 open sev2、rollback 9、age 2；cygnus coverage 82、无 sev、rollback 18、age 6；三者 tests 均通过且 open sev1 均为 0。

Switch condition 的 update 只把 `revision` 改为 2，并把 `coverage_at_least` 从 80 改为 90。No-gap 与 infrastructure control 的 update 只把 `revision` 改为 2，所有判定阈值保持不变。

### 7.3 Deliverable

`release_review.json` 固定为：

```json
{
  "policy_revision": "integer",
  "per_service": [{
    "service": "string",
    "checks": {
      "tests_passed": "pass|fail",
      "coverage": "pass|fail",
      "open_sev1": "pass|fail",
      "open_sev2": "pass|fail",
      "rollback_minutes": "pass|fail",
      "evidence_age_hours": "pass|fail"
    },
    "passed": "boolean",
    "blockers": ["string"],
    "evidence_refs": ["string"]
  }],
  "overall": "approve|hold",
  "blocking_services": ["string"],
  "summary": "string"
}
```

## 8. 冻结 DAG、validator、selector 与 entry

### 8.1 DAG

DAG 依次执行：

1. 并行读取 base policy 和三份服务报告；
2. 一次 MiMo 调用生成 base-policy 草稿；
3. 发布中间草稿工件；
4. 本地通用 validator 读取草稿、base policy 和 policy update；
5. 在 validator 完成收据后评估 checkpoint；
6. 若继续，pending publisher 发布 validator 的**机械元数据归一化草稿**为最终工件：只把 `policy_revision` 从 1 改成已验证 update 的 2，并把每项 `evidence_refs` 中的 `release_policy.json` 换成 `policy_update.json`。六项检查、各服务 `passed`／`blockers`、整体结论、blocking services 和 summary 必须保持原值；不得由宿主修复任何实质判断。归一化前后内容与差异均保存摘要。

Checkpoint trigger 必须支配所有 pending descendants；validator 与 pending publisher 之间不得并行。旧 pending publisher 在 switch 后不得准入或执行。

### 8.2 宿主 validator

Validator 是纯本地、任务输入驱动的 JSON policy checker，不接收候选路线或预期 selector 输出。它必须分别给草稿按 base policy 和 updated policy 逐项评分，并返回输入、草稿、policy 和检查结果摘要。

它必须从**已发布草稿工件**读取内容并核验摘要；base-policy 前提采用完整交付合同（包括版本 1、schema、证据引用和 summary）。再把草稿做上述机械元数据归一化，并用 update policy 评价归一化副本的实质检查。归一化只供继续 DAG 的 pending publisher 使用，其允许修改的两个字段及前后摘要写入 validator 收据；任何其他字段改变均判为合同失败。对 material update，即使归一化元数据也不能改变旧的检查和 blockers，所以不能把旧草稿算作已修复。

- 草稿未通过 base policy：`precondition_failure`，不得把后续切换记为 H1 支持。
- 同时通过 base 与 update：输出 `compatible`，不含 `failure_domain`。
- 通过 base、未通过 material update：输出 `feedback.failure_domain=protocol`、变化字段、失败检查和全部 evidence refs。
- infrastructure control：使用冻结故障注入把反馈域投影为 `infrastructure`；不得调用 checkpoint selector。

模型不得自己赋予可接受的 `failure_domain`。

### 8.3 Checkpoint selector

Selector 只接收：公开任务投影、冻结候选集合、宿主验证反馈、当前 source segment、剩余根预算、已完成 artifact refs，以及由宿主生成的 bounded pending-plan／target-entry capability projection。它看不到路线无关 evaluator、预期动作、结果表或故障注入计划。

输出必须恰为：

```json
{"target_component_id":"handoff-recovery-entry|null","reason":"nonempty text"}
```

`null` 表示继续 DAG。无效 JSON、额外字段、未知 candidate 或第二次请求均直接判负；不得静默进入人工指定路线。

### 8.4 Handoff-aware entry

Entry 的第一项 host action 必须读取 `strategy_handoff_ref`。它随后核验 checkpoint、selector RPC、source segment、draft、validator feedback、policy update 和剩余预算，最多使用一次修复模型调用与一次独立 reviewer 调用，发布最终工件并返回真实 artifact ID。

Runtime 在完成前必须独立检查该 handoff read；entry 自述“已读取”不算证据。

## 9. 四个 Episode 与固定顺序

所有 Episode 按下列顺序创建且各创建一次。不得因先看到失败而跳过后续控制样本。

### 9.1 `D1C-SWITCH-PRIMARY`

- 输入：material update，coverage 80→90。
- 必要前提：DAG 草稿通过 base policy、未通过 update。
- 预期机制：checkpoint selector 返回 `handoff-recovery-entry`；原子提交 checkpoint 与 handoff；entry 读取 handoff 并完成修复。
- 预期质量：policy revision 2；atlas 通过；borealis blockers 恰为 `coverage`、`open_sev2`；cygnus blockers 恰为 `coverage`、`rollback_minutes`；overall `hold`；blocking services 恰为 borealis、cygnus。

### 9.2 `D1C-NO-GAP`

- 输入：semantically identical update，阈值不变。
- 预期机制：validator 输出 `compatible`；不发起 checkpoint selector；DAG pending publisher 发布仅做上述机械元数据归一化的草稿。
- 预期质量：policy revision 2；atlas 通过；borealis 只因 `open_sev2` 失败；cygnus 只因 `rollback_minutes` 失败；overall `hold`。

### 9.3 `D1C-INFRA-CONTROL`

- 输入：阈值不变；冻结 fault injector 使 diagnostic feedback 的 failure domain 为 `infrastructure`。
- 预期机制：不发起 checkpoint selector、不切换；DAG 完成。
- 预期质量：与 no-gap 相同。
- 禁止把 provider transport、wall timeout、远端结果未知或宿主恢复状态解释为 agent/protocol 缺口。

### 9.4 `D1C-SWITCH-RECOVERY`

- 输入：与 primary 完全相同。
- 注入点：checkpoint 和 handoff 已原子提交，target entry 尚未进入。
- 在同一 Episode 上重建 TaskService 并恢复；不得创建替代 Episode。
- 预期机制及质量：与 primary 相同；checkpoint selector 只调用一次；handoff/artifact/call/deadline/digest 均保持原身份。

## 10. 统一停止规则与 no-cherry-pick 约束

每个 Episode 在下列任一条件发生时立即停止：

- 合法最终 deliverable 发布、后端正常结束并完成路线无关评价；
- 根预算、批次预算或原始 wall deadline 到达；
- package、candidate、source、task、prompt、validator 或 evaluator digest 漂移；
- configured／observed model 不符；
- selector 输出非法、未知 target、或 checkpoint／handoff 身份不一致；
- Provider transport 失败或远端结果未知；此时记录基础设施状态，禁止重发或换路线；
- switched entry 未先读取准确 handoff；
- evaluator 输入包含 route、selector、checkpoint 或 backend 元数据。

固定约束：

1. 每个预注册 Episode 只创建一次。
2. 不修改 prompt、任务、输入、预算、阈值或执行顺序来挽救本 attempt。
3. 不增加模型自动重试、候选采样、人工挑选 selector 响应或额外 repair。
4. 不删除 missing、invalid、timeout、budget exhausted、remote outcome unknown 或质量失败行。
5. 实现修复后使用新 attempt ID 和 manifest；旧收据保持原样。

## 11. 路线无关独立评价

Evaluator 只接收 Episode condition ID、冻结输入和最终 `release_review.json`。不得接收 StrategyStart、selector、checkpoint、component ID、backend、调用成本、节点轨迹或 Episode 状态。

先做 JSON/schema 验证，再按 condition 对应的有效 policy 评分。每项均为 critical，要求 12/12：

1. `policy_revision == 2`；
2. atlas 六项检查、passed 和 blockers 精确；
3. borealis 六项检查、passed 和 blockers 精确；
4. cygnus 六项检查、passed 和 blockers 精确；
5. 每个服务 evidence refs 包含其报告和实际有效 policy，不引用别的服务报告；
6. 三个服务集合完整、唯一；
7. `overall == hold`；
8. `blocking_services` 恰为 borealis、cygnus；
9. summary 不把 atlas 写成 blocker；
10. summary 不新增输入外事实；
11. overall 与 per-service 结果一致；
12. 所有 blocker 字段恰等于失败检查字段。

机械完成、selector 理由、内部 reviewer 批准和 `active_strategy` 均不能替代该评分。

## 12. 必须保存的证据

每个 Episode 至少保存：

- run／attempt／condition／Episode／root Episode ID，创建、开始、结束时间；
- Git、run manifest、package、candidate set、StrategyStart、selector、DAG、entry、validator、task、prompt、schema、input 和 evaluator digest；
- 初始预算，DAG 草稿后、checkpoint 前后、switch 后和结束时的用量／预留／剩余量；原始绝对 deadline；
- 全部模型收据：call ID、role、configured／observed model、provider revision、request／response digest、status、finish reason、billing status、usage、attempt count；
- DAG plan/ref/revision、节点状态、RPC path、输入／输出 artifact refs；
- 草稿 artifact ID/digest、base/update policy digest、validator 逐项结果与 feedback digest；若继续，保存机械元数据归一化前后内容摘要与精确字段差异；
- checkpoint selector 请求投影、原始响应、解析结果和 RPC journal；
- StrategyCheckpoint、source segment、trigger receipt、pending node IDs、resolution、root budget snapshot；
- handoff artifact ID/digest/content projection及原子发布事件；
- target segment 的全部 host action，尤其是准确 handoff read 位于首个 action；
- 旧 pending publisher 未运行的负证据；
- `strategy_entered` 和完成态 `execution.active_strategy`；
- 最终 artifact ID/digest，路线无关逐项评价、总分、critical 状态和 evaluator digest；
- recovery 注入前、恢复后快照：selector call IDs、checkpoint/handoff/artifact IDs、完成 RPC IDs、usage、deadline 和事件链头；
- failure stage、failure class、remote outcome unknown、最后持久事件和是否恢复。

结果表按 Episode 固定四行，禁止删除：

| condition | task digest | start strategy | feedback verdict | selector receipt | checkpoint action | target backend | handoff consumed | model calls | reserved tokens | deadline stable | artifact digest | quality | failure class |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: | --- | --- | --- | --- |

## 13. 参考机制边界

- AutoSci 论文把反馈与 SciDAG、技能、模板的更新连接起来；本仓库已审计的 `arxiv-v1` executor 运行完整采样图，不能作为同一 Episode 跨后端持久切换的现成证据。
- AFlow 使用外层 MCTS 式搜索执行、评分并更新代码工作流；跨候选搜索不能替代 partial Episode 的 handoff 与 exactly-once 恢复。
- ADAS 的固定 meta agent 生成、调试并归档完整 executable agent；这支持可执行 O/S 候选思想，不证明运行中从部分 DAG 切到代码 entry。

本探针只补充 Nexgent 自身的同 Episode runtime handoff 证据。后续若要检验效果，必须另行预注册固定 DAG、固定 entry、同资源单智能体和必要的 review/revise 对照；不得把本机制探针改写成 D1-D 效果研究。
