# @nexgent/tasking

资料、成果（`present` 工具、版本快照与差异）、每轮文件变更、反馈与持久目标。实现 kernel 契约
`TaskingService`（`packages/kernel/src/contracts/tasking.ts`）。规范文本：`docs/spec/data-formats.md`
（材料元数据、成果元数据、反馈、持久目标）、`docs/spec/agent-hooks.md`（挂点顺序、`present` 的行为）、
`docs/spec/permissions.md`（`materials/`、`outputs/` 对模型只读，由本包作为宿主写入）。

归属：计划步骤 2 的 W2；分工与完成标准见 `docs/plan/step-2-work-partition.md`。运行时依赖：Node 内置模块、
`@nexgent/kernel`、`@nexgent/session`（元数据 schema 校验与会话投影）。

## Public API

| Export | Contract | What it does |
| --- | --- | --- |
| `createTaskingService(layout, sessions, { now?, files? })` → `LocalTaskingService` | `TaskingService` | 五个部件加 `cleanup()`（删除中断留下的 `.tmp-*`） |
| `LocalMaterialStore` | `MaterialStore` | `add` 复制到 `materials/.tmp-<uuid>/` 并边复制边算 SHA-256、判断 UTF-8，写 `material.json` 后整体改名为 `materials/<id>/`；`list`（按 `addedAt`）、`get`、`remove`（只改 `status`，原子写，不删文件）；`absolutePath(material)` |
| `materialAddedRecord(material)` | `HostRecordInput` | SDK 经 `agent.appendHostRecord` 写的 `material.added` |
| `LocalDeliverableStore` | `DeliverableStore` | `present` 校验路径、在 `outputs/<id>/.tmp-<uuid>/` 写快照与 `deliverable.json` 后改名为 `v<n>/`（`v<n>` 已被占用时重取 n，进程内串行）；`list`、`get`、`diff`、`snapshotPath` |
| `LocalTurnFileTracker` | `TurnFileTracker` | 轮前 / 轮后扫描项目（`lstat` 的类型、大小、mtime、ctime，纳秒）加 `write_file` / `str_replace` 的 `meta.path` |
| `SessionFeedbackStore` | `FeedbackStore` | 读各会话的 `feedback` 记录，按 `ts` 排序，可按会话或成果过滤 |
| `createFeedbackEntry(input, deliverables)` | `FeedbackEntry` | 校验评分（1–5 整数）、评语、成果版本存在，生成新 id；kernel 用 `agent.run({ source: 'feedback', feedback })` 开反馈轮 |
| `SessionGoalStore` | `GoalStore` | `set` / `update` 经宿主 sink 写 `goal.set` / `goal.update`；`get` 用 `readAll` + `projectSession`（不调 `resume`，见下） |
| `goalContextProvider()` | `ContextProvider` | `id: 'goal'`；目标为 `active` 时给出 `# Current goal` 系统提示节，不写会话 |
| `presentTool(deliverables)` | `Tool` | 名字、schema、effects、approval 取自 `PRESENT_TOOL`；经 `ToolContext.appendRecord` 写 `deliverable.presented`；结果文本给出 `deliverableId` 与版本号 |
| `textHunks` `diffLines` `toHunks` `renderHunks` `splitLines` | — | 按行差异（Myers，先去掉公共首尾），统一差异块，上下文 3 行 |
| `LocalTaskRecorder(layout, { processes?, now?, maxSnapshotBytes? })` | kernel `TaskRecorder`（步骤 4） | `begin` 拍任务快照，`end` 推出检查、运行并写检查记录；见下文“任务快照与检查” |
| `csvProblem(text)`、`TEST_COMMAND_PATTERN` | — | 检查用的 CSV 结构判断、测试命令识别 |
| `apply` / `name` / `TaskingPlugin` | Cordis plugin | `inject: ['workspace', 'session']`，`ctx.provide('tasking')` 与 `ctx.provide('taskRecorder')`（测试命令经 `ctx.processes` 运行）；启动时 `cleanup()`；有 `ctx.tools` 时注册 `present`，有 `ctx.context` 时注册目标提供者（任一方卸载时注销） |

## 规则与取舍

- **路径**：记录里的路径一律项目相对、`/` 分隔，取自 `realpath` 之后（Windows 上大小写与短文件名都规范化）。
  `present` 依次拒绝：词法上在项目外（`workspace/outside-root`）、在 `.nexgent/` 下（`sandbox/denied`，Windows / macOS
  不分大小写）、不存在或是悬空链接（`workspace/not-found`）、链接到项目外、不是文件（`workspace/not-found`）。错误消息
  告诉模型该怎么做；拒绝时什么都不写。同一次 `present` 里重复的路径只取一次。
- **同一成果**：给了 `deliverableId` 就追加（不存在则 `tool/invalid-input`，跨会话也可以）；否则找最新版本主文件相同、
  且由同一会话交付的成果（多个时取最近 present 的；步骤 3：两个成员交同一路径各成一份）；否则新建。追加版本时没给
  `title` 沿用上一版的标题。成员（`ToolContext.member`）交付时，版本元数据与 `deliverable.presented` 带 `memberId`
  （成员会话 id）与 `memberName`。
- **差异**：按 `sha256` 判 `added / removed / modified / unchanged`；两边都能按 UTF-8 解码、不含 NUL、不是已知二进制类型、
  不超过 2 MiB（`DIFF_TEXT_LIMIT`）时给出按行差异块（新增与删除的文件也给，另一边视为空），否则 `binary: true` 只报变化。
  差异算法的回溯内存超过约 1600 万格时退化为“删除整段 + 新增整段”。
- **每轮文件变更**：忽略项目根的 `.nexgent/` 与任意深度的 `node_modules/`、`.git/`（`.git/` 是本包加的，避免 `git` 命令
  产生成百上千条噪声）。扫描上限 20 万条（`scanLimit`）或 `endTurn` 的 `signal` 触发时停止，此时只报告确定的变化：轮前没扫到的
  新文件不报“新增”，轮后没扫到的文件逐个 `lstat` 确认后才报“删除”。文件工具报告的路径总会出现。返回全部变化，截到
  `TURN_FILES_LIMIT` 由 kernel 写记录时做。
- **资料是否文本**：内容是合法 UTF-8、不含 NUL，且扩展名不是已知二进制类型（Office、PDF、压缩包、图片、音视频等）；未知扩展名
  按内容判断。
- **反馈**：评分与评语至少要有一个（契约允许评语为空串，但两者都空的反馈没有意义，按 `tool/invalid-input` 拒绝）。
- **目标读取不用 `resume`**：持锁的 `JsonlSessionStore.resume` 会把当前打开的轮当作死进程遗留并写 `turn.end { interrupted }`，
  所以 `goals.get` 用 `readAll` + `projectSession`，轮中调用也安全。
- **强杀**：资料与成果都是“临时目录写完再改名”，进程在任何时刻死掉，列表里只会出现完整的资料与版本；遗留的 `.tmp-*` 在下次
  装载插件时删除。反馈与目标只在会话记录里，随会话恢复。

- **任务快照与检查（步骤 4）**：快照范围同每轮文件变更（不含 `.nexgent/`、任意深度的 `.git/` 与 `node_modules/`，只取普通文件），
  文件体按 SHA-256 存一次（`objects/` 先写临时文件再改名），树按规范 JSON 的哈希命名，已存在的树与对象不重写；总量超过
  `maxSnapshotBytes`（默认 200 MiB）时 `tree: null`。检查从任务树交付过的每个成果的最新版本推出：每个文件一项 `file-exists`
  （id `file-<n>`），`.json` / `.csv` / `.xlsx` 另加一项 `parses`（`parse-<n>`；CSV 要求引号成对、各行字段数相同，XLSX 只认
  zip 头和其中的 `[Content_Types].xml` 与 `xl/workbook.xml`）；在项目根目录退出码为 0 的命令里，符合 `TEST_COMMAND_PATTERN`
  的测试命令取最近 3 条去重（`test-<n>`），经 `ctx.processes` 重跑（120 s），其他命令不重跑。`task.outcome.checks` 取最近一次。
  快照的清理（超过总量时删旧对象）还没有做。
- **按轮记（步骤 5）**：kernel 传入根轮号时，每个根轮开始写 `tasks/<taskId>.t<turn>.json`、结束写 `checks/<taskId>.t<turn>.json`，
  反馈轮不覆盖原轮；同时照旧写步骤 4 的文件名：`tasks/<taskId>.json` 只在不存在时写（即第一份快照），`checks/<taskId>.json`
  每轮覆盖为最新一轮。不传轮号时只写步骤 4 的文件名。

## 测试

`tests/` 下：资料、成果（含 Windows 盘符 / 反斜杠 / 大小写，只在 Windows 上跑）、差异、每轮文件变更（含经 `bash` / `pwsh`
改的文件）、反馈与目标、`present` 工具、子进程在复制快照时被 `SIGKILL` 后的恢复（`crash.spec.ts`），以及真实 kernel
循环里的全链（`kernel-chain.spec.ts`：资料 → `write_file` + `present` v1 → 反馈轮 `str_replace` + `present` v2 → 重启 →
恢复续聊，检查记录顺序）。

## DSH references

只参考设计：`deliverables/tool-present`、`deliverables/workspace-changes`、`feedback/message-feedback`、`goal/goal`。
`jobs`、`interaction` 不在步骤 2 的 W2 范围内。
