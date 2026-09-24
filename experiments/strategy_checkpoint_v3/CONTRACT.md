# D1-C.3 反馈检查点实验：机制隔离、端到端复现与冻结对照

日期：2026-09-24。合同修订：`2026-09-24/D1-C.3`。状态：**READY；协议已冻结，尚未实现或运行。**

`READY` 只表示本协议可以进入实现与离线预检。首次 Provider 请求仍须满足第 10 节全部门槛，并生成新的只读 manifest。任何实现修复、合同变化或 manifest 漂移都必须使用新的 revision、attempt ID 和收据目录。

本实验研究一个任务类型无关的框架机制：普通任务执行到持久化反馈检查点后，能否根据宿主验证的任务反馈，在同一 Episode、同一根预算和同一绝对截止时间内继续当前 DAG 或切换到另一个已登记能力，并形成可恢复、可评价的交付。

三服务发布审查仅是实验包中的可确定性评分任务。核心运行时不得包含服务名、发布规则、blocker 字段或本合同的预期路线。实验结论不得外推为通用 RSI、跨任务学习或持续进化收益。

## 1. 与 D1-C.2 探索性失败的边界

旧目录 [`../strategy_checkpoint/`](../strategy_checkpoint/) 及其合同、执行器、评价器、结果和原始收据保持只读。D1-C.3 不回写、不重评分，也不把旧 attempt 改称确认性实验。

D1-C.2 的四行真实 MiMo 样本均在 checkpoint selector 前因 `precondition_failure` 停止。公开 schema 允许任意 blocker 文本，评价器却要求内部字段名；模型可见的是对象路径，评价器却要求未暴露的工件名；summary 的邻近正则还可能把后文失败错误归给前文服务。因此旧尝试没有检验 selector、handoff、切换后端或恢复。

D1-C.3 用两个顺序阶段拆开这两个问题：

1. **D1-C.3a 机制隔离**：宿主从冻结输入生成确定性、完整且已验证的 base-valid 草稿，不调用 drafter 模型。只检验真实 selector、checkpoint、handoff、目标能力执行和恢复。
2. **D1-C.3b 端到端复现**：恢复一次真实模型 drafter。先按同一公开合同独立判断草稿是否 base-valid，再检验后续机制。3b 的 drafter 失败单独记为任务／协议能力失败，不得覆盖 3a 的机制结论。

只有 3a 达到预注册通过条件后才运行 3b；只有 3a、3b 均完成后才运行第 8 节冻结对照。前一阶段失败仍保留全部行，并停止后续 Provider 调用；若要研究失败后的其他阶段，须注册新 attempt，而不是在本批次临时放行。

## 2. 研究问题与结论上限

### 2.1 D1-C.3a

在 base-valid 草稿已经由确定性机制保证的情况下，真实 `mimo-v2.6-flash` checkpoint selector 能否只在 material protocol gap 时选择已登记 entry；运行时能否原子提交 checkpoint 与 handoff，阻止旧 DAG 后继节点，并让 entry 在同一预算内读取 handoff、修复并完成？

若 3a 全部通过，只允许报告：

> 在一个冻结任务包中，真实 selector 驱动的 DAG→entry 中途切换、handoff 消费和恢复机制得到单样本支持；该结论不包含模型起草能力或相对效益。

### 2.2 D1-C.3b

在公开输出合同与评价合同一致、稳定证据引用显式可见时，真实 drafter 能否生成 base-valid 草稿，并使同一检查点机制完成端到端任务？

若 3b 全部通过，只允许报告：

> 在一个冻结任务包中，真实模型起草、反馈驱动切换和最终交付的端到端链路得到单样本支持。

### 2.3 对照

固定 DAG、always-entry 与 adaptive 三组只回答同一输入、同一模型、同一有效预算下的相对结果。单次通过不得宣称普遍优越；没有至少预注册重复数与跨任务族验证，不得宣称通用编排收益、跨任务学习、递归改进或 RSI 效益。

## 3. 冻结的公开任务接口

### 3.1 稳定证据引用

所有可被输出引用的证据 ID 在任务输入、公开 prompt 和 schema 中逐字暴露，并与 manifest 中内容摘要绑定：

| 语义 | 稳定公开 ID |
| --- | --- |
| base policy | `evidence://policy/base/v1` |
| update policy | `evidence://policy/update/v2` |
| atlas report | `evidence://report/atlas/v1` |
| borealis report | `evidence://report/borealis/v1` |
| cygnus report | `evidence://report/cygnus/v1` |

模型不得看到本地文件名或内部 artifact ID 后再被要求猜公开 ID。宿主在运行前验证五个公开 ID 唯一、可解析、内容摘要与 manifest 一致。模型输出只能引用该 allowlist；运行收据另行保存公开 ID 到内部 artifact ID 的映射，该映射不进入 evaluator。

### 3.2 结构化 blocker

每个服务的失败原因使用结构化对象，避免把自然语言表述当作字段名：

```json
{
  "check": "coverage",
  "observed": 88,
  "operator": ">=",
  "required": 90,
  "evidence_ref": "evidence://report/borealis/v1",
  "detail": "coverage 88 is below required 90"
}
```

`check` 必须来自六项冻结枚举；`observed`、`operator`、`required` 和 `evidence_ref` 按输入精确评分。`detail` 由这四个结构化字段通过公开模板机械渲染，模型可以输出，但 evaluator 先独立重建再做精确比较。任何同义改写不影响其他评分，也不能弥补结构字段错误。

### 3.3 Deliverable schema

```json
{
  "policy_revision": 2,
  "per_service": [{
    "service": "atlas|borealis|cygnus",
    "checks": {
      "tests_passed": "pass|fail",
      "coverage": "pass|fail",
      "open_sev1": "pass|fail",
      "open_sev2": "pass|fail",
      "rollback_minutes": "pass|fail",
      "evidence_age_hours": "pass|fail"
    },
    "passed": true,
    "blockers": [{
      "check": "coverage|open_sev1|open_sev2|rollback_minutes|evidence_age_hours|tests_passed",
      "observed": "number|boolean",
      "operator": "==|>=|<=",
      "required": "number|boolean",
      "evidence_ref": "stable public evidence ID",
      "detail": "mechanically rendered string"
    }],
    "evidence_refs": ["stable public evidence IDs"]
  }],
  "overall": "approve|hold",
  "blocking_services": ["atlas|borealis|cygnus"],
  "summary": {
    "decision": "approve|hold",
    "passing_services": ["atlas|borealis|cygnus"],
    "blocking_services": ["atlas|borealis|cygnus"]
  },
  "narrative": "optional unscored text"
}
```

`summary` 是结构化字段，按集合和 decision 精确评分。评价器禁止用正则、词距或邻近窗口从 `narrative` 推断哪个服务失败；`narrative` 不计分，只做 schema 大小和凭据泄露检查。离线测试必须覆盖服务顺序置换、同义表达、`atlas` 后紧邻 `borealis failed`、否定句和空 narrative，证明不会再次出现 summary 假阳性。

## 4. 冻结输入与任务期望

沿用三份公开服务数值和 base policy：coverage 阈值 80，其他阈值不变；material update 把 revision 从 1 改成 2，并把 coverage 阈值从 80 改成 90；compatible update 只改 revision。

在 material update 下，最终结果固定为：atlas 通过；borealis 因 `coverage` 与 `open_sev2` 失败；cygnus 因 `coverage` 与 `rollback_minutes` 失败；overall 为 `hold`；blocking services 恰为 borealis、cygnus。

在 compatible update 下，borealis 只因 `open_sev2` 失败，cygnus 只因 `rollback_minutes` 失败，其余结论相同。

公开 prompt 只描述任务、stable evidence IDs、schema、blocker 模板和“最终结果使用最新适用 policy”。它不提 DAG、entry、selector、checkpoint、预期路线、实验臂或评价分数。

## 5. D1-C.3a：确定性 base-valid 草稿的机制隔离

### 5.1 草稿来源

宿主使用冻结纯函数 `build_base_valid_draft(base_policy, reports, evidence_map)` 生成 revision 1 草稿。该函数不得读取 update、条件 ID、策略候选、预期路线或 evaluator 输出。草稿必须先由独立 base evaluator 得到满分，保存内容、摘要和构造器摘要；否则整个 attempt 在任何 Provider 请求前失败。

确定性草稿是实验干预，不是框架能力。3a 的结果不得计入 drafter 模型质量，也不得作为最终对照的交付分数。

### 5.2 四个机制 Episode

固定顺序如下，每行只创建一次：

1. `D1C3A-SWITCH-PRIMARY`：material update；validator 产生 protocol gap；真实 selector 应选择 entry；entry 完成。
2. `D1C3A-NO-GAP`：compatible update；不调用 selector；DAG 只做允许的 revision 与 policy evidence ref 归一化后完成。
3. `D1C3A-INFRA-CONTROL`：compatible update；冻结故障投影为 infrastructure；不调用 selector、不切换，DAG 完成。
4. `D1C3A-SWITCH-RECOVERY`：同 primary；在 checkpoint 与 handoff 原子提交后、entry 尚未进入时重建服务，并恢复同一 Episode。

真实 selector 只接收公开任务投影、候选能力描述、宿主验证反馈、已完成 artifact refs、bounded pending-plan、target capability、剩余根预算。输出只允许：

```json
{"target_component_id":"handoff-recovery-entry|null","reason":"nonempty text"}
```

未知候选、额外字段、无效 JSON、第二次 selector 请求或宿主替代决策均直接判负。切换后 entry 的第一项 host action 必须读取准确 handoff；旧 DAG pending publisher 不得准入。

### 5.3 3a 通过条件

四行最终任务质量均通过；两条 material 行各有且只有一次真实 selector 调用、一次原子 checkpoint/handoff、准确 first-action handoff read 和真实 entry 完成；两个控制行 selector 调用为零；恢复行不重复 selector、预算、deadline、RPC、artifact 或工件。

任一 material 行在 selector 前失败，记为“机制未触达”；selector 进入后失败，按 selector、checkpoint、handoff、entry 或 final quality 分层记录。不得把 `continue_without_selector` 写成模型选择 continue。

## 6. D1-C.3b：真实模型草稿端到端

3b 使用与 3a 相同的公开输入、schema、stable evidence IDs、validator、selector、entry 和评价器，只把确定性 drafter 替换为一次真实 `mimo-v2.6-flash` drafter 调用。

固定四行及顺序为 `D1C3B-SWITCH-PRIMARY`、`D1C3B-NO-GAP`、`D1C3B-INFRA-CONTROL`、`D1C3B-SWITCH-RECOVERY`。不得从多个草稿中挑选，不得人工补字段，也不得在 base evaluator 失败后调用 selector。

每个草稿的 base 评价单独保存：

- base-valid：按原计划继续；
- JSON/schema invalid：`draft_protocol_failure`；
- schema valid 但任务判断错误：`draft_semantic_failure`；
- stable evidence ref 或 blocker 模板错误：记录对应结构化 criterion，不合并成编排失败；
- Provider transport 或远端结果未知：按基础设施状态终止，不重发。

3b 通过要求四行 drafter 都 base-valid，并满足与 3a 相同的机制与最终质量条件。任何一行失败都原样保留；不得用 3a 草稿替换 3b 草稿。

## 7. 路线盲独立评价

Evaluator API 固定为：

```text
evaluate(opaque_sample_id, final_content, frozen_public_inputs) -> score_record
```

`opaque_sample_id` 只用于回填行身份，不参与分支或期望计算。Evaluator 只能看到有效 policy、三份 report、stable evidence map、deliverable schema 和最终内容。以下任一信息进入 evaluator 都使该行无效：arm、adaptive／fixed、DAG、entry、selector、checkpoint、handoff、component ID、backend、预算、模型调用数、节点轨迹、恢复标记或预期路线。

评分全部由结构字段精确计算：schema、policy revision、三服务六项 checks、passed、结构化 blockers、evidence refs、服务集合、overall、blocking services、结构化 summary、overall consistency。禁止正则解释自由文本，禁止读取 agent 自评、reviewer 批准或 `active_strategy`。

离线隔离测试必须证明：

1. 相同公开输入和 final content 在不同 opaque ID、路线及 trace 下得到相同评分字段；
2. evaluator wrapper 只传三个 API 参数，序列化输入不含禁词或路线对象；
3. 结构化 summary 的顺序置换不改变集合评分；自由 narrative 的同义表达、否定句和邻近词不改变分数；
4. blocker 的 `check`、数值、operator、required、evidence ref 或机械 detail 任一错误只触发对应 criterion；
5. 输入、schema、evaluator digest 固定后，已有行永不重新评分。

## 8. 冻结相对对照：fixed-DAG、always-entry、adaptive

只有 3a 和 3b 按本合同完成后，才在一个新的 control run 中执行三臂比较。三臂共享同一批冻结任务实例、模型版本、公开 prompt、能力实现、evaluator、绝对 deadline 和**实际可用的根预算上限**；未使用预算不补发调用。

| 实验臂 | 冻结行为 | 允许调用 |
| --- | --- | --- |
| `fixed-dag` | 始终执行完整 DAG；validator 后不调用 selector，不进入 entry | drafter + DAG reviewer；调用上限与 adaptive 相同 |
| `always-entry` | 从任务开始直接进入同一个 handoff-aware entry；使用由宿主生成的初始 task handoff | entry worker + reviewer；调用上限与 adaptive 相同 |
| `adaptive` | 从同一 DAG 开始；仅在可归因 protocol gap 时允许一次 selector 和 DAG→entry | drafter + selector（若触发）+ entry worker/reviewer，受同一总上限约束 |

对照任务不得使用 3a 的确定性草稿；三臂均使用同一真实模型 drafter 条件。任务实例、执行顺序和 seed 在 manifest 中冻结，并采用预注册的平衡顺序，避免总是让 adaptive 最后运行。每个任务实例只运行一次每臂，不挑选最佳输出。

主要终点按优先级固定为：路线盲最终任务通过率、有效交付率、模型 started calls、completion reservations、wall time。机制指标（selector 精度、handoff 正确性、恢复 exactly-once）单独报告，不与任务质量合成单一分数。任何 post-hoc 权重、阈值、评分修复或排除行都禁止。

本合同只冻结单任务包的 smoke comparison；它可以发现实现或协议错误，但不足以得出统计优越结论。正式效益研究必须另行预注册重复数、任务族、seed、主效应和统计方法。

## 9. 模型、预算、停止和 no-cherry-pick

Provider 固定为 MiMo，endpoint `https://token-plan-cn.xiaomimimo.com/v1`，configured/observed model 均须为 `mimo-v2.6-flash`，SDK 自动重试为 0，每个模型调用 provider attempt 为 1。凭据只从 `NEXGENT_API_KEY` 解析，不进入 prompt、manifest 或收据。

模型角色与单次 completion reservation 固定为：

| 角色 | 每个 Episode 最多调用 | 每次 reservation |
| --- | ---: | ---: |
| drafter | 1 | 3,500 |
| checkpoint selector | 1 | 2,000 |
| entry worker | 1 | 4,000 |
| final reviewer | 1 | 2,500 |

3a 不含 drafter 调用，因此单 Episode 上限为 3 次 started calls、8,500 completion-token reservations；3b 单 Episode 上限为 4 次、12,000 reservations。三臂对照统一使用 4 次、12,000 reservations 的根上限；未使用额度不得用占位调用消耗。Adaptive 的 selector 必须计入该上限，固定 DAG 或 always-entry 不得把省下的调用挪作额外 repair。

所有阶段的本地 validator tool call 上限为 1、tool work unit 上限为 1、运行节点上限为 32、DAG `max_parallel` 为 4、单 Episode 绝对 wall deadline 为 180 秒。3a 与 3b 各自的四行批次上限分别为 12/16 次 started calls、34,000/48,000 completion-token reservations、4 次 validator、4 tool work units 和 128 个节点；实际固定路线的调用少于批次上限时不补齐。

统一停止条件：合法最终工件并完成评价、根预算耗尽、原始绝对 deadline 到达、身份摘要漂移、observed model 不符、非法 selector、handoff 身份不一致、Provider transport 失败或远端结果未知。恢复不得重置预算或 deadline。

每个预注册行只创建一次。不得重发未知结果、采样多个响应、人工选择输出、增加 repair、修改 prompt/schema/evaluator/阈值或删除失败行。发现实现缺陷后保留原 attempt，修复代码并注册新 revision 与 attempt。

## 10. 首次 Provider 请求前的阶段门

以下门必须按顺序通过，并写入只读 `preflight.json`；任一失败时 external model call 数必须为 0：

### Gate A：合同与实现

- 本文件状态为 READY，revision 和 digest 写入 manifest；
- 新 runner、validator、evaluator 和实验包只存在于 D1-C.3 实验路径或任务无关核心 API；
- 核心代码没有服务名、发布阈值、stable evidence IDs 或条件 ID 分支；
- 旧 D1-C.2 目录摘要未变化。

### Gate B：接口一致性

- prompt、schema、validator、base evaluator 和 final evaluator 使用同一 blocker 枚举与 stable evidence IDs；
- 五个公开 ID 均在模型输入中显式出现并能解析到冻结内容；
- 确定性 3a 草稿对 base evaluator 满分；material update 后必然失败指定 coverage checks；compatible update 后必然仍通过；
- summary 和 blocker 的回归测试全部通过。

### Gate C：机制离线预检

- 使用 gateway doubles 跑完 3a 四行，验证 selector 次数、旧 DAG 抑制、first-action handoff read、最终质量与恢复 exactly-once；
- 非 protocol feedback 不调用 selector；非法 selector 无 fallback；
- route-blind evaluator 输入隔离测试通过；
- raw failed/unknown model receipt、预算、deadline 和漂移停止测试通过。

### Gate D：对照离线预检

- fixed-DAG、always-entry、adaptive 三臂使用相同公开输入和 evaluator；
- 每臂预算上限相同，adaptive selector 计入总额；
- evaluator 在交换 arm label 和 trace 后评分不变；
- 固定顺序、样本 ID 和停止规则可由 manifest 重建。

只有 Gate A–D 全部通过，才允许生成 live manifest；只有 manifest 生成后源码、合同、prompt、schema、输入和 evaluator digest 全部稳定，才允许一次性启动 3a。

## 11. Manifest 冻结与证据

每个阶段使用独立 attempt 和只读目录。Manifest 至少冻结：

- Git commit、dirty 状态、全部执行源码与本合同 SHA-256；
- package、两个候选、workflow、entry、validator、drafter prompt、selector prompt、schema、stable evidence map、任务输入和 evaluator digest；
- 模型 endpoint、configured model、SDK retry、Provider attempt；
- 条件／arm、opaque sample ID、任务实例、seed、固定顺序、故障注入点；
- 单行与批次预算、原始绝对 deadline；
- preflight 命令、测试名、结果摘要和 external model call count=0；
- 旧 D1-C.2 目录树摘要，证明未被回写。

每行保存完整状态和阶段收据：模型请求／响应摘要与 observed model、预算 reservation/usage、draft、base evaluation、validator 输入输出、selector 原始响应、checkpoint/handoff、first-action read、节点和 RPC journal、最终 artifact、route-blind evaluator 输入摘要与逐项评分、失败分类和恢复前后身份。

已有行只由当时冻结的 evaluator 评分一次。若后来发现 evaluator bug，原分数和原始内容保持不变；新 evaluator 必须使用新 revision 对一个新 attempt 运行，且不能替换旧结果。报告可以勘误实验有效性，但不得 post-hoc 改分。

## 12. 报告格式与判定

结果页须分四层报告，不合成模糊的“RSI 成功”：

1. **草稿层**：base-valid 与失败 criterion；
2. **编排层**：selector 是否被合法触发、选择、checkpoint/handoff、旧节点抑制和恢复；
3. **任务层**：route-blind 最终质量；
4. **资源层**：调用、token reservation/usage、wall time 和 deadline。

3a、3b、controls 分别给出完整表格和结论，不允许用后一阶段成功覆盖前一阶段失败。任何未触达机制的行写为 `not_reached`，不得写为通过或模型选择 continue。

本合同完成后仍不能证明：框架已实现跨任务能力开发、技能／DAG 自进化、候选晋升、改进器递归或 benchmark 泛化。它只建立后续研究需要的干净因果链：先验证反馈驱动的能力切换机制，再验证真实模型端到端链路，最后用冻结对照估计同预算相对结果。
