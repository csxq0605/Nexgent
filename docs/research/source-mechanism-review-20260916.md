# 源码演化的公开机制归因审查

研究批次：`source-rsi-20260916-v2`。审查日期：2026-09-16（Asia/Taipei）。本文件是**运行期间的机制审查**，不是批次最终效果结论。只读内容寻址源码、公开 generation/development/selection 记录及一手文献；未读取本批次 confirmation 或内部 final_transfer 结果，未运行 meta 评价、候选程序或产品模型，未修改候选源码。

## 1. 判断规则与证据范围

评价定义见[重启研究 §11](reboot-rsi-mechanisms.md#11-2026-09-16-实现后的估计对象与识别条件)。本次审查区分五类变化：

| 分类 | 需要看到的代码证据 | 单凭该证据能否称科学/RSI 创新 |
| --- | --- | --- |
| 参数或候选列表变化 | 数值常量、阈值、窗口、库表不同，求解/改进控制流基本不变 | 不能；可有工程效益，但需如实称参数/配置选择 |
| 已有科学算法的实现或组合 | 能对应已有估计器、损失、弱形式或稀疏求解步骤 | 不能因模型自行写出就称新算法；应定位复现、应用或组合 |
| 任务算法的控制流变化 | 数据分割、候选筛选、早停、拟合/验证顺序、资源分配真正改变 | 属于实际程序变化；新颖性和效果仍需文献近邻与消融 |
| 改进器/研究编排变化 | meta/workflow 中诊断、调用、实验、修订或父代选择程序改变 | 先证明后代真正执行该代码，再做共同起点的实际 imp@k |
| 纯声明或无改动 | 口头称新机制，但文件/语义未变，或所称分支没有实现 | 不能；保留原声明与不一致，不替模型补写机制 |

代码锚点只证明某段新增文本出现，不验证算法语义、预算充分性、因果效用或论文新颖性。selection 用于运行中的选择和反馈；它支持错误诊断，但不是冻结后独立确认。标为缺测的资源失败不作科学零分，未晋升也不等于程序未被探索。

### 1.1 取证方式

数据来自只读 SQLite 连接 `mode=ro`，限定查询以下表/字段：

- `studies`：目标 full 组的状态、代数、初始/研究程序 ID；必要时限定 development/selection 基线字段。
- `events`：`offspring_generated`、`candidate_evaluated`、`parent_selection`。
- `bundles`：上述公开事件引用的候选及其父代完整源码。
- `artifacts`：`offspring_generated` 指向的生成结果，恢复模型正式 rationale、hypothesis、代码锚点与 development 实验。
- `measurements`：只按上述公开 development artifact 已明确给出的 key 定点读取，以核验修订前后任务方程；不枚举其他 split。

不查询 confirmation 测量、不遍历测量表的隐藏 split、不读取完整 study conclusion。当前注册对象来自[注册批次](registered-source-batch-20260916.json)：full seed 11 为 `study-3382b5236cd94564`，full seed 22 为 `study-35d3b448578f4824`；它们共享初始程序 `agent-07bf1dac73f145b3240d`。

## 2. full / evolution seed 11 / G1

### 2.1 来源与实际变化

| 项目 | 公开证据 |
| --- | --- |
| 父代 | `agent-07bf1dac73f145b3240d` |
| 后代 | `agent-12cadff6b62c9c8cdcf7` |
| 后代 source digest | `d53a9b1af6d71355ae5cf504753c734690f038b2850a8984a2d806b792373925` |
| 生成事件 | sequence **241**；实际执行父代 `entry=improve`，source digest `5cbeeb3f37fb41285eb3df623b33382f77355b554b3d1c7a5ee64d8cd65859ae` |
| 正式生成工件 | `209611923bf336bdc3a495baf8c4f8b7390ca88b0fa516af6da8cfaea4d85ce4` |
| selection 事件 | sequence **245**；split=`selection`，seed=28 |
| 变化文件 | 仅 `task.py`；meta/workflow/roles 的 component digests 均未改变 |

本后代没有更换原有特征库、两组拟合设置、稀疏拟合器、观测留出验证或最终重拟合。其真实改动为：

1. 从 `problem.numerical_budget` 读取推荐额度；用 `tools.work_units - work_at_start` 计算本题已消耗工作。
2. 在两个既有搜索循环开始处检查是否**已经超过**推荐额度，并 `break`。
3. 捕获拟合异常后，若最近三条实验记录均有 error，退出当前内层循环。
4. 添加可能跳过昂贵配置的 limitation。

关键新增分支是：

```python
if work_used() > recommended_limit:
    break
```

因此分类为：**已有科学 portfolio 上的任务级资源控制流修改**。它不只是改一个阈值；但也没有形成新的动力学估计器、实验设计方法或 meta 研究程序。

### 2.2 模型主张与代码不一致/证据不足处

| 模型的机制主张或预测（意译） | 实际源码核验 | 审查结论 |
| --- | --- | --- |
| 在接近推荐额度时终止，以避免整批资源耗尽 | 判断条件是 `work_used() > recommended_limit`，不是对下一次 fit/validate 的成本预测；一次大操作可能在下次判断前跨过额度 | 具有事后停止检查；**不提供**“本题不会超额”的保证 |
| 为后续任务保留预算 | `batch_remaining` 被读入但随后未使用；最终在全部观察上重拟合的调用不受 guard 保护，也没有预留其工作量 | 保留预算的主张只有部分实现；尚需资源压力场景证明 |
| 连续失败会让不可解配置尽早终止 | `break` 只退出内层的两设置循环，外层仍可尝试下一类库；没有全局终止标志 | 局部止损分支存在，不能描述为结束整个问题的搜索 |
| 不改变核心拟合算法 | 对照源码显示拟合/验证/重拟合调用和库定义确实保留 | 这一声明与代码一致；应据此避免宣传新稀疏发现算法 |
| 开发分数至少约 0.95 且不出现预算失败 | development(seed=11) 记录 score=**0.9579517590793674**、status=ok、work_units=**8,683,450** | 此次观察满足其数值门槛；单次无失败不能识别 guard 是否使原本会失败的任务成功 |
| 用量/质量得到改善 | selection(seed=28) score=**0.94723806153282**，与参考差值 **0.0**，成本比 **1.0**，8/8 任务完整评分 | 在这个公开比较上没有量化收益；不能把“运行成功”改写为“效率提高” |

selection 的任务级方程和分数没有给出新增分支的路径覆盖信息。完全相同的数值工作量说明该比较未观察到数值工作节省；不能进一步断言所有 guard 分支从未触发。模型的研究 JSON 还使用了非规范字段 `"f falsification"`，而非提示要求的 `falsification`；本审查保留这个结构偏差，不将其改写成严格通过的假设协议。

### 2.3 与一手文献的关系

SINDy 的核心是构造非线性函数库，再用稀疏回归识别少量动力学项；原文还讨论阈值最小二乘、噪声处理及交叉验证。该后代仍沿用基线的这些类型的步骤，新增预算 guard 没有改变估计问题或求解器。[SINDy 原文 §3.1–3.2](https://arxiv.org/html/1509.03580v1#S3.SS1)

模型还引用 Weak SINDy。WSINDy 原文采用弱形式/Galerkin 表述处理含噪观测；它可以为数值方法选择提供背景，但文献本身不是本候选 guard 已节约预算的证据。本候选保留了“积分配点 portfolio 不是完整 WSINDy 复现”的 limitation；没有新增弱形式离散算法，应维持这个边界。[Weak SINDy 原文](https://arxiv.org/html/2005.04339v3)

本轮实际查阅了上述两篇一手 HTML 的方法部分及 arXiv 书目信息，没有把引用论文等同于复现其全部设置。对于普通预算检查和局部早停，不作“尚无先例”的主张；目前最合适的表述是**模型根据历史资源失败提出并实现了一项任务程序的工程修补**。

### 2.4 继承与元能力

公开事件 sequence 246 显示后代被实际运行 `select_parent`，并选择自己。此时它的 meta/workflow 源码与初始程序完全相同；这个事件证明档案中的该版本参与选择，不证明新的 meta 算法被执行。是否随后实际以该源包执行 `improve`，须看相应后代生成收据；不能用 selector 事件代替。

G1 selection 未接受部署晋升，候选保留在 research archive。当前对该候选可支持的结论是：源码修改真实发生、开发及 selection 均得到完整测量、selection 未出现收益；尚不支持新的元能力或科学算法创新。

### 2.5 来源元数据的冲突

同一 source+parent 的开发实验包先进入 Store，正式候选随后得到相同 bundle ID。由于不可变包采用首次存储，直接读取 `bundles` 时，rationale 是通用的开发实验标签，provenance 仅标 `agent_development_experiment`。正式模型 rationale 与 hypothesis 仍在 sequence 241 指向的生成 artifact 内。本审查以上机制主张均从该工件恢复，不以实验标签冒充模型假设，也不因初始 metadata 缺字段而断言模型未提出假设。

### 2.6 G2：阈值式库剪枝，仍没有观察到节省

G2 为 `agent-a95ea2b9cbf3f31437df`，父代为 G1。其 source digest 是 `36bdf943f68e3a848a4c41e8a5197deff5ac8efc652fb434adc6a22dd8233c30`；生成事件 **329**、selection 事件 **333**，生成 artifact 为 `500e70f867b801598c1cabea30dc5524b0d22c58ed9a9c5d49946cc74f7131db`。

实际只改 task：增加 `nonlinear and work_used() > 0.5 * recommended_limit` 的跳过分支；把最近三次实验均失败改成显式连续失败计数、成功清零、两次失败退出内层。它是任务搜索控制流加阈值变化，没有实现新的回归估计器，也没有修改 meta/workflow。

模型预言工作量下降 **15–25%**。然而 development score **0.9579517590793674**、work **8,683,450** 均与父代记录完全相同；selection score **0.94723806153282**、Δ **0**、成本比 **1**。应保留这一明确未得到支持的预测，不能将“未耗尽”改写为“节约了 15–25%”。此轮研究字段又用了 `fascination_test` 承载可证伪叙述，不是约定的 `falsification`。

### 2.7 G3：改进器真实执行，但返回候选被拒绝

事件 **440** 执行了 G2 的真实源包，`entry=improve` 的 digest 与上述 G2 一致；生成 artifact 为 `b128761b1e6f6aa562535aa3afc1a05c7a1414b4a01fcb6e0eecbd6948f5a2a9`。模型主张按复杂度阶段预分配预算和永久失败锁定，但设计的 task 锚点无效；修订后 task/workflow 锚点仍无效，实际 changed_files 仅有 task，候选列表为空，未运行开发实验。

因此可证明 `B0 → B1 → B2` 的真实 task 源包继承及后续 improve 调用；不能证明演化了新的 meta。修订声称涉及 workflow，却没有相应文件变化且代码锚点被拒绝，属于必须保留的“声明—实现不一致”。本 full 轨迹三代执行完毕，所有正式后代的非 task 组件仍为 seed 版本。

## 3. full / evolution seed 22 / G1–G3

以下是收到实际候选里程碑后的追加，取代此前“ready、尚无候选”的早期快照；不读取 final 或 confirmation。

| 代数 | 候选 ID | 生成 / selection 事件 | 真实改动 | selection 分数 / 相对初始部署参考 Δ / 成本比 |
| --- | --- | --- | --- | --- |
| G1 | `agent-322afefb5938efcf344d` | 532 / 546 | task：按推荐额度和剩余题数计算工作阈值，内外层提前退出 | 0.9589522791567369 / 0 / 1 |
| G2 | `agent-75cf09dc6eb6c152271f` | 653 / 657 | task：每个库的两组配置扩成四组，并把积分配置排前 | 0.945234217104455 / −0.013718062052281876 / 1.7022983774170033 |
| G3 | `agent-3c907ccce7804b387173` | 772 / 786 | task：给库加策略标签，按标签切换积分参数；修订仅改注释 | 0.8403158523349508 / −0.1186364268217861 / 1.7312825415186377 |

三代 selection 均完整评分、均未部署晋升。全部候选的 `meta.py`、`workflow.py`、`roles.json` component digests 与 seed 相同。G2/G3 的 `improve` execution digest 分别指向 G1/G2，证明程序源包按实际谱系执行；这里被继承变化的仍然只有 task。

### 3.1 G1：预算 guard 的第二次独立提出

G1 使用 `min(recommended_limit, 0.9*batch_limit/remaining_tasks)`，并在循环内检查已用工作是否超额，再退出内外层。它比 seed 11 G1 多了外层退出，但仍没有预估下一次操作或保护最终重拟合。development(seed=22) score **0.9633977866737053**，work **8,354,586**；selection work **8,427,119**。已有完整测量，尚无对参考的质量或成本收益。

其正式生成 artifact 是 `438545468e57dab395084bd2566a467fc4cf47a1893f2d2c16ef98b023b293a5`；source digest 是 `dd213789c757db6f0bb4e9838248100e574643136f8e43b3bb9786d12417ece0`。

### 3.2 G2：“重排”同时扩大搜索与改变积分尺度

原先每库配置为 `(9,0,0.04)`、`(13,7,0.06)`。新配置变成 `(9,2,0.04)`、`(13,2,0.06)`、`(9,0,0.04)`、`(13,0,0.06)`。所以处理不是单独“先 weak 后 strong”：它还把两次尝试扩为四次，把原有积分跨度 7 改为 2，并补入另一组 strong 配置。不能将任何效果单独归因于顺序。

development 从父代 **0.9633977866737053 / 8,354,586 work** 变为 **0.9534689662255851 / 14,367,111 work**。模型自己的条件包括“无得分收益而工作增加超过 10% 则低效”；实际工作明显增加而分数下降，触发 seed 的定向修订。修订因无效代码锚点被拒，保留原提案供独立 selection；selection 也显示分数下降及 1.7023 倍工作。不能宣称这次 weak-first 假设已获得支持。

其 artifact 是 `ff5c414dcddf92ba5d4bcacd810b272d398c2ddb034fc49c973d28409280350e`；source digest 是 `8bb9c9eeef8ea88910202c815a2e78e0a9ff70cedf866322571dc8cf5098c3c9`。WSINDy 的噪声处理思想可以作为背景，但这个候选只改变已有 primitive 的参数、顺序和次数；没有新增 WSINDy 推导或估计器。

### 3.3 G3：策略名称不等于重排，修订主张与可执行代码冲突

G3 将三个库分别附上 `weak_first/strong_first/extended_first` 标签，但三组都继续使用同一个四项 `param_configs`。代码把非 weak_first 库的 `actual_weak_window` 设为 0，于是每个此类库实际重复运行 `(window=9,weak=0,threshold=.04)` 与 `(window=13,weak=0,threshold=.06)` 两遍；它不是独立设计了一套“strong-first”顺序。增加标签与日志不能充当不同搜索算法的证据。

更明确的不一致出现在修订。模型声称修订将积分配点限制在 weak_first，以避免原先无条件积分的精度损失。实际设计包 `agent-7b9a9ac575a9718fe56b` 已有：

```python
actual_weak_window = weak_window if strategy == "weak_first" else 0
```

设计 → 修订 diff **只增删或改写注释**，这一语句及其他可执行语句不变。两次开发运行输出的全部方程相同，score 均 **0.9410161926080298**，work 均 **14,469,279**；修订没有实现其口头所称的新限制，也没有修复已观察到的回退。两次具有不同 source/measurement key，不能因数值相同就假定第二次只是缓存；审查比较的是已记录结果与可执行语句。

新 seed 的词法代码锚点主要对原始父代检查，因此重复第一份设计的有效改动、只更换注释，仍可通过“与父代不同”的检查；字符串不同也绕过了“与刚测候选完全相同”的检查。这暴露了**初始 improver 的语义修订审计缺口**，不能解释为宿主应降低拒绝标准。修订打平时选择后稿，又让这份注释修订被最终返回。

同时，模型把 logistic 描述为简单线性系统；一般 logistic 增长方程含二次项，这个机制解释本身也不严谨。无需借助隐藏测试，该公开原文与可执行差异已足以否定“本次修订新实现了积分限制”这一具体主张。

G3 生成 artifact：`6f48f7ac4cef25f3877681b34772b74321af35c13a3882bcb43753165c79a51f`；最终 source digest：`49e4b7fd6ff64395b3e6d3ac2a288bf78856f23cc98ab867ceb0e0ce37b52394`。后续 selection score **0.8403158523349508**、work **14,589,724**，与初始参考相比明显回退；本审查不使用这之外的私有结果。

### 3.4 两个 full 均未产生新的非 task 程序

核对上述五个正式后代，三个非 task hash 始终为：

```text
meta.py     6778563815e14fe990fa2cd1af520a0202e04f7f40430abbf2da368ed16e1d3a
workflow.py 15f1437c0d9a6e5991f243f4d4155997f1c693798f0302c74745a502925aef2d
roles.json  28273a596a4d29ae3db6a88c09bbe56afe3895582d3752bd895b4b2ad7149261
```

把任一正式后代与 seed 都 splice 到相同 task 起点后，得到的是相同非 task 实现。此时不应付费生成“两组”后代再将 API 抽样差异解释为 meta 进步。应报告“没有不同的被测 improver，元能力变化估计不适用”；若专门研究同程序重复性，必须另作噪声试验注册。

当前结论是：**源包继承与任务源码自修改已实际运行，但这批两个 full 轨迹没有建立改进器源码发生改变并被后代执行的证据。** 接口允许自改 meta 与现实中发生元递归进步仍有实质距离。

## 4. 后续审查必须保留的竞争解释

- 任务得分若提高，要检查是否只是更换现成的 SINDy/弱形式/验证组合；源码生成方式不赋予估计器新颖性。
- 若 meta/workflow 改变，先区分真正改变分工、实验顺序、失败判别或源码生成逻辑，与只给同一固定流程加更多文字、调用次数或日志。
- 对新修订机制，比较它是否确实使用失败的 status、缺测与成本，并检查请求/实验收据是否发生；不要根据函数命名推断执行效果。
- 对预算改善，完整任务数、逻辑工作、物理工作、模型输入输出和预约费用共同解释；跳过昂贵任务得到缺测不是无损加速。
- 只有实际后代生成的共同起点评测能支持改进器生产率比较；模块直接 2×2 和仅有源码修改都不替代该实验。

任何后续肯定结论都要标注其演化种子、代数、bundle、公开事件和源码位置，并保留同一批次中的退化、缺测、无效锚点、no-op 及口头主张与代码的差异。本文件不使用 confirmation 来决定候选或修改上述分类标准。

## 5. 下一项元机制研究：把实际改进器探测交还给研究程序

**状态：设计提案，尚未实现或执行；冻结代码与本批次结果保持不变。** 这不是为了把当前零/负结果改成成功而重选种子。当前实际缺口是：`broker.experiment` 只能测任务程序；外部 `meta_evaluate` 要在研究结束后才运行改进器。源程序在提出 meta 修改时，不能在自己的研究过程中测试“这份新 meta 生成的真实后代是否更好”，因而没有可操作的元效用反馈。

STOP 将改进器本身作为可修改对象，并让元效用依赖它对下游程序的改进表现；Hyperagents 则明确区分任务表现与冻结 meta 的实际后代生成能力。两者支持把下游生成结果作为元研究证据，不能用 meta 文件是否变化或文案是否令人信服来代替。[STOP 算法 1 与 meta utility](https://arxiv.org/pdf/2310.02304)、[Hyperagents §5.2 与附录 D.3](https://arxiv.org/html/2603.19461v1#S5.SS2)

### 5.1 具体可证伪机制

候选机制暂定为**以来源和实际差异约束的修订审计**，由智能体自己修改 `meta.py` 实现，不由宿主写死一套科学算法：

- 将历史失败绑定到其 source/measurement ID，区分旧坏候选与当前已成功的强基线，避免把旧预算失败误诊为当前父代失败。
- 对“修订修好了某机制”同时核对原始父代、刚测设计及修订版本。只对原始父代不同不足以证明修订有效；G3 的注释修订就是反例。
- 根据实际后代的源码、实验状态与成本决定下一次诊断、委派或修订，保留无法验证的主张，不再以模型叙述给自己授予成功。

两层预注册预测需要分别报告：**机制预测**是减少“声称完成修订、实际执行语句未变”的事件和相应浪费；**元效用预测**是在共同任务起点和预算下，新 M 产生的有效后代获得更高的 paired development gain，并最终在独立 meta_transfer 中验证。第一项成立而第二项不成立，只能说明过程审计改善，不能称元生产率已提升。

该机制与现有失败分析、程序反思和代码审计有明显近邻。本项目可研究的差异在于：源程序自行提出/执行这类改进，并通过实际冻结新旧 M 的子代证据反馈自修订。尚无证据表明这一组合是文献首创，也不把两个 full 的负结果当作必须得到正结果的理由。

### 5.2 拟新增的能力接口

```text
broker.probe_improver(files: {filename: complete_source}, label: string)
    -> schema "nexgent-improver-probe-v1"
```

这是一项宿主执行能力，调用它与解释结果由可变源程序决定。当前拟定的紧凑返回结构如下，数值只由实际运行填入，示意中的 null 不代表零：

```json
{
  "schema": "nexgent-improver-probe-v1",
  "probe_id": "host-assigned-id",
  "status": "incomplete",
  "split": "development",
  "reference_source_id": "registered-reference-id",
  "candidate_source_id": "candidate-source-id",
  "task_anchor_id": "registered-common-task-id",
  "depth": 1,
  "arms": {
    "initial": {"development_gain": null, "attempts": []},
    "evolved": {"development_gain": null, "attempts": []}
  },
  "aggregate": {"paired_development_gain": null},
  "limits": {
    "model_calls_per_arm": 6,
    "reserved_completion_tokens_per_arm": 30000,
    "development_experiments_per_arm": 3,
    "offspring_per_arm": 1,
    "maximum_depth": 1
  },
  "artifact_id": "complete-host-evidence-id",
  "evidence_scope": "Development research feedback; no transfer result or final improvement claim"
}
```

`status` 只取 `completed`、`incomplete`、`skipped_identical_improver`。预算不足在启动任何一组前返回 `status="incomplete", reason="insufficient_budget"`，两个 attempts 均为空，不能把未运行填作零收益。每个 attempt 必须保留实际 `execution.bundle_id/source_digest/entry`、原后代/投影后代 ID、development measurement ID、实际用量/缺失状态。模型收到有界摘要；完整源码、失败回复、model receipt 和数值记录写入同一 study 的 artifact。任何 `probe_id`、预算和 verification 字段均由宿主产生，不能接受源程序自报的“已验证”。

### 5.3 共同起点与真正的两组源码调用

1. **固定 reference。** reference 非 task 文件取调用本次 probe 的父代快照，不能临时选择表现差的祖先。共同 task anchor 在新实验注册时固定；可取强基线 task，两个组完全相同。初始机制研究优先只允许修改小文件 `meta.py`，冻结 task、workflow 和 roles，减少共同命名空间混杂。
2. **构造两包。** `P0=splice(task_anchor,reference)`，`P1=splice(task_anchor,candidate)`；保存原提案、组件来源和忽略的非目标修改。若两个组的可执行输入源包 digest 完全相同，直接 `skipped_identical_improver`，不发模型请求，不捏造 gain=0 的测量。
3. **实际生成。** 分别在新进程中执行 `P0.improve`、`P1.improve`，各一次，至多接纳返回顺序中的一个后代；两组公开历史、development 数据种子、模型映射、数值/模型上限相同。公开历史在 probe 调用前冻结，而非在每组启动时重新读取。执行顺序应预注册或交替，不能看到第一组结果后改变第二组输入。
4. **冻结被测 M。** 子代可提出多文件变化，但评价 task 输出时恢复本组固定非 task 文件；把移除的子代 meta 变化写进 provenance。这样不是让内层候选继续递归改自己。
5. **development 选优。** 比较本组起点和有效后代；返回 `gain_j=development(selected_j)-development(P_j)`，以及两组 gain 差。资源失败使比较缺失，不能补成基线零收益；普通无效后代则保留其失败记录及未改进事实。
6. **不返回保留集。** 不读 `meta_transfer`、final_transfer 或 confirmation；不把两组摘要交叉放入对方生成上下文。probe 是可被优化的开发效用，不是最终无偏效果估计。

只改 meta 文件并不保证它是可独立组合的纯模块；新 meta 若覆盖 solve 或依赖未带入的 task 帮助函数，必须由真实执行暴露、记录。宿主不能自动修复这种依赖后仍归功于候选 M。

### 5.4 深度、总预算与中断

**最大嵌套深度为 1。** 宿主保留不可由源程序覆盖的调用深度；进入 probe 的两组时，向上下文明确 `capabilities.probe_improver=false`。内层再次请求 probe 必须在任何子进程/模型请求前被宿主拒绝，不能只依赖提示词或源程序自觉。内层应运行普通的 task 改进分支，仍调用该版本自己的实际 `improve`。

所有内层请求/实验计入**同一 study、同一持久账本**，并带 `outer_call_id → probe_id → arm → call/measurement` 关系。每组 6 calls/30k completion/3 开发实验是局部上限，不新增免费配额；源程序不能借“子任务”新建预算。每个 outer improve 默认最多 **1 次 probe**；请求次数、失败与缓存尝试均有明确计数，失败不自动重试。

一次完整 probe 最多 12 个模型请求、60,000 预约 completion tokens。若外层沿用两路研究加设计，需要再加 3 calls/10,400；一个可选的外层修订再加 1 call/6,000，即最多 16 calls/76,400，尚未包含其他主动调用。新协议拟定 full 每代 18 calls/90k completion，整个 study 仍有另行登记的累计上限；这不是给旧批次追补预算。

**配对启动前置条件：** 同一总账扣除 outer 已用请求后，至少仍能容纳 12 calls/60k completion，以及两组约定上限所需的全部评价名额。宿主须在竞争请求不能插入的预算检查/预留步骤中保证该条件，否则返回 `insufficient_budget`，两组均不运行。局部 cap 不能重新授予额外总配额，额度充足也不强制耗尽。启动后偶发失败仍可能造成不完整配对，应保存真实已用成本，不为凑齐结果自动重试。

两组 wall time、数值上限一致。新协议拟定 outer 绝对时限 1800 秒，内层每组真实 generation 最多 600 秒；全局剩余时间若更短，以全局 deadline 为准。实现须显式扩展原先的源进程上限，不能把预算调整误记作算法改善。并行两组可缩短墙钟时间，但不降低 token 计费，也不能让两组共享可写研究状态。停止信号沿整棵调用树传播，等待的 outer、两个 source worker 及其 Provider workers 均需终止；已预约/未知远端用量如实保留。

同一个 durable probe 已开始后，恢复任务不能无痕重发。中断留下 `incomplete` 和已发生用量；要重新试验必须有新的明确实验身份及剩余授权预算，而不是把未知结果当未调用。

### 5.5 初始源码的分支方案（伪代码，非已实现候选）

```text
improve(context, broker):
    if probe capability is disabled:
        execute this version's ordinary task-improvement procedure

    inspect PUBLIC failures tied to actual source/measurement IDs
    detect current stagnation or verified repair inconsistency
    if no such evidence:
        execute ordinary task research

    propose one actual meta.py mechanism change using the evidence
    verify changed executable control flow and matching mechanism explanation
    probe = broker.probe_improver({meta.py: complete proposed source}, label)
    retain actual offspring, execution, errors and cost evidence

    if probe is complete and supports the preregistered development criterion:
        return candidate meta with provisional development evidence
    if probe identifies a concrete correctable failure and repair budget remains:
        propose at most one targeted meta repair from that ACTUAL probe
        retain it as an unverified revision for a later registered test
    otherwise:
        record the negative or missing result
        retain the reference or return the proposed M as an explicitly unproven research branch
```

停滞不能由“看见任何旧失败”触发：需要绑定当前 study/源谱系，或明确指出采用哪条已公开 prior failure 作为研究问题。推荐初始触发为连续公开的无收益后代，或可核验的注释修订/错误来源归因；源程序后续可改变自己的触发与研究组织，宿主只维护来源和预算。

修订上限不是成功保证。**单 outer 最多一次 probe，因此 probe 后新写的 M′ 不可沿用旧 M 的结果声称已验证。** 该修订可以作为带 `needs_probe` / `unverified` 标记的研究工件留存；只有在后续预注册的实际调用中被测试，才可升级其证据状态。也不能把“meta 文件变了”直接视为任务部署晋升。即使开发探测未支持正收益，M 仍可作为明确 `unproven` 的研究分支供下一代真实执行，但必须保留零/负/缺失证据，不能标为晋升或效能提高。研究父代选择与已经验证的部署程序是两个不同决策。

为证明闭环，最小证据链应是：`M0` 实际执行并提出 `M1` → 由它调用 probe → probe 中真正运行 `M1.improve` 产生任务后代 → 实测摘要返回仍运行的 `M0` → `M0` 据此记录采纳/拒绝/修订；若后续继续运行 `M1` 或 M′，再记录其实际 source digest。仅在研究结束后由用户启动外部 meta_evaluate 不构成这条内部反馈链。

### 5.6 识别风险与对照

| 风险 | 必需对照或记录 |
| --- | --- |
| 新 M 只是换了一次模型抽样 | probe 前精确比较共同起点源包；无不同 M 则跳过。不同源码也要记录模型/随机性与实际费用 |
| 只改注释、角色名或叙述 | 比较可执行语句与实际角色/实验数据流；注释可影响传入模型的源码文本，但要标为上下文变化，不能称执行算法改变 |
| 额外推理或更长输入造成优势 | 同模型、相同每组上限；报告实际输入/输出 tokens。用相同 M 的等预算任务研究作控制 |
| 新的固定宿主审计器替智能体完成改进 | AST/身份等只能是公共测量能力；诊断、是否修订、调用顺序由源程序实现，两组能力完全相同 |
| 只对弱起点有效 | 共用注册强 task anchor；后续扩展起点时另行注册，不能因零增益临时换弱 seed |
| probe development 被反复试到过拟合 | 固定候选/探测次数与种子；全部负结果保留；最终 meta_transfer 仅在冻结 M 后测一次预注册集合 |
| 元候选与任务源码联动、互换不兼容 | 首轮只修改 meta.py、冻结共享 task/workflow；仍保留不兼容失败，不由宿主修补 |
| 无效/超额程序靠缺测逃避负结果 | 资源缺测不补零；完整性和失败率单独报告，缺失配对不能支持正效应 |
| 自我探测再递归探测导致费用无界 | 宿主 max depth=1、每 outer 一次 probe、每组局部 cap 加同 study 总 cap；权限和额度不能由返回 JSON 更改 |

第一项新实验拟为一个预注册机制 pilot、两代，先固定公开研究材料、预算和运行次数，验证上述完整来源链及反馈动作。若出现真正不同的 M，再用冻结 M 的实际 imp@k 和独立转移评估效果；若没有非 task 改动、probe 不完整或后代仍无收益，就发布相应负结论。不能反复挑 seed 或把“产生了一份 meta 文件”改名为已获得有效 RSI。

### 5.7 通用 RSI 框架与领域示例的边界

Nexgent 的目标是通用 RSI 智能体框架。上述科学发现实验是一个领域示例，不能反过来规定核心框架的任务、估计器或工具。当前 seed 中的科学术语、固定任务数量以及 science import 是需要在解除冻结后移出的耦合；本节不将它们描述为已经完成解耦。

| 核心框架负责 | 注册领域 adapter 负责 |
| --- | --- |
| 不可伪造的源码身份、继承、实际执行、模型/实验预算、停止与事件来源 | 任务源码种子、问题实例、工具契约、领域方法资料 |
| 通用研究流程：外部资料与公共历史分析、可证伪假设、源码设计、开发实验、基于证据的修订 | 开发/转移拆分、领域评价器、质量与成本指标的定义 |
| `probe_improver` 的共同起点、配对生成、深度与费用约束、缺测语义 | `task_contract`、`tool_api`、可读文献内容及其可信来源信息 |
| 可变 `meta.py` 的控制流、角色组织、研究分支与实际反馈继承 | 科学发现示例的 SINDy/动力系统提示、任务规模与数值预算解释 |

待实现的 `agents.seed` 不导入 `nexgent.science`，不写死 SINDy、dynamics 或 8/12 个任务。宿主通过 `context.domain`、`context.task_contract`、`context.tool_api`、`context.literature` 注入注册领域信息；seed 仅据这些内容组织研究，将其传给动态模型角色。科学发现的领域文本和资料放入 `examples/scientific_discovery` 的独立 adapter。另一领域可使用同一 seed、模型通道、源码继承、探测和账本，仅替换注册 adapter。

共同 task anchor 由所属领域注册，核心 probe 无需知道它是否代表方程发现、优化器或其他任务。核心仅按注册评价契约消费完整性、目标方向、质量和资源字段；不将领域中的正负分数方向、任务数量或“成功方程”解释写死。若初版领域契约要求统一较大为优的 `score`，这应成为明确的 adapter 契约，而不是隐含科学假设。

通用元研究分支仍可针对源码审计缺口提出新的控制流，内层通过 `capabilities.probe_improver=false` 进入**该版本源码自己的普通领域任务改进分支**。不能由宿主把新 M 替换成固定代理算法，也不能用适配器名称决定是否允许元递归。不同领域的隐私拆分和研究预算应分别注册；跨领域效果需另行实证，不能仅凭接口复用宣称通用性已获证明。

解除冻结后的验收应至少覆盖：两个无科学依赖的 stub adapter 驱动同一初始研究程序；无 probe 能力时真实执行普通分支；停滞时执行实际改写 meta 并调用一次 probe；将收到的真实负/缺失反馈用于保留 `unproven` 或修订为 `unverified`；预算不足不发半配对请求；源码中不存在硬编码科学领域内容。stub 验证接口隔离，第二个真实领域的注册实验才验证运行适用性。

### 5.8 0.8 实现补注：迁移和闭环已接通，效能假设仍待实证

§5.1–5.7 保留 0.7 审查之后形成的研究设计，不应将其中“待实现”和 `examples/` 路径作为当前版本说明。0.8 的领域代码已迁至独立可安装包 [benchmarks/scientific_discovery](../../benchmarks/scientific_discovery/) 与 [benchmarks/bbh](../../benchmarks/bbh/)，通过 `nexgent.benchmarks` entry point 注册。通用 seed 要求外部传入 task 源码，并从注册 context 读取领域、任务契约、工具和资料；源码、角色组织与实际元探测仍属于通用核心。

真实进程的 fixture 测试已覆盖 `M0` 提出 `M1` → 内层分别实际执行新旧 `improve` → 真实任务子代开发计分 → 反馈返回外层 → 下代实际执行新 M 的链条。跨 benchmark 的 `controller.meta_evaluate` 集成另验证了共同目标 task、原 M 身份、目标插件工具的实际执行、契约注入与转移反馈隔离。跨域关闭旧 task 模块的直接 2×2 归因。这里的模型回复均为脚本夹具；不能由此推断真实模型形成了新的有效算法或获得跨域 RSI 收益。

当前 wire 中 `arms` 是列表，元素含 `arm="initial"/"evolved"`、状态、gain 和实际 attempts；§5.2 的对象形状是旧提案示意。宿主保存完整 probe 工件，向源程序返回有界摘要和标明截断的源码片段，避免把完整源码、调用收据及长领域诊断重复放进模型输入。预算与记录覆盖任务执行中的模型调用；不同注册探测/元评测具有独立测量缓存命名空间，同一次已计费的测量可复用。独立元评测接受显式 generation/arm 预算，默认上限不被伪装成适合所有领域的成本标准。

另一个已修复边界是证据来源：源程序的 `evidence_status` 被保留为 agent claim；宿主核对实际 probe 和被测非 task 源码身份后才赋予开发支持状态。未测修订不能沿用旧 M 的探测结果，没有 selector 的研究分支也不会自动退回部署程序。这些是执行与证据完整性的修复，不是算法效能阳性。本文 §2–4 的零收益、负收益、未发生 meta 变化及口头主张与代码不符的记录均维持原判定；下一项真实模型机制 pilot 的正、负或缺失结果需另行报告。
