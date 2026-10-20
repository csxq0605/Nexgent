# @nexgent/evolve

重做 E1（ADR 0018 第 1 层）起，本包的默认流程是**每次任务后的后台学习**：根任务的每一轮结束后，任务进入项目的学习队列；应用进程里的后台循环一次处理一个任务，读会话记录与自评，找相似但结局不同的历史任务对照，发一次反思请求，把提出的增量操作（新增、修改、赞、踩）交给确定性整理后追加到经验手册日志，再按计数追加状态变化（试用 → 启用 / 下线）。花钱前要用户确认过后台学习说明（`mayLearn`）且学习预算（美元，默认每项目 30 天 3 美元）有余额；应用退出时停止，下次启动继续。

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
