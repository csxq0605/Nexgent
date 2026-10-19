# @nexgent/evolve

重做 E1（ADR 0018 第 1 层）起，本包的默认流程是**每次任务后的后台学习**：根任务的每一轮结束后，任务进入项目的学习队列；应用进程里的后台循环一次处理一个任务，读会话记录与自评，找相似但结局不同的历史任务对照，发一次反思请求，把提出的增量操作（新增、修改、赞、踩）交给确定性整理后追加到经验手册日志，再按计数追加状态变化（试用 → 启用 / 下线）。花钱前要用户确认过后台学习说明（`mayLearn`）且学习预算（美元，默认每项目 30 天 3 美元）有余额；应用退出时停止，下次启动继续。

旧的改进作业（作业宿主、诊断、提议、交给门控、改进器版本与元改进）和第 3 层离线进化已从本包删除（归档分支 `archive/offline-evolve` 保留删除前的代码）；`ImprovementHost` 现在只是第 1 层学习的挂载点（`noteTurnEnd`、`learning`）。

运行时依赖：`@nexgent/kernel`、`@nexgent/session`、`@nexgent/tasking`、`@nexgent/capabilities`、`@nexgent/llm`（价格表）。

## 第 1 层学习（`src/learning/`）

| 文件 | 内容 |
| --- | --- |
| `host.ts` | `LearningHost`：`noteTurnEnd` 入队、后台循环、`stop` / `start`、`retrieve`、`status`；手册读写都经 `@nexgent/capabilities` 的 `Handbook`（写入只用 `apply`），项目副本不学 |
| `reflect.ts` | 反思指令 v0（通用、不含任何用例的例子）、请求正文、回答解析 |
| `curate.ts` | 确定性整理：长度与关键词、具体数值（`findInstanceLiterals`）、照抄请求、重复、取代与修改的范围、投票规则、项目级 / 用户级；`statusOps` |
| `queue.ts` | 学习队列 `<项目数据>/learning/queue.json`（迁移前 `.nexgent/learning/`） |
| `budget.ts` | 学习预算：账本里带 `learningPhase` 的记录按价格表折美元，滚动窗口 |
| `run-record.ts` | 会话记录压成反思读的文字（用户消息、步骤、失败、文件、成果、反馈、给到的条目） |
| `text.ts` | 中英文分词（中文二元组）、关键词、相似度、最长公共片段、语言判断 |

给用户看的文字（条目、理由、状态变化原因）按界面语言写：宿主配置 `language`（BCP 47）；没有时按任务首条消息的语言（汉字占字母的五分之一以上为中文）。

## 第 2 层技能归纳（`src/skills/`，ADR 0025）

- 触发（`trigger.ts`）：学完一个任务后，它和本项目里相似（任务文字相似度 ≥ 0.25）的成功任务（`externalScore ≥ 0.8`，来自用户、检查或外部评审，没有被删除成果）至少 2 个，且它从没被归纳用过，才考虑归纳；库里已有在用的技能能检索到它时不发请求。项目要同时开着 `useShared` 与 `contribute`。
- 请求（`induce-prompt.ts`）：一次，`learningPhase: 'induce'`，共用学习预算（余额至少 0.1 美元）；输入为至多 4 个任务的运行记录、在用的技能、其他技能占用的名字、相关手册条目、最近被拒的候选；至多 2 个候选。
- 整理（`induce-curate.ts`）：名字、长度、重名、具体数值、文件名、照抄请求（正文）、引号原话、与在用技能重复，失败即拒并进 `rejected.jsonl`。
- `LearningHost` 在 `#work` 里每学完一个任务后调 `#induce`；任务的对照结局同时写进技能库，记录在 `history[].externalScore`。归纳记录在 `<项目数据>/learning/skills.json`。
