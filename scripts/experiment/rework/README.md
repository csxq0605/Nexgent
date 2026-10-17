# 重做收益测量脚本（M1）

归「收益测量」讨论串所有（`docs/plan/rework-partition.md` M1，§12 `scripts/experiment/**`）。只用于测量，不进产品。除 `run.mjs --real` 外都不调模型。判据见 ADR 0019 第 8 条。

## 题目

6 个做法类题族，每题从本族的“输入问题”池里随机抽 2–3 个（重复记录、单位不一、给定的总数对不上、缺文件、测试之外的边界情况……），奖励的是通用的做法（交之前核对输入、跑全部测试、按步骤记行数、换数据能复算），记住一条约定做不对。每题至多 1 个项目约定要点（约一半的题有，只在反馈里出现，权重不超过该题总分的 20%）；约三分之一的题带一句一次性要求（只在反馈里说，不计分）。

| 题族 | 内容 | 分组 |
| --- | --- | --- |
| `reconcile` | 多份资料汇总并核对数字 | 训练 |
| `code-tests` | 改代码让测试通过（判定跑可见测试与隐藏测试） | 训练 |
| `cited-report` | 按资料写报告带引用 | 训练 |
| `multi-step` | 多步分析，保存并核对中间结果 | 训练 |
| `file-batch` | 批量整理转换文件 | 整类留出 |
| `recompute` | 表格计算可复算（判定换一份数据重跑脚本） | 整类留出 |

留出的两族由种子 `rework-m1-holdout-2026-10-16` 在生成任何题目之前抽出。训练族各 8 题（共 32），留出族各 10 题（共 20），每个训练族另有 1 道通用防退步题（共 4，C1 `PracticeCase` 形式，`source: generic`、`split: guard`，给 G1 装载）。每题在项目里有自己的目录（名字由题目 id 哈希得到），对模型可见的内容里不出现 train / holdout / guard 或题族名。

## 文件

| 文件 | 内容 |
| --- | --- |
| `common.mjs` | 题目、要点、题族的类型；评分要点规则；加权得分；C1 练习题形式（`practiceCaseOf`）；复用试点的文本、CSV、文件树工具 |
| `families/*.mjs` | 6 个题族：生成器、确定性判定器、已知好答案、每个要点一个已知坏答案 |
| `check-family.mjs` | 单个题族的自检（规则、同种子同输出、好坏样本） |
| `cases.mjs` | 56 题的计划、留出抽取、训练顺序（轮流）、哪些题给反馈（每族一半）、计划检查、留出隔离检查 |
| `judges.mjs` | 判定器好坏样本检查（开跑前，不过就停） |
| `feedback.mjs` | 模板反馈（复用试点模板）与笔记臂的策略文字 |
| `reviewer.mjs` | 外部评审（`claude-opus-5-5`）的请求与解析，只做报告 |
| `stats.mjs` | 按题配对差、两层自助法（10000 次，种子 `rework-m1`）、ADR 0019 第 8 条判据、变差类别、一致率、背答案率 |
| `arms.mjs` | 6 臂的定义；base、format、notes、L1 能跑，L1+L2、L1+L2+L3 说明缺什么；format 与 notes 的文字放在手册的位置（任务消息之前）；演练替身 |
| `run.mjs` | 编排：判定器 → 训练流（开学习时每轮后等学完，记下产品自评）→ 隔离检查 → 各臂模板 → 留出运行（按题轮流各臂）与外部评审 → 记录 |
| `scripted-model.mjs` | 演练用的脚本化模型 |
| `report.mjs` | 报告生成器：同样的 `raw.json` 生成同样的字节 |
| `plan.mjs`、`rework-plan-rework-2.json` | 冻结的计划（题目、要点、反馈、评审、统计、判据、臂、配置、自评一致率规则、脚本哈希；M2 起编排脚本也在内，只有脚本化模型不在） |

## 命令

```sh
node --test 'scripts/experiment/rework/tests/*.test.mjs'
node_modules/.bin/tsc --ignoreConfig --noEmit --allowJs --checkJs --strict --module nodenext \
  --moduleResolution nodenext --target es2023 --types node --skipLibCheck \
  scripts/experiment/rework/*.mjs scripts/experiment/rework/families/*.mjs
node scripts/experiment/rework/check-family.mjs reconcile 18     # 单个题族自检
node scripts/experiment/rework/plan.mjs --check                   # 计划文件与生成器一致
pnpm build
node scripts/experiment/rework/run.mjs --scripted --profile smoke --stand-in --out <dir>   # 脚本化演练（约 1 分钟）
node scripts/experiment/rework/run.mjs --scripted --profile m3 --stand-in --out <dir>      # M3 规模演练（约 3 分钟）
node scripts/experiment/rework/run.mjs --real --profile smoke --out <dir> --spend <花费文件>  # M2，真实模型，花钱
```

配置：`smoke`（M2：1 个训练族 + 1 个留出族的 6 题，base、notes、L1，各 2 次，闸门 9 美元）、`m3`（训练流 32 题，留出 20 题 × base、format、notes、L1、L1+L2 × 3 次，闸门 90 美元，开跑前问用户）、`m4`（L1+L2 与 L1+L2+L3，开跑前问用户）。

真实运行只在计划文件与生成器一致、环境里有密钥、闸门允许时开跑，否则退出码 2。

各臂（M2 冻结）：

- 手册（V1）注入在根任务首条用户消息之前，请求里与用户消息合并成同一个 user 轮。format（手册开头一句加“暂无条目”）和 notes（训练流全部计数反馈原文）放在同一位置：接在任务消息前面，空一行。notes 不经手册检索，保留全部反馈，作强对照。
- L1：新项目，home 为训练流 home 的用户级部分（不含各项目数据），用产品自己的检索与注入。留出运行学习关；检索不受学习开关影响（`useShared` 默认开）。
- 训练流开学习时，先确认学习说明，每一轮之后等后台学习把队列处理完再继续。产品对每题的自评（反馈之前）与确定性判定比较，一致率阈值 80%。
- L1+L2、L1+L2+L3 的适配等 V2/E2、V3/E3 落地后写，之前记为“不可用”并跳过。`--stand-in` 只用于演练，给它们一段固定文字，记录里标明，不进入任何比较。

脚本化演练两次的 `report.md` 逐字节相同；`raw.json` 只有训练流里产品的校准抽样（随机）和随之变化的学习费用不同。

输出：`raw.json`（报告的输入，不含时间、会话 id、绝对路径）、`report.md`、`manifest.json`（计划 SHA-256、编排脚本哈希、各臂状态与策略、花费）、`observations.json`、`outputs/<运行>/`。原始记录只放资料库，不进主干。
