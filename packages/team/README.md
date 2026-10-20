# @nexgent/team

团队记录的状态：花名册（`team.member`）、持久邮箱（`team.message`）与带依赖的任务板（`team.task`），都以记录写在会话里，由纯函数重建。记录格式见 `docs/spec/data-formats.md` §团队。

给模型的队友工具（`spawn_teammate`、`send_message`、`wait_teammates`、`team_task_*`、`wait_for_message`）和队友运行时已于 2026-10-20 去掉：一轮里找成员用 `organize`（`@nexgent/workflow`），长期的分工交给协调者的讨论串。邮箱和任务板留给协调者与讨论串之间传话和看状态。旧会话里的 `team.*` 记录照常读取。

## Public API

| Export | What it does |
| --- | --- |
| `reduceTeam`、`applyRecord`、`emptyTeam` | 从记录重建状态 |
| `checkSpawn`、`checkMessage`、`checkTaskCreate`、`checkTaskUpdate` | 写记录前的校验 |
| `renderBoard`、`renderInjectedMessage`、`deliveredIds`、`pendingFor` | 纯函数 |

测试：`tests/state.spec.ts`。
