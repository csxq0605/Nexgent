# 通用框架机制 pilot v2：probe 完成与继承目标未达

审查日期：2026-09-16。只读审查范围为已结束的主登记 `study-6e02dda373304307`，seed 47，两轮外层演化。没有读取尚未完成的独立元评价结果，没有向研究程序反馈审查，没有修改 core 或生成候选。本文件不刊载模型 API 响应正文。

## 1. 主要结论

v2 的查询适配修复使真实内层研究越过了 v1 的 459→400 字符契约错误。一次配对 probe 的两个 `improve` 进程均正常返回，完成的开发差值为 0；但是两组正式返回的合格子代数都是 0。这个完成状态证明生成尝试和结果记录的流程走通，不证明产生了有效的改进后代。

外层确实存储了两个只修改 `meta.py` 的程序。M1 的父代选择器读取 archive 中不存在的 `work_units`，使第二轮重新选择 M0。第二轮由 M0 产生 M2，而没有继承执行 M1 的 `improve`。主试验记录 `inherited_improver_executed=[]`，因此该登记的主要目标——改进后的研究程序在下一轮实际承担改进任务——未达到。

M2 又删除了进入专门元研究分支的判断，直接调用普通 `research_cycle`；它来自一次失败 probe 后的源码修订，自己没有完成新的配对检验。任务转移变化为 0，元改进效用尚未建立。

## 2. 不可变源码与谱系

| 名称 | Bundle ID | 完整 source digest | 谱系 |
|---|---|---|---|
| M0 | `agent-b527a91f129f9e435c74` | `41412f4b5d01e5c5ad922f58fbc718f6164fceccb093f45ee81de19f1995bd1f` | 初始程序 |
| M1 | `agent-1d7ec75b756bf22432e6` | `bbfb0708d65f898a9b1e111364026974b7b6f03db83bb965eb4761685a7d0218` | 第一轮由 M0 生成 |
| M2 | `agent-34b66eabb2e6946adbfd` | `8900bc92031eb61ad752c8efc9f7b7e5541738de97e3313279e220f287f965e5` | 第二轮仍由 M0 生成 |

M1、M2 的 `parent_id` 都是 M0，bundle 内的谱系 generation 都为 1。外层调度的“第二轮”不等于源码已有两级继承。三个程序共用：

- `task.py` digest：`39a449e48181ad2ec36e14fa2d4dc08a98de2a7aaf82191e6bc6da66c85477b3`。
- `workflow.py` digest：`ad5efa796e5c7ee1bef811fc917d2f25a180bebcd42409e5dfcf82b4f4499ba2`。
- `roles.json` digest：`cae013a7aa6dc6bad4aefc965bdc5a7d9d2684aac6b6dae83df7b3c13a9ff2d9`。

M1 的 `meta.py` digest 为 `1a776878d8ff085451ff158cc17c83b55d6268c314b8c3036845f339a28627d9`；M2 为 `38ad53712509416974a953dfc9fa7a095537a8fa7536a510bd7b0a3463a68c39`。这些差异确实属于可执行源码变化，不能因此推导能力提高。

## 3. M1：外层触发条件改变，内层研究路径不变

### 3.1 实际外层改动

M0 对 `meta_research_trigger` 返回的任意有效触发证据进入 `meta_research_cycle`。M1 进一步要求触发类型是 `current_parent_failure` 或 `two_public_non_improving_offspring`。因此它忽略仅有 `source_linked_failure` 或 `registered_prior_research_problem` 的情况，转去普通研究分支。这是可执行的触发策略变化。

### 3.2 禁用嵌套 probe 时，比较没有激活上述机制

宿主内层上下文令 `capabilities.probe_improver=false`，而共用的 `meta_research_trigger` 在该条件下立即返回空列表。M0 和 M1 因而都进入同一个 `research_cycle`，角色调用、开发试验和一次修复的源码流程相同。

两组的完整父代源码仍作为模型输入的一部分，源码文本差异和模型采样都可能使输出不同。但这不同于激活了新的内层编排。即使后来观察到后代差异，也需要区分源码上下文效应与触发策略效应；本次没有完成该归因。

### 3.3 声称质量/成本选优，实际总是选择 archive 首项

M1 将初始 `score + 2/(1+children)` 选择优先级改为依赖 `score/work_units` 的表达式；`work_units` 缺失或为零时优先级设为 0。

本次实际 archive 节点只有 score、children、descendant_gain 等字段，没有 `work_units`。因此 M0、M1 的优先级均为 0。代码从 `archive[0]` 初始化 best，只有严格更大才替换，实际选择 M0。这一行为不能称为已经实现质量/成本选优。

事件 1324 的 `select_parent` 进程 receipt 确实指向 M1（PID 13152，source digest 与第 2 节一致），返回 `selected=agent-b527a91f129f9e435c74`。事件 1351 随后的第二轮 `improve` receipt 指向 M0（PID 10100，约 64.92 秒），由它产生 M2。

必须区分三种执行证据：

| 执行位置 | M1 是否实际执行 | 含义 |
|---|---|---|
| 配对 probe 内层 `improve` | 是 | 同起点的受控试验执行，且普通研究路径与 M0 相同 |
| 下一轮的 `select_parent` | 是 | 选择器已继承执行，但返回 M0 |
| 下一轮承担生成任务的 `improve` | 否 | 主演化链没有让 M1 承担后续改进任务 |

因此不能将 `inherited_improver_executed=[]` 扩大解释为 M1 从未被执行；也不能用 selector 或 probe 的执行替代未发生的主演化继承。

## 4. 已完成的 probe：实际尝试、开发 trial 与正式后代

Probe ID：`probe-dbda72dadd7344cc`。完整 artifact：`49b2e73be2b8ddd1dab7b104b35b14f860016f99ccb9baecdaf22337c8fce691`。事件 1306 记录 `status=completed`、`paired_development_gain=0.0`。

每组上限为 6 个模型调用、30,000 completion token 预约、3 次开发实验、1 个正式后代名额。两组 attempt 均有真实 `improve` execution receipt，状态均为 `no_candidates`，development gain 均为 0。

| 组 | 真实生成执行 | 开发实验与检查 | 正式返回 |
|---|---|---|---|
| evolved | PID 26888，125.625 秒；source digest 与 M1 相同 | 一份 task 源码通过词法锚点检查并提交一次 broker 开发 trial；随后修复锚点无效 | 0 个子代 |
| initial | PID 40952，约 98.53 秒；source digest 与 M0 相同 | 设计和修订均未满足恰好一个候选的输出契约；无 broker 开发 trial | 0 个子代 |

evolved 的配对副本 ID 是 `agent-ce2a05cff06dd8139bb9`，其完整源码 digest 与 M1 相同；副本身份不应误读为额外演化成功。

### 4.1 evolved trial 实际失败原因

evolved 生成 artifact：`70ef575c930665813c1a57266665f53dd09846e2bbf3df54b74dd1675276256f`，事件 1265。

其中 broker trial 的 measurement key 为 `a106091b544f41fdeb3c4254e185aefc95d5f853904ff2f11e924633288baa97`，报告 `partial_failure`、`score_available=true`、score 0。八个任务都记录同一源码准入问题：`task.py: name '_' is not permitted`。这是源码不满足运行时能力语言约束，不能未经证据改称预算耗尽。

报告记录的 `work_units=17,000,000` 应保留为原始计量字段；因候选在源码准入阶段失败，不能将该数字描述成候选科学算法实际完成了相应数值工作。词法锚点检查通过也没有保证源码可执行。

种子依据真实 trial 问题尝试一次修复，但修复缺少有效新增源码锚点，状态 `invalid_repair`。程序最终返回空候选列表。故“开发阶段曾有一份拟议源码并调用 trial”与“元评价获得正式返回且可比较的后代”是不同事件。

### 4.2 initial 没有提交开发 trial

initial 生成 artifact：`d7ff88e4e801e7da90fd703866cfca8331e1d2ad60e0d625e9a7f97d9dd7b9db`，事件 1305。设计和一次修复都记录 `Return exactly one candidate object`；`numerical_reports=[]`，正式候选数为 0。

完成的 probe 保留共同起点作为可选基线，所以两个返回空集的过程仍可正常收尾，结果都是没有选出改进，差值 0。报告的 `development_actual_offspring` 分类在这里应解释为实际执行过 offspring 生成过程，而不能叙述成两组都产出了合格后代。该数值也不构成统计等价性证明。

## 5. 第一轮保留 M1，第二轮由 M0 另生 M2

第一轮外层 artifact 为 `a8e2c3ed162894ae079728dbc1fb1d2f8644fe5df58d1f1ce7ff1a206757a156`。研究程序收到 probe 结果后正确记录“开发证据不支持正元效应”。后续元源码修复的锚点无效，原 M1 以 `unproven` 研究分支保留。事件 1323 是 `research archive`、`accepted=false`、任务 delta 0、cost ratio 1。

第二轮外层 artifact 为 `8b329bcf8c824bcd5b1ce0b8a89ae39c7001f62eec71fe0c4edbb12d764b4a83`，由 M0 的 `improve` 生成。该轮最初拟议 meta 源码提交 probe 时，因 `meta.py: Import is not a granted capability` 被拒。记录为 `probe_status=incomplete`、`reason=probe_request_failed`，没有形成该候选的完整配对。

随后一次修订得到 M2，检查通过并存储，但状态明确为 `unverified_revision_after_probe`。修订前的失败不能转移成修订后 M2 的有效测量；M2 没有在主试验中重新完成 probe。

### M2 的实际控制流

M2 的 `improve` 无条件调用共用 `research_cycle`，删除了初始程序的元触发判断与通向 `meta_research_cycle` 的分支。它的 `select_parent` 恢复为初始 score 加未扩展奖励的规则。

因此，对当前已存储代码而言，M2 不再通过专门的元研究入口进行 probe 与元反馈修订；普通研究仍可以提出允许编辑的源码，不能将这个变化夸大成永久禁止一切元源码改写。其 docstring 将普通流程描述为已证实，不构成证据：本主试验没有确认该简化策略更有效。

M2 并非 M1 自我修复产生的二级后代。谱系、第二轮进程 receipt 和选择事件一致表明它是 M0 的另一条直接研究分支。事件 1355 同样记录 `research archive`、`accepted=false`、任务 delta 0、cost ratio 1。

## 6. 结果、成本与识别范围

主登记结论记录 `source_self_modification=true`、`executable_meta_changed=true`、`inherited_improver_executed=[]`、`mean_transfer_delta=0.0`，没有缺测的任务转移 seed。任务源码没有改变，两个正式研究分支的任务选择得分都为 0.9551569737650778。

主登记共有 16 个模型调用，completion 预约总量 65,600，供应商报告总 token 632,912。预约 completion 与报告输入加输出是不同口径，不能互换。嵌套 probe 的实际请求属于同一主登记成本；不能只列外层角色调用而漏掉内层研究。

与 [v1 审查](framework-mechanism-v1-review.md) 相比，可以确认的工程进展是长问题不再阻断内层研究，以及一个配对生成过程实际完成。仍未确认的事项包括：

- 改写后的研究程序在主演化下一轮持续承担改进任务。
- probe 中激活了不同于共同普通流程的研究编排。
- 产生符合契约且能改善任务的正式后代。
- 元程序变化具有可迁移的正效用。

本审查截止于主试验完成，不引用或推断另行运行的独立元评价结果。后续结果应作为独立登记补充，保留本次零改进、无正式 probe 子代和主演化继承未发生的事实。

## 7. 独立元评价终态补记

本节在两个独立登记都结束后追加；第 1–6 节保留主试验结束时的证据与判断。这里的独立后代不能回填为主试验 probe 的正式后代，也不改变主演化没有继承执行 M1/M2 `improve` 的事实。

### 7.1 登记、成本与配对结果

| 独立登记 | 目标、seeds、k | 完成配对 | initial / evolved 正式后代 | 配对 imp@1 差值 | 模型调用 | 报告总 token |
|---|---|---:|---:|---|---:|---:|
| `study-30cadef88bee7988` | scientific discovery；701、802；k=1 | 2/2 | 2 / 2 | 两个 seed 均为 0 | 15 | 363,491 |
| `study-4ba1dd861ddbeb30` | BBH 两项任务；903；k=1 | 1/1 | 0 / 1 | 0 | 8 | 137,335 |

两个报告均为 `matched_actual_source_offspring_comparison`，`missing=[]`，没有不完整的 seed。科学登记的 completion 预约为 59,600，BBH 为 32,800；未知 usage 调用均为 0。它们与主登记成本分开记录。

### 7.2 五个正式后代的实际执行与开发选优

五份后代源码都对应真实 `solve_batch` 进程 receipt，receipt 的完整 source digest 与协议投影候选完全匹配。其中三份正常求解，两份启动并执行后发生任务错误。表中的 0 分均是 `score_available=true` 的执行失败评分，不是资源中断后补出的零。

| 目标 / seed / arm | 投影后候选 ID | 开发分数 | 同起点基线分数 | 实际执行及选优原因 |
|---|---|---:|---:|---|
| science / 701 / initial | `agent-1e858d1b48799dfb8ec5` | 0 | 0.8032215238433685 | PID 46324；8 个任务失败，错误为浮点数与 dict 相乘；低于基线 |
| science / 701 / evolved | `agent-49fec08dfb42c5be6c74` | 0.49912480058813014 | 0.8032215238433685 | PID 6336；8/8 任务正常评分；低于基线 |
| science / 802 / evolved | `agent-4e7bcc0e487cb8e2121d` | 0 | 0.9596744549119685 | PID 47148；8 个任务失败，错误 `KeyError: 0`；低于基线 |
| science / 802 / initial | `agent-cbc196c8743da031dc1f` | 0.9596744549119685 | 0.9596744549119685 | PID 5064；8/8 正常评分；与基线同分 |
| BBH / 903 / evolved | `agent-214a8ada6e637b28fb7b` | 1 | 1 | PID 39948；12/12 正常评分；与基线同分 |

对应的 development evaluation ID，按上表顺序为：

1. `evaluation-c8b179fd7ea7de433fb9`。
2. `evaluation-cc40c63c8217ff6bc90f`。
3. `evaluation-9c612b946da7b3bc3250`。
4. `evaluation-f67047948a54c72b9e0b`。
5. `evaluation-02a22e0faedba98de47a`。

协议先放入共同起点，再按开发分数选更高的候选，同分保留较早项。因此上述五个候选都没有替代基线，BBH initial 则正常完成生成尝试但返回零候选。所有 arm 的 `selected_id` 都等于本 arm 的共同任务起点实例；`selected_development` 与 `baseline_development` 指向相同记录。

评分 receipt 中的 bundle ID 有时是 broker 开发 trial 的原始候选 ID，协议投影另分配一个 ID；已逐项确认完整源码 digest 一致。它表示已支付、已执行且可追溯的同源码测量复用，不能叙述为投影时又重复启动了一次相同进程。这里没有仅凭 `status=evaluated` 认定执行成功。

开发选优保留基线后，所选程序与转移基线也是同一记录：科学 seed 701 的基线转移分数为 0.8113337894162206，seed 802 为 0.8026272854292825；BBH 903 为 1。因此两组的 selected improvement@1 均为 0，配对差值也为 0。这个指标包含基线保底，失败的候选不会迫使系统选中更差程序；同时必须保留候选失败率与原始分数，不能用总体 0 收益掩盖失败。

BBH 此次开发和转移基线均已达到准确率 1，存在指标天花板。本小规模、特定任务分布上的 0 差分不证明改进器普遍等价，也不建立新的跨域编排效用。

### 7.3 共同起点、冻结元源码与执行上下文

逐组核对了真实生成父代的 component digest：

- 科学域四个 arm 都从 task digest `39a449e48181ad2ec36e14fa2d4dc08a98de2a7aaf82191e6bc6da66c85477b3` 起步。
- BBH 两个 arm 都从目标插件 task digest `2374a9b1a27d8d740c502213d401ace448f9c60f1e148cd83ca8371c86d956ce` 起步；没有拿科学任务源码去测 BBH。
- 每个 initial 的 `meta.py` 都是 M0 的 `3793d634a1d02ad9851a89ac1476854fdb114981d278471b172f35da6b844dbf`；每个 evolved 的 `meta.py` 都保持 M2 的 `38ad53712509416974a953dfc9fa7a095537a8fa7536a510bd7b0a3463a68c39`。
- workflow 与 roles 均与各自被冻结的来源一致；五个正式候选的 `discarded_non_task_changes=[]`。

科学 evolved 的实际生成父代副本为 `agent-0ab10abd4d188c4215ff`，完整 source digest 与 M2 一致。BBH 两个实际父代分别为 `agent-9c8c9c74ab5077159f22` 和 `agent-ac5a3824d7eb9081f2fb`；拼入目标 task 后完整 digest 相应改变，但 M0/M2 元源码身份不变。原 M2 的科学域完整 digest 不能错误地要求与 BBH 拼接 bundle 的完整 digest 相等。

六次实际生成 context artifact 都包含 `capabilities.probe_improver=false`，可见评分 split 都是 development。例如科学 701 initial / evolved 的 context artifact 为 `dfaf6f4621efe003cc7674f792b369dc460844a45ea78114dd25fd03192b5917` / `425f6cb03effcaf16db7f230080d96c4cb852cc561c265ee3e1edf4accbab29b`；BBH initial / evolved 为 `3e62ef8ab0bb2dbd8fc9a460dfa3a352db7cd119b33931d9bfe867ab77dcaea7` / `96dd0a2f8ce7e0f770f3c8b0f2d979b63d96b30da31a6a8f5538e331e265ecd4`。

在这个上下文中，M0 因触发为空调用 `research_cycle`，M2 无条件调用同一个 `research_cycle`。被测元源码确实不同，但不同的外层触发策略没有在该配对协议中激活。五个任务后代的质量差异可能受源码文本输入、模型采样和实际生成内容影响；不能把它们解释成已验证的新编排机制。最终选择指标没有观察到正元效应，两个小规模独立登记也不构成普适 RSI 或方法新颖性的证明。
