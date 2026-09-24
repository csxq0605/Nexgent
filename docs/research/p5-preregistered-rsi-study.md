# P5 预注册 RSI 研究与产品验收

日期：2026-09-21。状态：**通用 final-holdout 配对研究执行器已实现；正式外部 benchmark 研究尚未注册或执行。**

## 1. 结论边界

P5 不是“再跑一次 benchmark”，而是把 P3/P4 产生的不可变行为版本放进预先登记、不可选择性重跑的研究协议。当前仓库可以证明 E0；更高结论只能由对应真实收据支持。

| 等级 | 可报告结论 | 最低证据 |
| --- | --- | --- |
| E0 | 递归机制闭环 | 版本、真实执行路径、评价、部署、guard、回滚的确定性合同 |
| E1 | 真实模型路径激活 | 固定 provider/model 收据，变化由后续 Episode 实际加载 |
| E2 | P3 持久改进 | `O/M/S` 在预注册 holdout 上优于预算匹配基线 |
| E3 | 跨任务族迁移 | 至少两个没有参与优化的外部任务族保留正效应 |
| E4 | P4 递归改进 | `R1` 后代效用显著高于共同起点下的 `R0`，且递归系统优于固定 `R` |
| E5 | 持续递归改进 | 至少 3 次真实 R 转换、5 个独立演化重复，未写回 holdout 呈稳定正趋势 |
| E6 | 加速 RSI | 至少 5 代，预登记代际效用二阶项的置信区间下界大于 0 |

源码变化、候选数量、一次 `R0→R1→R2`、模型自评或确定性 fixture 分数都不能升级结论等级。

## 2. 框架实现

`RSIStudyService` 位于 `src/nexgent/tasks/studies.py`。它只做研究登记、真实 Episode 配对执行和结果重算，不产生候选，也不移动部署通道。

1. `create_plan(...)` 只接受 `final_holdout`，冻结 benchmark snapshot、任务、显式 `statistical_unit_id` / `cluster_id`、seed、两个 AgentPackage、每 Episode 硬预算、provider/model、随机化顺序、主要门和统计方法。
2. 每个 cell 通过同一个 `TaskService` 创建实际 Episode；memory 从空快照开始，writeback 被禁用，评价器由宿主调用。完整 snapshot/task/evaluator 注册只保存在宿主私有表，智能体 context 不接收明文、内容哈希或登记标识，避免低熵答案被离线枚举。
3. plan 可恢复执行；已经终态的 cell 不重发。模型/包/任务/snapshot 不符、评价缺测或 usage 不完整都会保留为 missing。
4. `assess(...)` 先形成冻结 task pair，再在独立 `cluster_id` 层聚合质量差和成功率差；报告 cluster bootstrap 区间与 paired sign-flip p 值。资源列使用预注册权重的 `work_proxy_ratio`，不解释成货币成本。
5. engineering gate 与 statistical support 分开。即使工程阈值通过，独立 cluster 不足、置信区间或检验不足也保持 `benchmark_local_effect_not_established`；单 benchmark 执行器不会自动输出通用确认性 RSI 结论。
6. CLI 提供 `rsi-study-plan`、`rsi-study-run`、`rsi-study-assess` 和脱敏的 `rsi-study-list`；GUI“RSI 与版本”页只显示脱敏 plan/report 摘要。

该执行器解决“冻结后怎样比较两个任务智能体版本”。P4 的直接命题仍由 `MetaEvaluationService` 从共同 A0/FeedbackBundle 比较 R0/R1 实际后代。正式 E4 报告必须同时引用 P4 meta evidence 与 P5 外部 holdout 结果。

## 3. 主要实验臂

所有臂固定同一基础模型、公开任务信息、工具权限与硬资源上限。

| 臂 | 可变内容 | 作用 |
| --- | --- | --- |
| C0 固定 A0 | 无持久状态、无演化 | 绝对基线 |
| C1 预算匹配固定编排 | 固定 review/revise 或 best-of-k | 排除更多测试时计算带来的收益 |
| C2 memory-only | 只允许有来源记忆写入/检索 | 隔离历史信息积累 |
| C3 固定优化器搜索 | R0 固定，只改 O/S | ADAS/AFlow 类强基线 |
| C4 P3 完整系统 | R0 固定，可改 O/M/S | 检验持久行为改进 |
| C5 P4 递归系统 | 可改 O/M/S/R | 检验改进器本身是否变强 |

预登记主要对比：`C4−C1`、`C4−C3`、`C5−C4`、`U(desc(R1))−U(desc(R0))`。前两项共同通过才支持 E2，后两项共同通过才支持 E4。C2 和其他消融属于次要分析。

## 4. Benchmark 矩阵

Nexgent 核心不内置任务域。正式研究通过 `nexgent.task_benchmarks` 插件接入：

| 任务族 | 用途 | 结论边界 |
| --- | --- | --- |
| Workbench private-v2 | 工件、隐藏评价、防泄漏资格检查 | 仓库工程 fixture，不作外部统计证据 |
| 当前 τ-bench 文本 retail/airline | 工具调用、政策遵守、交互可靠性 | 主任务族候选；固定[当前官方仓库](https://github.com/sierra-research/tau2-bench)版本、模拟用户模型与数据库状态，报告成功率和 `pass^k`；旧仓库任务已标记过时，公开 base split 不当成私有 final holdout |
| SWE-bench-Live | 新鲜代码任务与可执行修复 | 固定容器；阻断答案仓库访问，[论文](https://arxiv.org/abs/2505.23419) |
| WebArena 私有变体 | 长程规划、自托管网站、多工具状态 | 公开原题只作可比性分析，[ICLR 2024](https://proceedings.iclr.cc/paper_files/paper/2024/hash/4410c0711e9154a7a2d26f9b3816d1ef-Abstract-Conference.html) |
| 最新 LiveBench slice | 客观推理/数据分析迁移 | 非交互补充，[ICLR 2025](https://proceedings.iclr.cc/paper_files/paper/2025/hash/e4a46394ba5378b3f9a186a5b4c650d1-Abstract-Conference.html) |
| OpenFOAM cavity | 科学工具型独立 demo | 单列 CFD 域内结果，不进入通用 RSI 宏平均 |

现有 BBH 插件只有两个子任务且固定程序已饱和，只适合接口回归。静态 SWE-bench Verified/Pro 不作为唯一主证据；使用时单列污染、测试设计和任务质量限制。[Verified 审计](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)、[Pro 审计](https://openai.com/index/separating-signal-from-noise-coding-evaluations/)

三类外部插件的当期官方版本、接入顺序及本机成本判断见[adapter 可行性复核](external-benchmark-adapter-feasibility-20260923.md)。它只是来源和实现审查，不替代真实接入或正式结果。

## 5. Split、来源组与重复

每个正式外部任务族的初始规划下限：development 24 个来源组、selection 24、guard 12、final holdout 60；5 个独立 evolution seed。最终样本量必须先用 selection 方差做功效模拟，以 0.05 的最小实际效应、80% power 和双侧 family-wise α=0.05 冻结；不能查看 holdout 后缩小效应阈值。

同一原始实体的改写和参数变体必须共享 `origin_group_id`：SWE 按 repository/issue lineage，WebArena 按站点/模板/目标状态，τ-bench 按政策场景模板和目标数据库变化，OpenFOAM 按物理场景/参考解谱系。字符串摘要不同不等于独立样本。

最终 holdout 上每个候选执行一次；预登记子集再独立执行三次以报告 `pass^3`。模型调用不是统计样本，task instance 是任务层单位，evolution seed 是 RSI 过程的独立重复，benchmark family 是固定分层。

## 6. 防泄漏与执行边界

注册对象必须包含 Git commit/dirty 状态、A/R package digest、固定 provider/model 版本、benchmark/data/container/tool/evaluator/runtime digest、统计单位与来源组 split、mutation surface、预算、调度承诺、缺测/重跑/停止规则、SESOI、estimand 和结论等级。

- Agent 只接收公开 task payload；答案、canary 和 evaluator 实现留在宿主侧。
- final holdout 禁止 memory writeback、FeedbackBundle、candidate generation 和 R 更新。
- holdout 单次消费；停止后只能恢复原 cell，不能选择新子集。
- 各臂使用独立 memory namespace、缓存和工作目录。
- 正式外部插件必须提供网络 allow/deny policy，阻止 benchmark 数据、修复 PR 和 evaluator 源码搜索。
- 模型收据分别记录请求别名、provider 实际返回的 model 与 system fingerprint/revision。正式模型版本必须在登记时给出并逐调用精确核验；provider 不返回固定 revision 时，结论上限降为该时间窗口内的 benchmark 局部工程证据。
- 评价器在研究服务创建时深拷贝，实例状态、类状态、闭包/被引用 globals、模块源码、工具 handler 与 benchmark 环境共同进入执行环境摘要，并在每个 cell 前后复核。E2 以上还要求评价器 wheel/container 和外部服务内容寻址；当前进程内 pilot 不据此升级结论。
- evaluator 意外泄漏使研究单元污染；agent 主动违规搜索答案作为观察到的失败。

## 7. 资源与缺测

主分析采用相同硬上限下的质量，不把异质资源强压成一个不透明分数。分别报告外层演化与内层任务的模型调用、charged tokens、工具、节点、wall time、容器/CPU/GPU、领域 work units 和带时间戳的实际价格。被拒候选、调试、self-update、meta evaluation、guard 和失败请求都计入成本。

| 事件 | 处理 |
| --- | --- |
| 错误答案、非法工具、模型拒绝、任务内超时、预算耗尽、未生成候选 | 观察到的系统失败，计零 |
| provider 5xx/rate limit、VM 启动失败、宿主崩溃、评价器基础设施错误 | 缺测 |
| 宿主泄漏答案或使用错误 snapshot | 协议污染，研究单元无效 |

基础设施缺测最多允许一次预登记的成对重跑：同一 task/seed 的全部臂一起重跑，原收据保留。任一臂缺测率超过 5%，或臂间相差超过 2 个百分点，不给出 E2 以上结论。演化未产出候选时按 intention-to-treat 使用 A0 进入 holdout，避免只评价成功演化的幸存者。

## 8. 统计职责

主分析按 evolution seed 与 family 内 `origin_group_id` 做成对分层 bootstrap（至少 10,000 次），family 等权宏平均；同时报告均值差、IQM、95% CI、胜率和 probability of improvement。少量运行只报均值不稳定，依据见[Agarwal et al., NeurIPS 2021](https://papers.nips.cc/paper/2021/hash/f514cec81cb148559cf475e7426eed5e-Abstract.html)。

四个主要对比用 Holm 校正控制 family-wise α=0.05。支持性结论还要求：宏平均至少 +0.05，95% CI 下界大于 0，任一任务族退化不超过 −0.03，success 和 `pass^3` 不显著退化，缺测敏感性不逆转结论。

当前 `RSIStudyService` 实现单 benchmark、单 evolution run 的 cluster bootstrap/sign-flip 工程出口。task digest 只做完整性校验，显式 `statistical_unit_id` 标识配对单位，`cluster_id` 才计入独立样本数；仅改变 seed、id 或 metadata 不能伪造样本量。跨 family/seed 的分层汇总和 Holm 校正属于正式研究汇总层，在相应外部插件、来源组和运行预算冻结后实现；当前代码不得据此自动写出 E2–E6。

## 9. 当前结果

- P0–P4 的确定性机制：E0。
- 真实 Provider 运行：MiMo 普通任务已形成一次 schema 合法交付；Workbench 仍在冻结预算内失败且评价不可用，Qwen/Gemini 留下供应商失败证据。没有真实反馈生成的候选被后续 Episode 加载和比较，因此仍不足以达到 RSI 的 E1。
- P5 执行器的确定性 pilot：证明 final holdout 冻结、真实 Episode 配对、空 memory、禁止写回、独立评价、可恢复执行、脱敏查看和统计门可以运行。fixture 的固定 0.2/0.8 分数不是模型效果。
- 尚未注册 τ-bench、SWE-bench-Live、私有 WebArena 或等价外部主矩阵；因此没有 E2–E6 结论。
