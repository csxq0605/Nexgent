# 步骤 1 分工表：建立基于 DSH 的 Nexgent 主应用

来源：计划 [4.1](../research/pr4-review-and-plan-2026-10/README.md) 与 4.10“并行与分工”。本表在步骤 1 开工前定稿，回答三个问题：谁做哪个包、谁依赖谁、谁能并行；每个包的文件归属固定，子智能体之间不编辑同一文件。估计工期 4–6 周，中期检查点在第 2–3 周末。

## 总览

| 包 | 职责一句话 | 依赖 | 可并行 |
| --- | --- | --- | --- |
| `@nexgent/kernel` | Cordis 应用装载、`ctx.agents` 与 agent loop、`ctx.tools`、系统提示、凭证与存储原语、服务契约 | Cordis 库；契约冻结后依赖 llm / session / workspace 的实现 | 契约冻结后与其余四包并行 |
| `@nexgent/llm` | Claude Platform 单路由（ADR 0002）、流式与工具调用、用量计量、请求账本 | kernel 契约 | session、workspace、test-support |
| `@nexgent/session` | JSONL v1 追加写、checkpoint、按会话 ID 恢复 | kernel 契约、`docs/spec/data-formats.md` | llm、workspace、test-support |
| `@nexgent/workspace` | 工作目录与 `.nexgent/`、文件工具、shell 工具、子进程、沙箱策略 | kernel 契约、`docs/spec/permissions.md` | llm、session、test-support |
| `apps/cli` | `nexgent run / resume / app`、项目数据目录、密钥读取、验收脚本 | 全部四包 | 第 1 周可先写参数解析与骨架 |
| `packages/test-support` | 脚本化 provider、故障注入、跨进程验收框架 | kernel 契约（provider 接口） | 与全部包并行；是其他包测试的前提 |

依赖顺序（箭头指向被依赖方）：

```text
apps/cli ──► kernel ──► llm
   │           │  └───► session
   │           └──────► workspace
   └──────────────────► test-support ◄── (llm, session, workspace 的测试)
```

工作顺序：

1. **第 1 周：契约与规范先行。** kernel 负责人冻结 `packages/kernel/src/contracts/` 下的服务接口（`LLMProvider`、`SessionStore`、`Workspace`、`Sandbox`、`Credentials`、`Ledger`），并写完 `docs/spec/data-formats.md` 与 `docs/spec/permissions.md` 的步骤 1 部分；test-support 同步提供脚本化 provider 的最小实现。契约文件在冻结后只能通过修改 PR 变更，并通知依赖方。
2. **第 2–3 周：四包并行。** llm、session、workspace 各自对契约实现并用 test-support 的仿真测试；kernel 做 agent loop 与 profile 装载；cli 接骨架。第 2–3 周末过中期检查点。
3. **第 4–6 周：接通与验收。** cli 串联四包，`scripts/accept-step1.mjs` 两平台通过，故障注入补边界，真实模型（Claude Sonnet 5.5，ADR 0002）手动一次，写验收记录。

## 共享文件与根目录的归属

| 路径 | 归属 | 说明 |
| --- | --- | --- |
| `package.json`、`pnpm-workspace.yaml`、`tsconfig*.json`、`vitest.workspace.*`、`.github/workflows/`、`.gitignore` | 集成者 | 子智能体不改；需要改的在 PR 描述里提出 |
| `packages/kernel/src/contracts/**` | kernel | 其他包只读；变更走修改 PR |
| `docs/spec/data-formats.md` | 集成者（session 负责人起草会话与账本章节） | 冻结后按章节改，每个 PR 只动一个章节 |
| `docs/spec/permissions.md` | 集成者（workspace 负责人起草沙箱章节） | 同上 |
| `docs/reference-map.md`、`THIRD_PARTY_NOTICES.md` | 每个包的负责人改自己包对应的行 | 同一 PR 内只改自己包的行，避免冲突 |
| `scripts/accept-step1.mjs` | apps/cli | |
| `docs/validation/step-1-*.md` | 集成者 | |

## 各包

### `@nexgent/kernel`

- **职责**：Cordis 应用装载（YAML profile + patch 行，PR #4 `cordis.patch.yml` 的产品默认值迁入）；`ctx.agents` 创建 / 恢复；agent loop（请求模型、执行工具、写入会话，含取消与超时）；`ctx.tools` 注册与作用域；系统提示组装；凭证读取（`NEXGENT_API_KEY` 优先，其次本机凭证文件）；原子写与 JSON 存储原语；全部服务契约。
- **DSH 参考包**：`boot/app-boot`、`core/agent`、`core/agent-loop`、`core/scope`、`core/tools`、`core/system-prompt`、`core/session`（接口）、`core/agent-default-model`、`credentials/credentials(-local)`、`storage/storage(-json)`、`util/atomic-write`、`util/timeout`；超时边界可看 `guard/timeout-policy`。
- **依赖**：`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@cordisjs/loader`；运行时依赖 llm / session / workspace 的实现，但只通过契约。
- **可并行**：契约冻结（第 1 周）后与 llm、session、workspace、test-support 并行。
- **文件归属**：`packages/kernel/**`。
- **完成定义**：
  - 从 YAML profile 装载一个应用，注入脚本化 provider 后完成“用户消息 → 模型请求 → 一次工具调用 → 工具结果回传 → 最终回复”的闭环，且每轮写入 session；
  - 取消正在进行的轮次后，已流出的文本保留，进程无悬挂子进程；模型请求超时、工具抛错各有测试；
  - profile 装载的默认值与 PR #4 `cordis.patch.yml` 一致（MiMo 路由、thinking 关闭、系统提示）；
  - 不 import 任何 `reference/` 下的代码；复制件均有 `Adapted from` 头并已登记；
  - 包内测试在 Linux 与 Windows 通过。

### `@nexgent/llm`

- **职责**：单一 OpenAI 兼容路由（默认 MiMo，端点与模型名可配置）；流式输出与工具调用解析；用量计量，缺失标 unknown；`maxRetries: 0`，每次请求（含失败）写入账本（PR #4 `execution-ledger.ts` 的请求记录部分）；thinking 关闭；代理设置。
- **DSH 参考包**：`llm/llm`、`llm/llm-pi-ai`、`llm/token-meter`、`util/http-proxy`。不要 `llm-retry`、`llm-deepseek`。
- **依赖**：kernel 契约（`LLMProvider`、`Ledger`）。
- **可并行**：session、workspace、test-support。
- **文件归属**：`packages/llm/**`。
- **完成定义**：
  - 对一个本地 OpenAI 兼容假服务（test-support 提供）完成流式文本、流式工具调用、多工具并行调用的解析，有录制回放测试；
  - 断网、超时、HTTP 4xx / 5xx 各产生一条账本记录，用量字段为 unknown 而不是 0；
  - 账本记录格式与 `docs/spec/data-formats.md` 的账本章节一致，有 schema 测试；
  - 真实模型（Claude Sonnet 5.5，ADR 0002）手动一次：一次带工具调用的请求成功，用量非 unknown。

### `@nexgent/session`

- **职责**：会话 JSONL v1 的追加写与 checkpoint；启动时按会话 ID 恢复为 agent 可继续的状态；会话文件放在 `.nexgent/sessions/<id>/`；只定义 v1，不做迁移。
- **DSH 参考包**：`session/session-persistence(-jsonl)`、`session/session-checkpoint-policy`、`session/session-projection`；`session/session-format` 只参考记录类型划分。
- **依赖**：kernel 契约（`SessionStore`）、`docs/spec/data-formats.md` 会话章节。
- **可并行**：llm、workspace、test-support。
- **文件归属**：`packages/session/**`；`docs/spec/data-formats.md` 会话与账本章节的起草。
- **完成定义**：
  - 写入 N 条记录后在任意位置截断文件（模拟 `kill -9`），恢复得到最后一条完整记录之前的状态，不丢已完整写入的记录，不崩溃；
  - checkpoint 后恢复不需要重放全部记录，有性能测试上限；
  - 两个进程不能同时写同一会话（锁或租约），有测试；
  - 格式有 JSON schema 与读写往返测试；文件名、目录布局与 spec 一致。

### `@nexgent/workspace`

- **职责**：工作目录与 `.nexgent/` 数据目录（`sessions/ materials/ outputs/ capabilities/ ledgers/`）的创建与定位；文件读、写、搜索、`str_replace` 编辑工具；`bash`（Linux / macOS）与 `pwsh`（Windows）工具；子进程生命周期（超时、进程树终止）；沙箱策略：路径白名单、写入限制、命令策略；Windows ACL 为可选项后补。
- **DSH 参考包**：`workspace/workspace`、`fs/*`（`fs`、`fs-local`、`fs-sandbox`、`fs-observation-policy`、`tool-fs`、`tool-fs-search`、`tool-str-replace-editor`）、`shell/*`（`shell`、`shell-env`、`bash-local`、`bash-sandbox`、`pwsh-local`、`pwsh-sandbox`、`tool-bash`、`tool-pwsh`）、`subprocess/*`、`sandbox/sandbox`、`sandbox-policy`、`sandbox-local`；可选 `sandbox-windows-acl`。
- **依赖**：kernel 契约（`Workspace`、`Sandbox`、工具注册）、`docs/spec/permissions.md` 沙箱章节。
- **可并行**：llm、session、test-support。
- **文件归属**：`packages/workspace/**`；`docs/spec/permissions.md` 沙箱章节的起草。
- **完成定义**：
  - 三种沙箱模式（只读 / 工作区写 / 完全访问）下，白名单外写入、`..` 逃逸、符号链接逃逸均被拒绝，有两平台测试；
  - `bash` / `pwsh` 工具超时后进程树被终止，Windows 用 `win32-process` 的方式验证无残留；
  - `str_replace` 编辑在多处匹配、无匹配、CRLF 文件上行为有测试；
  - 搜索工具在包含 `.nexgent/` 与 `node_modules/` 的目录下有忽略规则。

### `apps/cli`

- **职责**：`nexgent run --project <dir> --task "..."`（一次性执行）、`nexgent resume <session>`、`nexgent app --project <dir>`（步骤 2 的桌面应用入口，步骤 1 只占位）；项目数据目录初始化；密钥来源；`scripts/accept-step1.mjs`：脚本化 provider 下启动 → 完成一次写文件任务 → 杀进程 → 新进程 `resume` 续聊；两平台 CI 各跑一次；真实模型（Claude Sonnet 5.5，ADR 0002）手动一次并留摘要。PowerShell 启动器的参数设计从 PR #4 移植。
- **DSH 参考包**：`boot/cmdline`、`bundle/base`、`bundle/headless`、`apps/cli`。
- **依赖**：kernel、llm、session、workspace、test-support。
- **可并行**：第 1 周可写参数解析、项目目录初始化与验收脚本骨架；串联在第 4 周起。
- **文件归属**：`apps/cli/**`、`scripts/accept-step1.mjs`、`scripts/accept-common/**`（若验收脚本的公共部分不放在 test-support）。
- **完成定义**：
  - `accept-step1` 在 Linux 与 Windows CI 通过，输出摘要 JSON 符合 `docs/validation/TEMPLATE.md` 的字段；
  - 不存在 Python 执行路径；
  - 真实模型（Claude Sonnet 5.5，ADR 0002）手动一次：完成真实写文件任务并保存原生会话，摘要进入 `docs/validation/step-1/`。

### `packages/test-support`

- **职责**：脚本化 provider（按脚本返回文本与工具调用，可断言收到的请求）；本地 OpenAI 兼容假服务（供 llm 测试流式解析）；故障注入（断网、超时、子进程 kill、文件截断）；跨进程验收脚本的公共框架（启动子进程、等待状态、杀进程、读会话与账本）；真实模型手动验收的摘要生成器。
- **DSH 参考包**：`test-support/agent-loop-testkit`、`test-support/llm-replay`、`test-support/llm-mock-server`（只参考设计，重写）。
- **依赖**：kernel 契约（`LLMProvider`）。
- **可并行**：全部；第 1 周先交付脚本化 provider 的最小实现，其余按各包需要补。
- **文件归属**：`packages/test-support/**`。
- **完成定义**：
  - 脚本化 provider 的仿真规范写在包 README 中：脚本格式、工具调用的表示、unknown 用量的表示；
  - 四个故障注入各有一个 kernel 或包级测试使用；
  - 验收脚本框架被 `accept-step1.mjs` 使用，摘要 JSON 有 schema。

## 中期检查点（第 2–3 周末）

目的：决定是否启用 ADR 0001 决策 11 的备选（临时以 DSH npm 包作为后端先打通步骤 2）。只在这个检查点决定，默认不启用。

到检查点时必须工作的内容（全部在脚本化 provider 下、Linux 通过、Windows 至少本地通过）：

1. kernel 从 YAML profile 装载应用，完成一次“消息 → 工具调用 → 回复”闭环并写入会话；
2. llm 对假服务完成流式文本与流式工具调用的解析，账本有记录；
3. session 写入后截断恢复的测试通过；
4. workspace 的文件读写与 `str_replace` 工具在工作区写模式下可用，白名单外写入被拒；
5. `nexgent run` 骨架能把以上四者串起来跑完一个写文件任务（可以不含 `resume`）。

判定：

- 五项全部满足：继续重写，不启用备选。
- 第 1 或 5 项不满足，且估计还需超过 2 周：启用备选，写 ADR 0002 记录启用原因、所用的 DSH npm 版本与恢复重写的时间点；kernel 的重写继续在分支上进行，不阻塞步骤 2。
- 只有第 2–4 项中的某一项不满足：不启用备选，调整分工（把该包的负责人换为已完成包的负责人协助），检查点延后一周复查一次。

## 开工前要写的两份规范

两份规范在第 1 周内写完步骤 1 需要的章节，其余章节留标题；桩已建在 `docs/spec/`。

### `docs/spec/data-formats.md`

必需章节：目的与范围；`.nexgent/` 目录布局；项目配置文件；会话 JSONL v1（记录类型、追加与截断规则、checkpoint、恢复、并发）；账本记录（请求记录、`task-outcome`，预留步骤 4 的 `capabilityVersion / memberId / executionForm / taskId` 字段）；`CapabilityBundle` 清单（步骤 4 填）；材料元数据（步骤 2 填）；成果元数据（步骤 2 填）；版本与兼容；schema 与读写测试。

### `docs/spec/permissions.md`

必需章节：目的与范围；沙箱模式（只读 / 工作区写 / 完全访问）；路径策略与写入限制；命令策略；工具审批；插件安装审批（步骤 4 填）；费用上限（每任务 / 每项目，步骤 1 只定格式）；密钥存放；本地 IPC 与访问令牌（步骤 2 填）；已知边界与绕过（含 Windows 路径策略弱于 ACL、插件包进程内执行）；CLI 与桌面应用共用的审批交互；测试。
