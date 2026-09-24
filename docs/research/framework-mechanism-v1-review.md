# 通用框架机制 pilot v1：源码事实、契约失败与效用边界

审查日期：2026-09-16。对象是已结束并保留原始登记的 v1 实验；本审查没有调用产品模型，没有生成候选，也没有重跑实验。后续 query 修复形成新的种子源码，不能回填到这些历史结果。

## 1. 结论

v1 证明了一个有限而实际的机制事实：模型生成的 `meta.py` 改变了可执行研究程序，宿主保存该源码后，第二代确实以它的 digest 启动了 `improve` 进程。它没有建立改进器效用提升：内层配对探测和两次独立元评价都在检索输入校验阶段失败；第二代实际执行没有产出有效子代；已有任务转移均值变化为 0。

这里必须区分三个命题：

| 命题 | v1 证据 | 可得结论 |
|---|---|---|
| 可执行研究程序能被改写并继承执行 | `meta.py` digest 改变；G2 进程 receipt 指向 M1 | 已观察到 |
| M1 真实实现了其叙述中的角色自适应、配对探测与反馈修订 | 实际调用图与机制主张不一致；G2 在源码检查处返回 | 未建立 |
| 改写后的改进器更能产生有效后代 | probe 与独立元评价缺少完成的生成执行；配对差值为 `null` | 未建立，不能把缺测补成 0 或阳性 |

证据来自本地只读 SQLite 账本 `.nexgent/research/research.sqlite3` 的登记、事件、bundle 与 artifact。下文给出精确 ID；不刊载模型 API 响应正文、任务答案或密钥。事件序号是该本地账本中的定位，不是跨导出稳定标识；bundle/artifact 的内容摘要用于稳定定位。

## 2. 登记与不可变源码身份

主 pilot：`study-3ae09e74105945a2`，两代，状态 `completed`。这里的 completed 表示登记流程结束，不等于元能力实验成功。

| 对象 | ID | 完整 source digest |
|---|---|---|
| 初始 M0 所在 bundle | `agent-ad28729c9a5d0504bceb` | `7146d3a43e1107c386c311317613af09dbe0626256e83d2cd9410ab2abb24602` |
| 研究分支 M1 所在 bundle | `agent-f98714083120ef7c7ee6` | `456ec5cdc846f9be345894603870288aaed4dfb393b2858ec9d35b5ee0beea89` |

只有 `meta.py` 改变，从 768 字符增加到 3,980 字符：

- M0 `meta.py`：`3793d634a1d02ad9851a89ac1476854fdb114981d278471b172f35da6b844dbf`。
- M1 `meta.py`：`32d6fb88c821be48d62d8a77f3438241a8bea8158278273842ad08fb91a86b3e`。
- 两者共用 `workflow.py`：`e7c0bc216e270c6485a627edb3006b2aa57f11dcb0e2aacaad0c89c4fc20111b`。
- 两者共用 `task.py`：`39a449e48181ad2ec36e14fa2d4dc08a98de2a7aaf82191e6bc6da66c85477b3`。
- 两者共用 `roles.json`：`cae013a7aa6dc6bad4aefc965bdc5a7d9d2684aac6b6dae83df7b3c13a9ff2d9`。

事件 1116 记录 M0→M1 的候选来源；其 context artifact 为 `9da77b13ea4eea3ce2dbde2fbff1cb97c07c715594dba4df321c7e70b44e7539`。事件 1121 的宿主决策是 `research archive`、`accepted=false`、任务选择差值 0。因此 M1 的后续研究执行属于保留探索分支，不是经证实的部署晋升。

## 3. 459 字符问题进入 400 字符检索接口

主登记的完整 question 长度是 **459 字符**。控制器允许非空研究问题最长 12,000 字符，但 v1 种子在 `research_cycle` 中直接按以下优先级取字符串：显式 `literature_query` → domain 的 `literature_query` → 完整 question → 默认查询。它没有将研究问题转成符合检索接口约束的短查询。

`LiteratureSearch.search` 的实际边界是非空字符串且长度不超过 **400 字符**。输入超限时，它在 HTTP 请求之前抛出：

```text
ValueError: Literature query must be nonempty text up to 400 characters
```

这是框架内部两个接口的契约不一致，不是 arXiv 检索无结果、模型推理能力不足或实验已经测得负收益。完整研究问题本来可以合法注册，检索前应当做独立的短查询准备。

外层初始 `meta_research_cycle` 使用短的通用固定检索语句，所以进入了设计和 probe。probe 内层禁止再次 probe，`capabilities.probe_improver=false`。在这个上下文下：

- M0 的元研究触发条件不成立，调用共用的 `research_cycle`。
- M1 的元探索分支要求 probe 能力，条件同样不成立，也调用同一个 `research_cycle`。

因此，两组虽然加载了不同 `meta.py`，却实际进入相同的普通研究路径，并在相同的 459→400 字符边界失败。这是源控制流与失败记录共同支持的解释；不能将其描述为两种元算法已完成比较。

### 首个真实 probe

- Probe ID：`probe-22f79e5999844893`；seed 43；顺序 evolved→initial。
- 完整 artifact：`106f36a4b436cf147832da48b0549caf679e801650823a575a52303356080953`。
- 宿主事件：1104，`status=incomplete`。
- 两组失败位置：`43/evolved/generate/1`、`43/initial/generate/1`。
- `aggregate.paired_development_gain=null`；未形成完成的后代生成配对。

共同任务起点、受限深度和两组预算的存在，不能弥补生成执行缺失。该 probe 证明能力入口被实际调用且失败被记录，不能证明 M1 更好、相同或更差。

## 4. “修复查询”的主张没有对应可接受源码

G1 完整生成 artifact：`901fdb4609968a1f6a3b311af68cec156db66f30e04291a91a983642c90525dd`，事件 1117。

失败后，研究记录提出查询正规化/截短的修复方向。但对实际返回源码逐行比较后可见：该修复相对原始 M0 只有注释移除，没有实际新增查询 helper，没有把 `broker.search` 改成调用短查询，也没有改变继承的 `workflow.py`。

宿主保留的检查结果是：

```text
repair.status = invalid_or_noop_repair
comment_only_source_change: meta.py
Mechanism anchor does not identify new source: meta.py
Missing a new exact code_evidence fragment for changed file: meta.py
```

两个比较基准必须分清。修复结果相对刚测试的 M1 有代码差异，因为它基本恢复了 M0；相对本次候选生成的原始父代 M0，却只有注释变化。因此 `difference_from_tested.comments_only_or_identical=false` 与 `comment_only_source_change` 不矛盾，前者不能单独作为有效修复证明。

该修复被拒绝，保留的是先前的未证实 M1 研究分支。没有被接受并运行的查询修复；不能将修复叙述、代码锚点中的假设内容或恢复旧代码称为自主修复成功。

## 5. M1 的真实控制流，以及 G2 实际走到哪里

### 5.1 确实发生的研究程序变化

M1 改为在 probe 能力可用且 `meta.py` 可编辑时调用新的 `meta_mechanism_exploration`；该分支先调用一次设计角色，而不是执行初始元研究中的并行研究阶段。这是真实的控制流变化。

但其源码中，按任务稳定性和预算自适应跳过某研究角色，主要表现为给下一次模型的设计指令，没有成为 M1 已实现的角色选择条件。检视 AST 调用点还发现：

| 机制叙述 | M1 已存储源码的实际行为 |
|---|---|
| 用实际 probe 检验改进器 | 无可执行 `broker.probe_improver` 调用；设计有效后调用的是 `run_development` |
| 根据 probe 的负 development gain 决定修复 | 检查的是 `experiment_issues` 返回的任务开发问题以及调用/token 预算条件 |
| 预算紧时按任务稳定性自适应角色分配 | 具体选择规则存在于设计指令字符串中，没有对应的已执行选择分支 |

`run_development` 测量候选 `solve` 的任务表现，不会运行候选 `improve` 产生后代。尤其当 task/workflow 不变而只修改独立元流程时，仅调用它不能识别元改进效用。上述观察来自持久化候选源码，不以方法名称、注释或研究叙述作为执行证据。

### 5.2 G2 确实继承执行，但没有完成设计和实验

事件 1129 和 artifact `215b8397cec4b2ffea37881dcbfe8a798426cc3c6319a52f8a7709aeb1d1ce89` 给出：

- `entry=improve`，bundle 为 M1；执行 receipt 的 source digest 与第 2 节 M1 完全一致。
- 独立进程 PID 22740；耗时约 38.86 秒；RPC 计数 1。
- 返回 `research.branch=meta_mechanism_exploration`、`status=invalid_design`。
- 两条问题均为机制锚点没有标识新源码；`candidate_ids=[]`。

因此，G2 的实际轨迹是：加载并执行 M1 → 请求一次源码设计 → 锚点验证失败 → 返回零子代。它**尚未到达** M1 后续的 `run_development`，更没有运行新的实际元 probe。源码里出现某实验调用与这次进程实际走到该调用，是两种不同证据。

## 6. 任务表现与独立元评价

主 pilot 结论记录 `mean_transfer_delta=0.0`、`missing_transfer_seeds=[]`。task.py 没有改变，与任务表现未发生改善相符。这个测得的 0 属于任务转移指标；不能用它替代缺测的元效用。

另行登记的冻结改进器评价也保留了原问题契约。外部登记中的 question 长度为 487 字符，仍超过 400；所有生成尝试在同一检索校验位置失败。

| 独立登记 | 目标与 seeds | 完成配对 | 元差值 | 实际模型调用 / 报告 token |
|---|---|---:|---|---:|
| `study-d57c201e29872ba1` | scientific discovery；491、592；k=1 | 0 / 2 | 均为 `null` | 0 / 0 |
| `study-ba417aca3b24a809` | BBH 两项任务插件；693；k=1 | 0 / 1 | `null` | 0 / 0 |

二者账本状态 `completed` 表示流程已收尾；报告证据级别均为 `comparison_with_missing_execution_or_cost_evidence`，每个 `per_seed_pairs.status` 都是 `incomplete`。科学域的失败标签覆盖两个 seed 的 initial/evolved 四次生成，BBH 覆盖两次生成。

跨 BBH 的登记使用目标任务起点，并明确将旧任务的直接 2×2 归因记为 `not_applicable_cross_benchmark`。这种接口兼容与独立登记不等于已证明跨域元提升；本次没有得到完成的 offspring 生成对。

0 API 也不等于零计算成本：科学元登记记录 8 次任务评价、86,621,928 数值 work units；BBH 记录 4 次任务评价、2,026 source instruction events。两种 work unit 含义不同，不相加或跨域直接比较。主 pilot 本身共有 5 个模型调用，报告总 token 176,736；这包括供应商报告的输入和输出用量，不是 completion 预约量或货币费用。

## 7. 单独登记 v2 的最小干预

v1 主 pilot 与两次元评价结束后，才修正查询适配接口。新种子中的 `prepare_literature_query`：

1. 按显式 query、domain query、完整 question、通用默认查询选择非空字符串。
2. 折叠查询空白，将**检索请求**限制在 400 字符内。
3. 保留完整研究问题给研究角色与设计角色；记录查询来源、原始/正规化长度和是否截短。
4. 在运行时能力合同中明确 `search` 必须非空且不超过 400 字符。

这次工程干预不改变研究角色分工、元机制、修复次数、预算或选优规则；没有提高检索上限、增加模型重试或追选有利结果。它也不会修改不可变 v1 bundle 的共享 workflow。新的种子会产生不同 source identity，因此下一次 seed 47 验证必须作为 **v2 新登记**，不能重写或合并成 v1 的成功结果。本审查没有运行 v2，亦不预设其结果。

回归文件：[test_long_question_contract.py](../../tests/test_long_question_contract.py)。459 字符真实登记问题和 12,000 字符边界问题在修改前均通过真实 source 进程复现原异常，修改后都完成真实检索参数校验、三个脚本化角色调用和独立子代 solve 进程。另含 7 项明确 query 优先级、Unicode 长度边界、空白与非法类型回退检查。HTTP 与模型回复均为 fixture，真实外部 API 调用为 0；与 `test_agents.py` 合计 **72 tests passed，9.00 秒**。

这些回归只确认接口修复及源码执行路径可达，不能证明元改进有效。后续研究仍须分别报告：新的源码差异、下一代实际执行、完成的共同起点配对、私有迁移测试以及真实成本。
