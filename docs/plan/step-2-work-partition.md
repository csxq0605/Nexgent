# 步骤 2 分工表：接通完整的日常任务体验

来源：计划 [4.2](../research/pr4-review-and-plan-2026-10/README.md)、4.7 的退出门槛、4.10 中归属步骤 2 的事项，以及步骤 1 验收记录 [`step-1-20261011.md`](../validation/step-1-20261011.md) 列出的缺测项。本表在步骤 2 开工前定稿，回答：做哪些工作包、谁依赖谁、每轮开哪几个讨论串（每轮最多 3 个）、每个包做到什么算完成、`accept-step2` 检查什么、真实模型补验怎么做和花多少钱、风险在哪。格式沿用 [`step-1-work-partition.md`](step-1-work-partition.md)。

计划 4.7 估计步骤 2 为 3–4 周；按本表的轮次排下来是 5 轮，关键路径是桌面应用。周数是范围估计，不是承诺。

## 目标与退出门槛

步骤 2 对应产品目标 ①：可用的通用任务应用（项目、多轮对话、附件、历史资料、成果文件、停止与继续、重启后接着工作）。验收链：

```text
提交资料 → 执行 → 成果被 present → 提出修改 → 成果更新 → 杀进程 → 重启后继续 → 会话、资料、成果全部可见
```

退出门槛（计划 4.7，按步骤 1 的口径加严）：

1. `scripts/accept-step2.mjs` 的无界面层与桌面层在 Linux、Windows CI 上都通过（脚本化 provider）。
2. 真实 Claude 模型（`claude-sonnet-5-5`，ADR 0002）完成一个**真实任务**的全链，结果由脚本独立判定，在 Linux 云端开 thinking 跑一次；并补上步骤 1 没测到的三项：文件编辑工具在真实模型下被使用、thinking 开启、中断后恢复。Windows 上的真实运行按用户 2026-10-11 的决定改为可选，不进门槛；Windows 的脚本化 CI 仍必须全绿。
3. 验收记录 `docs/validation/step-2-<日期>.md` 经用户认可。之后合入 `main`、旧 PyQt 归档为 `archive/harness-gui`（计划 4.0），这两步需要用户另行同意。

## 范围

**做**（计划 4.2 的七项 + 4.10 归属步骤 2 的项）：

1. 项目模型：项目 = 工作目录 + `.nexgent/`；最近项目、新建、切换。
2. 资料：添加资料复制到 `.nexgent/materials/<id>/`，以文件引用注入对话；Office 文件按技能说明 + 工具读取。
3. 成果：`present` 工具声明交付；每轮文件变更记录；`outputs/` 保存每版快照，供修改时对比。
4. 反馈修改：对成果提出修改即新一轮；评分与评语记入会话并关联成果版本（步骤 5 的输入）。
5. 停止与继续：取消当前轮保留已流出文本；跨重启用持久目标 + 会话恢复；轮中强杀后能恢复。
6. 上下文：工作区说明文件注入；长对话的基本压缩。
7. 桌面应用与 SDK：`apps/desktop`（Electron + React，Codex 式三栏），`@nexgent/sdk`（进程内 TS API，主进程持有 kernel，渲染进程经 IPC 调用）；CLI 与桌面应用共用 SDK。
8. 4.10 的步骤 2 部分：设置页（模型、thinking、密钥状态、费用上限）；`nexgent export <session>` 最小导出包；日志文件约定；桌面应用的未签名打包与 `docs/install.md`；`permissions.md` 的“本地 IPC 与访问令牌”章节；`data-formats.md` 的材料与成果元数据章节。
9. 步骤 1 遗留里会影响步骤 2 验收的部分：Windows 进程树终止（Job Object）、`perProject` 费用上限执行、`pause_turn` 自动续跑、审批提示的端到端测试、测试文件纳入类型检查、`nexgent.ps1` 实跑。

**不做**：浏览器访问的 Web 服务；Python SDK（计划 4.9 #12）；子智能体、工作流、团队（步骤 3）；能力版本（步骤 4）；改进器（步骤 5）；安装包签名与自动更新（需要证书和费用，单独问用户）；macOS 验收（只保证能构建，不进门槛）；后台任务（DSH `jobs` 只作参考）；多 provider。

## 总览

| 工作包 | 职责一句话 | 依赖 | 可并行 |
| --- | --- | --- | --- |
| W0 契约与规范 | 冻结步骤 2 的 kernel 契约、SDK 接口、会话新记录类型、材料 / 成果 / 反馈 / 目标的数据格式与 IPC 规范 | 步骤 1 契约 | 与 W7、W8 并行；其余包等它冻结 |
| W1 `@nexgent/context` | 工作区说明文件注入、资料的文件引用注入、基本压缩 | W0 | W2、W3、W7 |
| W2 `@nexgent/tasking` | 资料、成果（`present`、快照、每轮变更）、反馈、持久目标 | W0 | W1、W3、W7 |
| W3 `@nexgent/skill` | 技能发现与加载、内置 Office 读取技能 | W0 | W1、W2、W7 |
| W4 `@nexgent/sdk` 与 CLI 改接 | 进程内 TS API；CLI 改走 SDK；`nexgent export`、`nexgent app` | W0；集成时依赖 W1–W3 | 接口先行时与 W5、W6 并行 |
| W5 `apps/desktop` 主进程与打包 | Electron 外壳、主进程持有 SDK、preload 与 IPC 令牌、窗口与对话框、未签名打包 | W0（IPC 规范）、W4 | W6（对接 IPC 契约） |
| W6 `apps/desktop` 界面 | React 渲染进程：三栏、对话流、审批、成果卡片与差异、设置页 | W0（SDK 接口）；接真实后端时依赖 W5 | W5（用假 SDK 先写） |
| W7 kernel 维护（步骤 1 遗留） | thinking 默认改为开启、Job Object、`perProject`、`pause_turn`、system prompt 的文件工具指引 | 步骤 1 代码 | 全部 |
| W8 测试与 CI（固定讨论串） | test-support 扩展、`accept-step2.mjs`、桌面 E2E、CI 改动、真实模型手动 workflow 与判定脚本 | 各包按需 | 全部；贯穿五轮 |

依赖顺序（箭头指向被依赖方）：

```text
apps/desktop(W5,W6) ──► sdk(W4) ──► context(W1) ──┐
        │                 │   ├───► tasking(W2) ──┼──► kernel 契约(W0) ──► 步骤 1 的 kernel / llm / session / workspace
        │                 │   └───► skill(W3) ────┘                            ▲
        │                 └──────────────────────────────────────────────────── │ W7 维护
        └──────────────► test-support / accept-step2 (W8) ◄── 各包测试
```

## 轮次安排（每轮最多 3 个讨论串）

「测试与 CI」是固定讨论串，每轮都在；它独占 `.github/workflows/`、`packages/test-support/**`、`scripts/accept-step2.mjs`、`scripts/accept-common/**` 与 `scripts/real-task/step2-*`。其余讨论串按轮开，同领域的后续工作发回原讨论串。

| 轮 | 讨论串（≤3） | 本轮交付 | 进入下一轮的条件 |
| --- | --- | --- | --- |
| 1 | 「步骤二契约」(W0)；「kernel 维护」(W7)；「测试与 CI」(W8) | 契约与两份规范的步骤 2 章节冻结、SDK 接口文件；Job Object、`perProject`、`pause_turn`；测试文件纳入类型检查、session 截断恢复测试在 Windows 上的偶发超时、`accept-step2.mjs` 骨架（未接通时退出码 2）、桌面 E2E 在 CI 上能拉起一个空 Electron 窗口 | 契约 PR 合入 `nexgent-app`；CI 两平台绿 |
| 2 | 「上下文与技能」(W1 + W3)；「任务与成果」(W2)；「测试与 CI」(W8) | context、skill、tasking 三包按契约实现并有包内测试；脚本化 provider 的步骤 2 剧本（present、反馈、压缩、目标） | 三包合入；中期检查点（见下）第 1–3 项满足 |
| 3 | 「SDK 与 CLI」(W4)；「桌面主进程」(W5)；「桌面界面」(W6) | SDK 接通三包，CLI 改走 SDK；桌面主进程持有 SDK、IPC 令牌；界面对假 SDK 完成三栏与全部交互 | 中期检查点第 4–5 项满足；`accept-step2` 无界面层两平台绿 |
| 4 | 「桌面主进程」或「桌面界面」（二者择一收尾）；「测试与 CI」(W8)；「真实模型验收」 | 界面接真实后端；桌面层 E2E 两平台绿；真实模型补验 Linux 一次（见下；Windows 一次可选），失败的回原包修 | `accept-step2` 全部层两平台绿；真实模型判定全部通过 |
| 5 | 「测试与 CI」(W8)（写验收记录与 README 的检查）；其余按缺口开 | `docs/validation/step-2-<日期>.md`、README 只加已验收的能力、`docs/install.md` | 用户认可验收记录；问用户是否合入 `main` |

第 3 轮暂停「测试与 CI」是为了守住 3 个上限：这一轮的测试改动由各讨论串在自己包内写，`accept-step2.mjs` 的接线留到第 4 轮。若用户放宽上限，第 3 轮应同时开「测试与 CI」。

## 共享文件与根目录的归属

| 路径 | 归属 | 说明 |
| --- | --- | --- |
| `package.json`、`pnpm-workspace.yaml`、`tsconfig*.json`、`vitest.config.ts`、`.gitignore` | 集成者（「步骤二契约」） | 各讨论串新增包时在 PR 描述里列出要加的引用，由集成者一并改 |
| `pnpm-lock.yaml` | 谁加依赖谁改 | 同一时间只允许一个未合入的 PR 改 lockfile；后合入的一方合并基线后用 `pnpm install` 重新生成，不手改 |
| `.github/workflows/**` | 「测试与 CI」 | 其他讨论串不改 |
| `packages/kernel/src/contracts/**` | 「步骤二契约」 | 冻结后只能通过修改 PR 变更，并在 PR 描述里点名受影响的包 |
| `packages/kernel/src/**`（契约以外） | 「kernel 维护」 | W1–W3 需要的 kernel 挂点由契约讨论串定义接口、由 kernel 维护实现 |
| `packages/workspace/**`、`packages/llm/**`、`packages/session/**` | 「kernel 维护」 | session 新记录类型的读写也在这里实现 |
| `docs/spec/data-formats.md`、`docs/spec/permissions.md` | 「步骤二契约」 | 冻结后按章节改，每个 PR 只动一个章节 |
| `docs/reference-map.md`、`THIRD_PARTY_NOTICES.md` | 各包负责人只改自己包的行 | |
| `scripts/accept-step2.mjs`、`scripts/accept-common/**`、`scripts/real-task/step2-*` | 「测试与 CI」 | |
| `docs/validation/step-2-*.md`、`README.md` | 集成者，第 5 轮 | README 只写有验收记录的能力 |
| `CLAUDE.md` | 不在本步骤改 | 由 PR #6 处理 |

## 各工作包

### W0 契约与规范（「步骤二契约」）

- **职责**：
  - kernel 契约新增：`MaterialStore`、`DeliverableStore`、`FeedbackStore`、`GoalStore`（tasking 实现）；`ContextProvider` 与 `Compactor`（context 实现）；`SkillRegistry`（skill 实现）；agent loop 的挂点（每轮开始注入上下文、每步前检查压缩、工具执行后收集文件变更）。
  - 会话 JSONL v1 的新增记录类型（v1 内追加，旧文件仍可读）：`material.added`、`deliverable.presented`、`turn.files`（每轮文件变更）、`feedback`、`goal.set` / `goal.update`、`compaction`；`user.message.source` 增加 `feedback`。逐个写明字段、写入时机和恢复语义。
  - `data-formats.md` 填“材料元数据”“成果元数据”两章，并新增“反馈”“持久目标”“压缩”三节；`permissions.md` 填“本地 IPC 与访问令牌”，并说明 `materials/` 对模型只读、`outputs/` 快照由 tasking 写而模型不可直接改快照目录。
  - `packages/sdk/src/api.ts`：SDK 的公开类型与方法签名（只有类型，没有实现），供 W5、W6 先行。
  - 新写 ADR 0003：执行默认开启 thinking（用户 2026-10-11 决定），替代 ADR 0002 决策 3 的默认值和计划 4.9 #6 的“执行关闭 thinking”；`thinking: 'off'` 仍作为配置项保留。
  - 系统提示的步骤 2 增量文本（成果要用 `present` 声明、修改已有文件优先用 `str_replace`），由 W7 落进 `system-prompt.ts`。
- **DSH 参考包**：`deliverables`、`feedback`、`goal`、`context/file-reference`、`context/agent-instructions`、`compaction-basic`、`skill`、`sdk` 的接口部分；`interaction`、`hooks` 只参考事件划分。
- **文件归属**：`packages/kernel/src/contracts/**`、`docs/adr/0003-*.md`、`packages/sdk/src/api.ts`（冻结后交给 W4）、两份 spec 的上述章节、根目录配置文件。
- **完成标准**：
  - 契约与 SDK 接口通过 `tsc -b`；每种新记录和元数据都有 JSON schema 与读写往返测试；
  - 新记录类型加入后，步骤 1 写出的会话文件仍能被读出并恢复（用 Library 里 `validation-raw/step-1-20261011/` 的会话做夹具，复制进测试夹具目录时只保留需要的行）；
  - `permissions.md` 的 IPC 章节写明：令牌如何生成与传递、渲染进程能调用的方法白名单、`contextIsolation` / `sandbox` / `nodeIntegration: false` 的要求、对外部 URL 和 `file://` 导航的拒绝；
  - 契约 PR 合入后，各讨论串的派工消息引用的接口不再变化。

### W1 `@nexgent/context`（「上下文与技能」）

- **职责**：工作区说明文件（项目根的 `AGENTS.md`，其次 `NEXGENT.md`；大小上限与截断规则写进包 README）注入系统提示；资料的文件引用注入（用户消息里附带资料清单与路径，小文本文件可内联，大文件和二进制只给路径与元数据，由模型用工具读）；基本压缩：输入 token 超过阈值（配置项，默认取模型上下文的一定比例）时，把较早的轮次压成摘要，写 `compaction` 记录，后续请求带摘要 + 近期完整轮次；恢复时从最后一条 `compaction` 重建。
- **DSH 参考包**：`context/file-reference`、`context/agent-instructions`、`compaction/compaction-basic`。
- **依赖**：W0 的 `ContextProvider`、`Compactor`、`compaction` 记录。
- **文件归属**：`packages/context/**`。
- **完成标准**：
  - 说明文件存在 / 不存在 / 超长三种情况的注入测试；
  - 资料注入：文本、超大文本、二进制三种资料在请求里的表示有快照式断言（断言结构，不比整段字符串）；
  - 压缩：脚本化 provider 报告的输入 token 越过阈值后，下一次请求只含摘要与近期轮次；摘要请求本身失败时，轮次不丢、不重复压缩，账本有记录；
  - 压缩后强杀再恢复，重建的历史与强杀前一致（有测试）；
  - thinking 块在压缩边界的处理写明并有测试（被压进摘要的轮次不再回放 thinking 块）。

### W2 `@nexgent/tasking`（「任务与成果」）

- **职责**：
  - 资料：`addMaterial(path)` 复制到 `.nexgent/materials/<id>/`，写元数据（原名、大小、SHA-256、媒体类型、添加时间、来源会话），写 `material.added`；列出、移除（移除只改元数据状态，不删文件，删除需用户在界面上确认）。
  - 成果：`present` 工具（参数：路径列表 + 一句说明）；校验路径在工作区内且文件存在；为每次 present 生成成果版本 `outputs/<deliverableId>/v<n>/`（复制快照 + 元数据），写 `deliverable.presented`；同一成果的后续 present 递增版本；版本间差异（文本按行，二进制只报变化）。
  - 每轮文件变更：轮结束时汇总本轮工具造成的新增 / 修改 / 删除路径（来自文件工具的 `meta` 与轮前后的工作区比较，忽略 `.nexgent/`、`node_modules/`），写 `turn.files`。
  - 反馈：`submitFeedback({ deliverableId, version, rating?, comment })` 写 `feedback` 记录，并作为 `source: 'feedback'` 的用户消息开启新一轮。
  - 持久目标：`setGoal` / `updateGoal`（进行中、完成、放弃）；重启后由 SDK 读出并在界面显示；目标文本在每轮开始注入（交给 W1 的 `ContextProvider` 调用）。
- **DSH 参考包**：`deliverables`、`feedback`、`goal`；`jobs` 只参考状态划分。
- **依赖**：W0；workspace 的文件工具 `meta`（步骤 1 已有）。
- **文件归属**：`packages/tasking/**`。
- **完成标准**：
  - present 不存在的文件、工作区外的文件、`.nexgent/` 内的文件各被拒绝并给出可读错误；
  - v1、v2 快照各自不变（改工作区文件后旧快照哈希不变）；v1→v2 差异测试；
  - 每轮文件变更与实际改动一致，包括经 `bash` / `pwsh` 改的文件（靠前后比较，不只靠文件工具）；
  - 反馈 → 新一轮 → 新版本的链路在脚本化 provider 下有包级测试；
  - 资料、成果、反馈、目标在强杀后恢复，全部可列出（有测试）；
  - Windows 路径（盘符、反斜杠、大小写）有测试。

### W3 `@nexgent/skill`（「上下文与技能」）

- **职责**：技能发现（内置技能目录 + 项目 `.nexgent/skills/`，`SKILL.md` 带 frontmatter：名称、描述、触发说明）；技能清单进系统提示，`load_skill` 工具按需加载全文；内置一个 Office 读取技能：`.docx`、`.xlsx`、`.pdf` 转文本 / 表格的工具（纯 JS 依赖，选型在 PR 里说明许可证与体积，不引入原生模块和 Python）。
- **DSH 参考包**：`skill`、`skill-office`（只参考“技能说明 + 工具”的组织方式）。
- **依赖**：W0 的 `SkillRegistry`。
- **文件归属**：`packages/skill/**`。
- **完成标准**：
  - 技能发现、frontmatter 错误、同名覆盖（项目优先于内置）有测试；
  - 三种 Office 格式各有一个小夹具，提取结果有断言；损坏文件给出工具错误而不是崩溃；
  - 技能工具在 `read-only` 沙箱下可用，不写工作区；
  - 两平台测试通过。

### W4 `@nexgent/sdk` 与 CLI 改接（「SDK 与 CLI」）

- **职责**：实现 W0 的 SDK 接口：项目（最近项目列表存在 `~/.nexgent/` 下、新建、打开）；会话（列出、新建、打开、恢复、历史投影）；发送消息与事件流（文本增量、工具活动、审批请求、成果、文件变更、轮次结束）；取消；审批应答；资料、成果、反馈、目标的操作；设置（模型、thinking、effort、费用上限写 `config.json`；密钥只报 `{ configured, source }`，可写入本机凭证文件但不回读值）；`export(sessionId)` 最小导出包（会话 JSONL、相关账本行、资料与成果元数据，不含密钥）。CLI 的 `CliRuntime` 改为调用 SDK，`nexgent run / resume` 行为不变，新增 `nexgent export <session>`，`nexgent app` 启动桌面应用。
- **DSH 参考包**：`sdk`、`apps/cli`（只参考命令划分）。
- **依赖**：W0；集成时依赖 W1–W3、步骤 1 各包。
- **文件归属**：`packages/sdk/**`（`api.ts` 冻结后归这里，改动走契约修改 PR）、`apps/cli/**`。
- **完成标准**：
  - `accept-step1` 不改脚本照样通过（CLI 改接不改行为）；
  - 一个进程内同时打开两个项目、各跑一轮互不干扰（有测试）；
  - 事件流在取消、强杀恢复、审批超时三种情况下都以一个轮次结束事件收尾；
  - `export` 的产物里搜不到当前密钥值（有测试）；
  - SDK 不 import Electron，可在纯 Node 下运行。

### W5 `apps/desktop` 主进程与打包（「桌面主进程」）

- **职责**：Electron 外壳（窗口、菜单、单实例、关闭协议：有进行中的轮次时先确认，确认后取消并等待轮次结束再退出）；主进程持有 SDK；preload 用 `contextBridge` 暴露白名单方法，每次调用带启动时生成的令牌；文件选择对话框（添加资料、打开项目）；在系统文件管理器中显示成果；日志文件（`~/.nexgent/logs/`，按天滚动，级别可配）；electron-builder 未签名打包（Windows NSIS、Linux AppImage），CI 只产出构建物，不发布。
- **DSH 参考包**：`apps/desktop`（只参考外壳、打包配置与关闭流程；不复制 client 的 remote 协议代码）。
- **依赖**：W0 的 IPC 规范、W4。
- **文件归属**：`apps/desktop/src/main/**`、`apps/desktop/src/preload/**`、`apps/desktop/electron-builder.*`、`apps/desktop/package.json`、`docs/install.md`。
- **完成标准**：
  - 渲染进程无 Node 能力（`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`），有测试检查窗口配置；
  - 缺令牌、错令牌、白名单外方法的 IPC 调用被拒并写日志（有测试）；
  - 拒绝导航到外部 URL 与任意 `file://`；
  - 强杀主进程后再启动，不需要手动清锁就能打开原会话；
  - 两平台打包任务在 CI 上产出构建物；`docs/install.md` 写明从源码运行与安装未签名包的步骤。

### W6 `apps/desktop` 界面（「桌面界面」）

- **职责**：React 18 渲染进程（Vite），Codex 式布局：左栏项目切换与对话列表；中栏对话（流式文本、工具活动折叠块、审批对话框、成果卡片与版本差异视图、停止按钮、Composer 的 `@` 资料引用）；右栏项目文件、资料、成果、目标状态；设置页（模型、thinking、effort、密钥状态、费用上限）；空状态与错误状态。信息架构与品牌沿用 Nexgent PyQt 设计（`main` 分支 `nexgent/docs/superpowers/specs/2026-07-17-nexgent-desktop-gui-design.md` 与 `nexgent/assets/brand`）。
- **DSH 参考**：client 的 `ui-chat`、`ui-conversation`、`ui-approval`、`ui-deliverables`、`ui-sidebar`、`ui-workspace`、`ui-settings-models`（只参考交互与组件划分，从空白工程写）。
- **依赖**：W0 的 SDK 接口（先对假 SDK 开发）；接真实后端依赖 W5。
- **文件归属**：`apps/desktop/src/renderer/**`、`apps/desktop/index.html`、`apps/desktop/vite.config.*`。
- **完成标准**：
  - 组件测试（vitest + Testing Library）覆盖：流式文本追加、工具块、审批三种选项、成果卡片与差异、停止、设置页保存；
  - 密钥输入框写入后不回显值，只显示“已配置 / 来源”；
  - 断开后端（主进程报错）时界面显示错误而不是白屏；
  - 中文界面文案统一；窗口宽度 1024 时三栏不溢出。

### W7 kernel 维护（「kernel 维护」）

- **职责**：按 W0 的 ADR 把 `DEFAULT_PROJECT_CONFIG.thinking` 改为 `'on'`（自适应 thinking），CLI `--help`、包 README 与测试夹具随之更新；Windows 进程树终止改用 Job Object 或等效方式，Linux 保持进程组；`perProject` 费用上限按账本窗口执行；`pause_turn` 自动续跑（有次数上限）；系统提示加入 W0 定的步骤 2 增量；实现 W0 定义的 agent loop 挂点与 session 新记录类型的读写；`nexgent.ps1` 在 Windows CI 上实跑一次。
- **文件归属**：`packages/kernel/src/**`（契约除外）、`packages/workspace/**`、`packages/llm/**`、`packages/session/**`、`apps/cli/bin/nexgent.ps1`。
- **完成标准**：
  - Windows 上 `pwsh` 工具超时与取消后，用进程列表检查没有残留子孙进程（测试在 Windows CI 上跑）；
  - `perProject` 达到上限时的会话与账本记录符合 `permissions.md`“费用上限”一节；
  - 脚本化 provider 返回 `pause_turn` 时自动续跑，超过上限时以可读错误结束；
  - 步骤 1 的全部测试与 `accept-step1` 继续通过。

### W8 测试与 CI（固定讨论串「测试与 CI」）

- **职责**：
  - test-support：脚本化 provider 的步骤 2 剧本（present、反馈、压缩触发、目标、审批）；故障注入新增“工具执行中强杀”“压缩请求失败”。
  - `scripts/accept-step2.mjs`：三层（无界面、桌面、真实模型），检查项见下节；输出摘要 JSON 符合 `docs/validation/TEMPLATE.md`；退出码沿用步骤 1（0 通过、1 失败、2 尚未接通，不伪造通过）。
  - 桌面 E2E：Playwright 的 Electron 驱动；Linux 用 xvfb，Windows 直接跑；文件对话框打桩。
  - CI：测试文件纳入 `tsc -b`；`accept-step2` 两层加进 `nexgent.yml`；打包任务；手动触发的真实模型 workflow（`workflow_dispatch`，两平台矩阵，读仓库 secret，产物只上传摘要 JSON，不上传会话原文）。
  - 真实任务素材与判定脚本 `scripts/real-task/step2-*`（见“真实模型补验”）。
- **文件归属**：`packages/test-support/**`、`scripts/accept-step2.mjs`、`scripts/accept-common/**`、`scripts/real-task/step2-*`、`.github/workflows/**`。
- **完成标准**：每轮结束时两平台 CI 绿；`accept-step2` 的每个检查项都有一个能失败的反例测试（把被测行为关掉时该项报失败）；真实模型 workflow 在没有 secret 时以退出码 2 结束而不是报通过。

## 中期检查点（第 2 轮末到第 3 轮中）

目的：确认无界面的全链先通，再把桌面应用接上去；避免界面写完才发现后端缺口。

必须工作的内容（脚本化 provider，Linux 通过，Windows 至少本地或 CI 通过）：

1. tasking：资料添加、present 生成 v1、反馈后生成 v2，强杀后都能列出；
2. context：说明文件注入与压缩触发；
3. skill：`.xlsx` 资料经技能工具读出表格；
4. SDK：不经 CLI，用 SDK 跑完“资料 → 执行 → present → 反馈 → v2 → 强杀 → 恢复 → 续聊”；
5. CLI 改接后 `accept-step1` 仍通过。

判定：五项满足则第 3 轮的桌面讨论串接真实后端；第 4 项不满足时，桌面讨论串继续对假 SDK 开发，「SDK 与 CLI」延长一轮，不开新串。

## `accept-step2` 检查项清单

所有判定由脚本从文件、会话、账本和进程状态得出，不看模型或界面的自述。每项在摘要 JSON 里有 `id`、`pass`、`evidence`。

### 无界面层（脚本化 provider，经 SDK 与 CLI，两平台 CI）

| ID | 检查 |
| --- | --- |
| H01 | 新目录初始化：`.nexgent/` 布局与 `config.json` 存在；最近项目列表含该项目 |
| H02 | 添加两份资料（一份 `.csv` 文本、一份 `.xlsx`）：复制到 `materials/<id>/`，元数据通过 schema，SHA-256 与原文件一致，原文件未被修改 |
| H03 | 首轮请求里出现两份资料的引用；模型写 `materials/` 被拒（工具结果为错误） |
| H04 | `.xlsx` 资料经 Office 技能工具读出，请求中出现 `load_skill` 与读取工具的调用和结果 |
| H05 | 工作区说明文件 `AGENTS.md` 的内容出现在系统提示 |
| H06 | 首轮 `turn.end` 为 completed；本轮有 `write_file` 与 `str_replace` 的成功调用 |
| H07 | `present` 调用后有 `deliverable.presented` 记录；`outputs/<id>/v1/` 快照与工作区文件哈希一致；成果元数据通过 schema |
| H08 | `turn.files` 与实际改动一致（含一处经 `bash` / `pwsh` 修改的文件） |
| H09 | 提交反馈（评分 + 评语，关联 v1）：有 `feedback` 记录与 `source: 'feedback'` 的用户消息 |
| H10 | 修改轮后有 v2；v1 快照哈希不变；v1→v2 差异非空且只涉及预期文件 |
| H11 | 持久目标：设定后写入；完成时状态更新 |
| H12 | 进程内取消：长流式轮中取消后，已流出文本在 `assistant.message.interrupted` 中保留，`turn.end` 为 cancelled；运行中的长 shell 命令被终止，无残留子孙进程 |
| H13 | 审批：工作区外写入触发审批，拒绝后工具结果为拒绝；`once` 批准只生效一次 |
| H14 | 压缩：输入 token 越过测试阈值后写出 `compaction` 记录，下一次请求只带摘要与近期轮次 |
| H15 | 强杀一：模型流到一半强杀进程（Windows 结束整个进程树） |
| H16 | 强杀二：工具执行到一半强杀进程 |
| H17 | 每次强杀后新进程恢复：中断的轮次被写成 `interrupted`；续聊请求含完整历史（压缩后为摘要加近期轮次）且回放 `providerContent` |
| H18 | 恢复后经 SDK 查询：会话历史、两份资料、成果 v1 / v2、一条反馈、目标状态全部可见，且与强杀前一致 |
| H19 | 会话 `seq` 连续，全部记录通过 schema；账本请求开始 / 结束配对，每轮一条 `task.outcome` |
| H20 | `.nexgent/` 全部文件与 `export` 产物中搜不到测试密钥值 |
| H21 | `perProject` 上限达到时以 `budget/exhausted` 结束，记录符合 `permissions.md` |
| H22 | `nexgent export <session>` 产物包含会话、相关账本行与元数据 |

### 桌面层（脚本化 provider，Playwright 驱动 Electron，两平台 CI）

| ID | 检查 |
| --- | --- |
| D01 | 应用启动，窗口加载，渲染进程控制台无错误；窗口配置满足隔离要求 |
| D02 | 新建项目、从最近项目重新打开 |
| D03 | 添加资料（对话框打桩）后右栏资料列表出现两项 |
| D04 | 发送消息后中栏出现流式文本与工具活动块 |
| D05 | 审批对话框出现，选择后轮次继续 |
| D06 | 成果卡片出现；反馈后出现 v2，差异视图显示 v1→v2 的变化 |
| D07 | 停止按钮取消当前轮，已流出文本保留在界面和会话里 |
| D08 | 强杀主进程后重新启动：左栏对话、右栏资料与成果都在，继续对话成功 |
| D09 | 设置页修改模型、thinking 与费用上限后写入 `config.json`；密钥只显示是否配置与来源 |
| D10 | 无令牌或错令牌的 IPC 调用被拒 |

### 真实模型层（`--real`，手动，见下节）

| ID | 检查 |
| --- | --- |
| R01 | 真实任务结果由隐藏检查判定通过（数值、文件结构、测试） |
| R02 | 全程至少一次 `write_file` 与一次 `str_replace` 成功调用，且修改轮里对已有文件的修改有一次走 `str_replace` |
| R03 | thinking 开启的运行里，会话含 thinking 块；恢复后的续聊请求被 API 接受（无 400），说明 thinking 块回放正确 |
| R04 | 中断恢复：在真实请求流中途强杀，新进程恢复后完成剩余工作；被打断的请求在账本里有记录，用量缺失记 unknown，不算成功 |
| R05 | 链路覆盖：资料、present、反馈、v2、强杀、恢复全部发生（复用 H 层的检查函数） |
| R06 | （可选，不进门槛）Windows 上 R01–R05 全部通过，shell 工具为 `pwsh` |
| R07 | 每次运行的请求数、token、unknown 数、估算费用写进摘要；费用不超过本次运行的上限 |

## 真实模型补验

### 任务

用计划 4.9 #8 选定的“表格 / 数据”任务族，素材放 `scripts/real-task/step2-sales/`（脚本运行时复制到仓库外的新项目目录）：

- 资料：一份订单明细 `orders.csv`（约 300 行，含故意的脏数据：重复订单号、空地区、金额带千分位）和一份价目与地区对照表 `regions.xlsx`。
- 第 1 轮：“清洗订单数据，按地区和月份汇总销售额，写一个可重复运行的 Node 脚本生成 `report/summary.csv` 和 `report/README.md`，完成后把成果交给我。”
- 第 2 轮（反馈，关联 v1）：评分 3/5，评语“地区要用对照表里的中文名；再加一列环比增长；README 里说明清洗规则”。这一轮是对已有文件的修改，用来检验 `str_replace`。
- 第 3 轮：在第 3 轮模型流到一半时强杀进程，新进程恢复后补完（“把重复订单的处理方式也写进 README”）。
- 判定：隐藏脚本独立计算期望的汇总表（去重、规范化后的数值，允许 0.01 的舍入误差），检查 `summary.csv` 的列与数值、脚本可在新目录重跑得到同一结果、README 提到清洗规则与重复订单、v1 / v2 / v3 三个版本存在且 v1 快照未变。

### 运行方案

| 次 | 平台 | thinking | 用途 |
| --- | --- | --- | --- |
| 1 | Linux 云端 | 开（默认） | 门槛内唯一一次：R01–R05、R07；同时设较低的压缩阈值，让压缩在真实模型下触发一次 |
| 2（可选） | Windows | 开 | R06，不进门槛 |

运行位置（用户 2026-10-11 决定）：

- **Linux 一次**（第 1 次）：在云端会话里跑，密钥用云端环境已有的 `NEXGENT_API_KEY`，原始记录放项目资料库 `validation-raw/step-2-<日期>/`。
- **Windows 一次**（第 2 次，可选）：「测试与 CI」新增手动触发的真实模型 workflow，在 `windows-latest` 上跑。用户已在仓库里加好 `NEXGENT_API_KEY` secret，想跑时手动触发即可；它不进退出门槛。workflow 在没有 secret 时以退出码 2 结束。

### 预估费用

按 ADR 0002 的价目（输入 2 美元 / 百万 token、输出 10 美元、缓存读 0.20 美元；缓存写按输入的 1.25 倍即 2.5 美元估算）。步骤 1 的真实任务是 8 次请求约 0.08 美元。步骤 2 的任务有资料、技能说明、三轮加一次恢复，估计：

| 项 | 每次运行估计 |
| --- | --- |
| 请求数 | 30–50 |
| 缓存读 | 约 100 万 token → 约 0.20 美元 |
| 缓存写 | 约 20 万 token → 约 0.50 美元 |
| 输出（thinking 开时含思考） | 约 4 万 token → 约 0.40 美元 |
| 未缓存输入 | 可忽略 |
| **合计** | **约 1–1.5 美元** |

门槛内只有一次 Linux 运行，约 1–1.5 美元；修复后重跑最多再两次计，可选的 Windows 一次另计约 1–1.5 美元，全部加起来不超过约 6 美元。建议预算上限 **15 美元**，由脚本在每次运行时设置 `costCaps.perTask`，并在累计估算超过上限时拒绝开始新运行。这是估算，不是账单；实际金额以账单为准。用户 2026-10-11 已同意 15 美元的上限。

## 风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 桌面应用工作量大，是关键路径 | 步骤 2 超出 3–4 周 | 界面先对假 SDK 写；中期检查点保证后端先通；打包只做未签名 |
| Electron 在 CI 上（xvfb、Windows 运行器、二进制下载）不稳定或下载被代理拦截 | 桌面层 CI 红 | 第 1 轮就让 CI 拉起空窗口，提前暴露；缓存 Electron 二进制；失败按根因修，不跳过测试 |
| 真实模型默认仍用 `bash` 改文件，R02 不通过 | 文件编辑工具仍未被检验 | 系统提示与工具描述加指引；仍不通过时如实记录为失败，不改判定标准，回 W7 调整提示后重跑 |
| thinking 块回放或压缩边界处理错误，恢复时 API 报 400 | 中断恢复在真实模型下失败 | W1 写明压缩边界规则并测试；R03 专门检查 |
| Windows 进程树终止没做好 | 强杀和取消后残留进程、锁不释放 | W7 第 1 轮先做；H12、H15–H17 在 Windows CI 上跑 |
| Office 解析依赖的许可证、体积或安全问题 | 依赖被否或打包变大 | 只选纯 JS、维护活跃的库，PR 里写明许可证与体积；资料只读，不执行宏 |
| 多个讨论串同时改 lockfile 和根配置 | 合并冲突、CI 红 | 根配置归集成者；lockfile 一次只允许一个未合入 PR 修改 |
| 契约冻结后频繁改动 | 下游返工 | 修改走契约 PR 并点名受影响包；中期检查点前不接受非必要改动 |
| Windows 上的真实模型行为不在门槛内 | Windows 特有的问题（`pwsh` 引号、路径、进程树）可能只在真实模型下暴露 | 脚本化 CI 在 Windows 覆盖同样的链路；仓库 secret 已就绪，可随时手动跑可选的 R06 |
| Windows CI 上 `packages/session/tests/store.spec.ts` 的“逐字节截断恢复”测试偶发超过 5 秒超时（PR #7 的一次运行出现，同一提交的另一次运行通过） | 与改动无关的 CI 红 | 「测试与 CI」第 1 轮查明耗时来源，让测试在 Windows 上稳定（减少无谓的文件重开或按平台给出有依据的超时），不跳过 |
| 云环境不能显示图形界面 | 无法人工看界面 | 用 Playwright 截图附在 PR 里；最终界面由用户在本机过目 |

## 已定的决定（用户 2026-10-11）

1. 真实模型运行：门槛只要求一次，在 Linux 云端会话里、开 thinking 跑，用云端环境的 `NEXGENT_API_KEY`。Windows 真实运行改为可选：仓库 secret 已由用户加好，想跑时手动触发 workflow。Windows 的脚本化 CI 照常保持全绿。
2. 执行默认开启 thinking，由 W0 写 ADR 0003、W7 改默认值；`thinking: 'off'` 只作为配置项保留。
3. 真实模型补验预算上限 15 美元（门槛内预估 1–1.5 美元）。
4. 步骤 2 的小 PR 合入 `nexgent-app`：CI 两平台绿后由负责的讨论串直接用普通合并合入，署名 csxq0605，分支不删；合入 `main` 仍要先问用户。
5. 安装包签名与自动更新放到步骤 2 之后。
