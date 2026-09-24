# D1-B 真实模型任务内执行策略选择合同

状态：预注册，尚未运行

日期：2026-09-24
范围：D1-B.1 机制验证

## 1. 问题与主张边界

本试验只回答一个可证伪问题：同一个 adaptive Main `AgentPackage`、同一个公开 `execute` 入口，能否让一次真实 MiMo selector 根据普通任务的可观察特征作出一次持久决策，并让运行时实际进入与该决策绑定的开放循环或 DAG 后端。

已知起点是：

- [`REFACTOR_PLAN.md`](../../REFACTOR_PLAN.md) 的 D1-B.0 已把真实开放循环和 Main DAG 放进同包的两个 O 候选，但旧 `orchestrator` 仍静态指向 DAG；这不是任务内选择证据。
- [`adaptive-orchestration-switch-v1.md`](../../docs/design/adaptive-orchestration-switch-v1.md) 要求 selector、决策身份、实际后端、预算和恢复分别留痕，且不允许无效选择静默落到人工指定的成功路径。
- [既有 MiMo 记录](../kernel_spike/RESULTS.md#main-图种子的四次真实服务任务负结果与合同修复)表明 `mimo-v2.6-flash` 已经真实进入普通开放循环和 Main 图相关路径，但四次图任务都没有通过独立任务质量判断；v3 的机械 `completed` 也因输入证据被服务清空和答案泄露而判负。该负证据必须保留，不能由本试验覆盖。

因此，本试验不是 F 阶段的正式效果研究：不估计平均成功率、效应量或成本收益，不比较固定 DAG、固定开放循环、单智能体和记忆组，也不宣称正向 RSI、递归改进、跨任务采用或 D1-C 的中途重选。任务质量分只用于判断本次机制运行是否交付了有效结果。

## 2. 预注册假设与判负条件

| 编号 | 假设 | 支持条件 | 直接判负 |
| --- | --- | --- | --- |
| H1 | selector 能按任务形态区分两个冻结候选 | `TASK-OL-01` 选择 `ordinary-open-loop`，`TASK-DAG-01` 选择 `self-orchestration-workflow` | 任一任务无合法决策、选反、或两个任务都选同一候选 |
| H2 | 决策会控制实际后端 | 两个主运行的 `active_strategy` 均回指各自 decision，且实际 RPC／节点轨迹、组件和源码摘要一致 | 只从 manifest 推断、实际后端不符、加载未执行候选、或失败后伪造成功激活 |
| H3 | 持久恢复不会重复付费动作 | 恢复运行在三个注入点前后保持 selector／后端调用计数和工件身份不变；结果未知的 selector 不重发 | 任一已完成模型调用、工具调用或发布动作被重放；wall clock 被重置；未知结果被当作编排失败换路 |
| H4 | 所选路径能完成对应普通任务 | 两个主运行均通过各自独立、与路线无关的确定性评分门 | 机械完成但任务分不达门，或评分器收到 selector／路线信息 |

只有 H1–H4 全部满足，才记为“支持 D1-B 真实模型机制小样”。任一判负条件发生即如实报告该项失败，不通过改 prompt、换任务或额外尝试把同一预注册运行改成成功样本。

## 3. 冻结系统身份

运行前生成只读 `run_manifest`，在首次 provider 请求前冻结并记录以下身份：

1. 当前 Git commit 和 dirty 状态；dirty 时记录被执行源码的逐文件 SHA-256，不以分支名代替。
2. `adaptive_orchestration_package()` 的 package ID／digest、`agent/main.py:execute` 的公开入口、候选集合及其 digest。
3. 两个候选必须且只能是：
   - `ordinary-open-loop`：`shape=open_loop`、`backend=controlled_code`；
   - `self-orchestration-workflow`：`shape=dag`、`backend=executable_plan`。
4. 每个候选的 O 组件 digest、source path 和 source digest；候选顺序使用宿主规范化结果，不按预期答案重排。
5. selector 组件／提示模板的 ID 和 source digest。selector 不得写入、修改或扩权候选包。
6. 本文两个任务的规范 JSON、公开 prompt、输入工件内容和输出 schema 的 SHA-256。

两个主运行必须复用完全相同的 package digest、candidate-set digest、selector digest、公开 entry 和 authority。任何身份变化都终止当前批次；修复后只能新增带新 manifest digest 的批次，不能覆盖旧收据。

## 4. 真实模型与统一资源上限

模型配置沿用已有授权配置和既有真实证据的边界：

- provider：`mimo`
- endpoint：`https://token-plan-cn.xiaomimimo.com/v1`
- configured / observed model：`mimo-v2.6-flash`
- credential reference：`NEXGENT_API_KEY`；凭据本身不得进入 prompt、日志或收据
- SDK 自动重试：`0`
- 每个模型调用的 provider attempt：`1`

运行时记录完整 profile identity、profile digest、`models.json` SHA-256、configured model、observed model 和 provider revision（若 provider 不返回则明确为 `null`）。若实际模型不等于 `mimo-v2.6-flash`，该 Episode 判为配置失败，不计作模型选择结果。

每个 Episode 使用同一根预算，selector 消耗也计入其中：

| 资源 | 上限 |
| --- | ---: |
| selector 调用 | 1 |
| selector completion reservation | 1,200 tokens |
| 全部模型调用（含 selector） | 8 |
| 全部 completion reservations | 28,000 tokens |
| 工具／服务调用 | 0 |
| tool work units | 0 |
| 运行节点 | 100 |
| DAG `max_parallel` | 沿用冻结包，且不得超过 8 |
| Episode 总 wall clock | 180 秒，恢复后不得重置 |

输入只能来自本合同冻结的工件；不安装工具、服务或技能，不联网，不开发新能力，不读取评分答案。策略内部允许包本身已有的 reviewer／计划修订，但所有调用仍受根预算约束；宿主不追加隐式模型重试。

## 5. Selector 输入与输出

selector 只接收：任务 objective、公开 prompt、输入工件名称及 schema、deliverable schema、根预算剩余量，以及宿主验证后的 candidate-set 投影。它看不到第 7 节评分规则、预期路线、既有运行结果或故障注入计划。

统一 selector 指令为：

> 根据任务目标、可用输入、交付合同、剩余资源和冻结候选元数据，选择最可能在限制内可靠完成任务的一个候选。依据只能引用当前任务可观察的结构或依赖关系；给出完成或停止的条件和保守资源估计。返回指定 JSON，不提出新候选，不修改任务，不假定私有评分标准。

模型输出必须恰为 `parse_strategy_decision` 接受的四个字段：`selected_component_id`、`basis`、`stop_conditions`、`estimated_cost`。package、candidate、source、backend、schema、decision ID、预算身份和 digest 全部由宿主反解；模型提交这些字段或未知 component 时直接失败。selector 输出无效时不进行第二次请求，也不退回 manifest 的静态 `orchestrator`。

## 6. 两个普通任务

下列文本就是传给任务后端的公开任务。正文不提 selector、DAG、开放循环、代码、候选 ID 或预期路线。

### 6.1 `TASK-OL-01`：事件通报

输入工件 `incident_notes.json`：

```json
{
  "incident_id": "INC-204",
  "audience": "internal_service_owners",
  "observations": [
    {"at": "09:10 UTC", "code": "read_p95_breached", "fact": "Read p95 latency rose above 2 seconds."},
    {"at": "09:14 UTC", "code": "writes_within_slo", "fact": "The write path remained within SLO."},
    {"at": "09:18 UTC", "code": "cache_pool_rolled_back", "fact": "The cache-pool configuration was rolled back."},
    {"at": "09:24 UTC", "code": "read_p95_normal", "fact": "Read p95 latency returned to its normal range."}
  ],
  "cause": "unknown",
  "correlation_under_investigation": "cache_configuration_rollout",
  "requested_action": {
    "do_not": "retry_completed_writes",
    "report": "request_ids_for_reads_over_2_seconds"
  },
  "next_update": "10:30 UTC"
}
```

公开 prompt：

> 根据事件记录为内部服务负责人生成一份简短状态通报。严格区分观测事实、未知原因和正在调查的相关性；不要补充未给出的影响、原因或恢复保证。按给定 schema 返回一个 JSON 对象，`brief` 应能脱离原始记录独立阅读。

deliverable `incident_update.json` 的字段固定为：

```json
{
  "incident_id": "string",
  "status": "investigating|monitoring|resolved",
  "impact": {"degraded": ["string"], "unaffected": ["string"]},
  "timeline": [{"at": "string", "code": "string"}],
  "cause": "string",
  "correlation_under_investigation": "string",
  "action": {"do_not": "string", "report": "string"},
  "next_update": "string",
  "brief": "string"
}
```

预注册任务形态判断（不传给模型）：单一、小型工件中的事实彼此耦合，主要工作是一次综合撰写和一次一致性复核；拆成并行分支增加合并矛盾的机会而没有独立搜索价值。因此 H1 预期 `ordinary-open-loop`。

### 6.2 `TASK-DAG-01`：三服务发布审查

输入工件 `release_policy.json`：

```json
{
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

三个互相独立的输入工件：

```json
{"service":"atlas","tests_passed":true,"coverage":91,"open_sev1":0,"open_sev2":0,"rollback_minutes":12,"evidence_age_hours":3}
```

```json
{"service":"borealis","tests_passed":true,"coverage":88,"open_sev1":0,"open_sev2":1,"rollback_minutes":9,"evidence_age_hours":2}
```

```json
{"service":"cygnus","tests_passed":true,"coverage":82,"open_sev1":0,"open_sev2":0,"rollback_minutes":18,"evidence_age_hours":6}
```

工件名依次为 `atlas_report.json`、`borealis_report.json`、`cygnus_report.json`。公开 prompt：

> 使用发布政策逐项审查三份服务报告，再给出整个发布的结论。每个服务都要列出六项检查结果、是否通过和仅由输入支持的 blockers；blockers 使用未通过检查的字段名。总体结论必须严格应用 overall rule。按给定 schema 返回一个 JSON 对象，并让 evidence_refs 指向实际使用的输入工件名。

deliverable `release_review.json` 的字段固定为：

```json
{
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

预注册任务形态判断（不传给模型）：三个服务可用相同政策独立审查，随后必须聚合并对 overall rule 做一次独立验证；并行分支和汇合验证均有可观察价值。因此 H1 预期 `self-orchestration-workflow`。这只是本次任务的事前预测，不是 DAG 普遍优于开放循环的主张。

## 7. 与策略无关的独立质量评价

评分器只接收 task ID、冻结输入和最终 deliverable；不得接收 decision、selector basis、组件 ID、backend、调用成本或 Episode 状态。评分代码／人工复核者在两个主运行均结束前不得改门槛。先做 JSON/schema 验证，再按规范值评分；数组顺序除 timeline 外不影响得分，文本按 Unicode trim 后比较。

### 7.1 `TASK-OL-01`（10 分，9 分通过）

每项 1 分：

1. `incident_id == INC-204`；
2. `status == monitoring`；
3. degraded 只包含 `read_latency`，unaffected 只包含 `write_path`；
4. timeline 按时间完整保留四个 `at`／`code` 对；
5. `cause == unknown`；
6. correlation 为 `cache_configuration_rollout`，且 brief 没把它写成已证实原因；
7. action 的两个值与输入完全一致；
8. `next_update == 10:30 UTC`；
9. brief 同时明确读延迟影响、写路径未受影响和当前已恢复正常范围；
10. brief 不宣称事故已解决、不新增用户数、地域、数据丢失或根因。

第 4、6、10 项是 critical；任一为 0 即使总分达到 9 也判负。评分器只做事实／禁称检查，不评价文风。

### 7.2 `TASK-DAG-01`（12 分，12 分通过）

- atlas 六项全 `pass`、`passed=true`、blockers 为空：2 分；
- borealis 仅 `open_sev2=fail`、`passed=false`，blockers 恰为 `["open_sev2"]`：2 分；
- cygnus 仅 `rollback_minutes=fail`、`passed=false`，blockers 恰为 `["rollback_minutes"]`：2 分；
- 三个服务各自只引用对应报告和 `release_policy.json`：1 分；
- `overall=hold`：1 分；
- `blocking_services` 恰为 borealis、cygnus：1 分；
- summary 不把 atlas 写成 blocker，也不添加输入外事实：1 分；
- per-service 记录不缺项、不重复，服务集合恰为三项：1 分；
- overall 结论与 per-service 判断一致：1 分。

所有项都是 critical；这里使用满分门是因为答案完全由结构化政策决定。机械 `completed`、selector 自述和内部 reviewer 批准均不能替代该评分。

## 8. 主运行、恢复探针与停止规则

按固定顺序创建四个 Episode，全部保留；不得因先看到一个失败而跳过另一个主任务：

1. `D1B-OL-PRIMARY`：`TASK-OL-01`，无故障注入。
2. `D1B-DAG-PRIMARY`：`TASK-DAG-01`，无故障注入。
3. `D1B-OL-RECOVERY`：`TASK-OL-01`，在同一 Episode 中依次注入并恢复：
   - selector 响应和 completed receipt 已持久化、decision 尚未提交；
   - decision 已提交、首个后端付费调用尚未开始；
   - 首个后端模型 completed receipt 已持久化、其结果尚未推进下一状态。
4. `D1B-SELECTOR-UNKNOWN`：`TASK-OL-01`，selector `started` 已持久化且请求已经发出，在 completed receipt 持久化前中断。恢复后必须停在 `remote_outcome_unknown`／需人工处理状态，不得重发、换候选或声称激活成功。这是预期的有界负样本，不要求任务完成。

前三个注入点每次恢复后核对：selector `call_id`、decision digest、已完成后端 `call_id`、工件 ID、累计 usage 和原始 deadline 均不变。`D1B-OL-RECOVERY` 最终 deliverable 必须通过同一个独立评分器；它用于 exactly-once 机制，不作为第三个任务质量样本。

统一停止规则：

- 合法 deliverable 发布且策略后端正常结束时停止；
- 任一根预算、原始 deadline、身份校验或权限校验触发时立即停止；
- selector 非法输出、未知 component、candidate digest 漂移、observed model 不符时立即失败；
- provider transport 失败或远端结果未知时记录基础设施状态，禁止解释为编排失败后切换路线；
- 后端计划编译／执行失败可以使用冻结策略自身已有的有界修订，但不能重新调用 selector，也不能静默进入另一候选；
- 每个预注册 Episode 只创建一次。代码修复或合同修订必须使用新 attempt ID，并在旧失败记录之后追加，不覆盖或删除旧记录。

批次硬上限为上述 4 个 Episode、32 次 started 模型调用和 112,000 completion-token reservations；达到任一上限即停止整个批次。`D1B-SELECTOR-UNKNOWN` 即使 provider 最终计费也只占已有上限，不授权第二次调用。

## 9. 必须保存的收据

每个 Episode 至少保存以下脱敏字段；缺一不可补推：

- run／attempt／task／Episode ID，创建与完成时间，Git 与 run-manifest digest；
- package、candidate set、selector、公开 entry、input、prompt、schema 和 evaluator digests；
- 初始预算，selector 前后和执行结束时的已用／预留／剩余预算，原始与恢复后的 wall-clock deadline；
- selector receipt：call ID、role、configured／observed model、provider revision、request／response digest、status、finish reason、billing status、usage、attempt count；
- StrategyDecision：schema、decision ID／digest、candidate-set digest、selector receipt ID、所选组件及 source digest、basis、stop conditions、estimated cost、提交事件序号；
- 后端进入事件与 `execution.active_strategy`：decision ID／digest、组件 ID、kind、backend、package／source digest、首个实际 RPC 或 DAG node receipt、最终状态；
- 全部模型／节点／工件事件，输出工件 ID／digest，恢复点前后计数；
- 独立评分逐项结果、总分、critical 项和评分器 digest；
- failure stage、failure class、`remote_outcome_unknown`、最后一个持久事件和是否恢复。

`active_strategy` 只能由真实 controlled-code worker 或 executable-plan 调度轨迹形成。仅存在候选文件、加载模块、manifest `orchestrator` 或 selector 文本不算激活。失败运行可以记录 `strategy_entered`，但没有成功后端收据时不得写成成功激活。

## 10. 结果表与解释规则

运行完成后追加一张不删除行的结果表：

| attempt | task digest | selector receipt | decision | selected component | actual backend | activation verified | model calls | tokens | nodes | artifact digest | quality | recovery | failure class |
| --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- | --- |

解释优先级固定如下：

1. selector 合法且路线符合预注册，但实际后端不符：运行时绑定失败，H2 判负；
2. 实际后端吻合但路线选反：任务适配选择假设失败，H1 判负；即使任务质量通过也不改判；
3. 路线和激活正确但质量不通过：本次策略选择没有形成有效交付，H4 判负；
4. 质量通过但缺 selector 或激活收据：只记录任务完成，不支持 D1-B；
5. 额外模型调用、重放工件或 deadline 重置解释了完成：H3 判负；
6. 两个主运行和恢复均通过：只报告“D1-B 机制小样得到支持”，不得外推为策略优于固定基线、正向 RSI、D1-C 中途切换或 F 阶段效果。

任何负结果都保留原始脱敏收据、任务分和失败分类。后续修复后的运行必须另列 attempt、commit、package digest 和合同修订号，不能把新结果写回旧行。
