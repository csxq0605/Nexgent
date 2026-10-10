# DSH → Nexgent 参考对照表

参考库：`deepseek-ai/deepseek-harness`，固定提交 `46a7f68b0922371ce7144b668b90e377d8e799f4`（版本 0.1.7-rc.1，MIT）。本表维护计划 4.0 要求的“DSH 包 → Nexgent 包 → 处理方式”对照：从参考库改写文件、新增或删除 Nexgent 包时更新本表。DSH 的包路径按参考库 `packages/<组>/<包>` 写；Nexgent 包按 `packages/<名>`（`@nexgent/<名>`）或 `apps/<名>` 写。

**处理方式的含义。**
- **改写**：允许从参考库复制文件再改（MIT），复制件按本文末尾的规则登记；只取当前步骤需要的部分，边界用 Nexgent 自己的测试固定。
- **重写**：只参考设计、接口与交互划分，代码从空白写；不复制文件。
- **不要**：不进入 Nexgent；需要时再回到参考库改写，并更新本表。

**保留的命名。** DSH 的服务名与模块边界（`ctx.agents`、`ctx.tools`、`ctx.session`、`ctx.workflowEngine` 等）作为 Nexgent 的内部接口命名保留，使 DSH 的架构文档可继续作参考。不追求功能对等；目标规模约为 DSH 对应代码的三分之一。

## 按步骤的对照

### 步骤 1：主应用（kernel / llm / session / workspace）

| DSH 包组 / 具体包 | Nexgent 包 | 处理 | 归属步骤 | 备注 |
| --- | --- | --- | --- | --- |
| `boot/app-boot` | `@nexgent/kernel` | 改写 | 1 | 已复制 `src/profile.ts`、`profile-plugins.ts`（→ `profile.ts`）、`src/index.ts`（→ `app.ts`）；PR #4 `cordis.patch.yml` 的产品默认值移植到此 |
| `boot/cmdline` | `apps/cli` | 重写 | 1 | 命令行参数解析；只保留 `run / resume / app`；步骤 1 只参考约定，基于 `util.parseArgs` 自写（`args.ts`） |
| `boot/config-editor`、`boot/hmr` | — | 不要 | — | 配置编辑与热重载不在范围 |
| `bundle/base`、`bundle/headless` | `apps/cli` | 改写 | 1 | 已复制 `headless/src/json-stream.ts`（→ `json-lines.ts`）；headless 的入口形态与 `base` 只参考设计；`nexgent run` 即 headless 入口 |
| `bundle/sdk-app`、`bundle/sdk-minimal`、`bundle/acp-app`、`bundle/web-app` | — | 不要 | — | `web-app` 见“不要”一节 |
| `core/agent` | `@nexgent/kernel` | 改写 | 1 | 已复制 `src/index.ts`（→ `agents.ts`）：`ctx.agents` 创建 / 恢复 |
| `core/agent-loop` | `@nexgent/kernel` | 重写 | 1 | 请求模型、执行工具、写入会话的循环只参考设计；取消与超时边界用故障注入测试补回 |
| `core/scope` | `@nexgent/kernel` | 改写 | 1 | 已复制 `src/index.ts`（并入 `tools.ts`）：会话作用域；步骤 4 的会话级试用依赖它 |
| `core/tools` | `@nexgent/kernel` | 改写 | 1 | 已改写 `src`（作用域注册表设计，→ `tools.ts`）：`ctx.tools` 注册与作用域；PR #4 `tool-restriction.ts` 在步骤 3 并入 |
| `core/system-prompt` | `@nexgent/kernel` | 重写 | 1 | 系统提示组装只参考设计；提示正文由 Nexgent 自写 |
| `core/session` | `@nexgent/kernel` | 重写 | 1 | `ctx.session` 服务接口；步骤 1 未复制文件；持久化在 `@nexgent/session` |
| `core/agent-default-model` | `@nexgent/kernel` | 改写 | 1 | 已复制 `src/index.ts`（并入 `agents.ts`）：默认模型 `mimo-v2.6-pro` 的配置位置 |
| `core/agent-tool-presentation` | — | 不要 | — | 面向 UI 的工具展示，步骤 2 由桌面应用自定 |
| `llm/llm` | `@nexgent/llm` | 重写 | 1 | 模型服务接口、流式与工具调用消息类型只参考设计 |
| `llm/llm-pi-ai` | `@nexgent/llm` | 重写 | 1 | 单一 OpenAI 兼容路由（MiMo），只参考设计；其他端点作为配置项 |
| `llm/token-meter` | `@nexgent/llm` | 重写 | 1 | 用量计量只参考设计；缺失用量显式标 unknown |
| `llm/llm-retry` | — | 不要 | — | 步骤 1 定 `maxRetries: 0`，每次请求进账本 |
| `llm/llm-deepseek`、`llm/deepseek-llm-api-extensions`、`llm/plugin-package-inventory-deepseek` | — | 不要 | — | DeepSeek 专有路由与扩展 |
| `session/session-persistence`、`session/session-persistence-jsonl` | `@nexgent/session` | 重写 | 1 | JSONL 追加写；只参考 `jsonl/src/storage.ts`（串行写链、撕裂尾截断）与 `lease.ts`（写租约）的设计 |
| `session/session-checkpoint-policy` | `@nexgent/session` | 重写 | 1 | checkpoint 规则只参考设计 |
| `session/session-projection` | `@nexgent/session` | 重写 | 1 | 从记录投影出会话状态；按会话 ID 恢复；只参考设计 |
| `session/session-format` | `@nexgent/session` | 重写 | 1 | 只定义 Nexgent 的 v1 格式，见 `docs/spec/data-formats.md` |
| `session/session-format-catalog`、`session-format-v0-to-v1` … `v3-to-v4` | — | 不要 | — | 不做历史迁移 |
| `session/session-projection-cache`、`session-stats`、`session-turn-outline`、`session-telemetry`、`session-telemetry-otel`、`session-log-deepseek` | — | 不要 | — | |
| `session/session-title`、`session-title-llm`、`session-title-*-prompt-llm` | — | 不要 | — | 步骤 2 若需要会话标题，再从此改写并更新本表 |
| `credentials/credentials`、`credentials/credentials-local` | `@nexgent/kernel` | 重写 | 1 | 本机凭证文件读取只参考设计；`NEXGENT_API_KEY` 优先 |
| `credentials/authorization`、`credentials/deepseek-account`、`credentials/deepseek-account-platform` | — | 不要 | — | 账户体系不在范围 |
| `storage/storage`、`storage/storage-domain`、`storage/storage-json` | `@nexgent/kernel` | 改写 | 1 | 已复制 `storage-json/src/atomic.ts`（并入 `util/atomic-write.ts`）、`storage-json/src/index.ts`（→ `storage/json-file.ts`）；`storage`、`storage-domain` 未复制 |
| `storage/storage-sqlite` | — | 不要 | — | 步骤 1 无 SQLite 需求；步骤 5 `session-query-sqlite` 再议 |
| `workspace/workspace` | `@nexgent/workspace` | 重写 | 1 | 工作目录与 `.nexgent/` 数据目录，只参考设计；步骤 2 的项目模型建于此 |
| `fs/fs`、`fs/fs-local` | `@nexgent/workspace` | 重写 | 1 | 文件读写抽象；步骤 1 未复制文件 |
| `fs/fs-sandbox`、`fs/fs-observation-policy` | `@nexgent/workspace` | 改写 | 1 | 已复制 `fs-sandbox/src/containment.ts`（→ `paths.ts`）：路径白名单与写入限制；`fs-observation-policy` 未复制 |
| `fs/tool-fs`、`fs/tool-fs-search`、`fs/tool-str-replace-editor` | `@nexgent/workspace` | 重写 | 1 | 读写、搜索、`str_replace` 工具，只参考设计 |
| `shell/shell`、`shell/shell-env` | `@nexgent/workspace` | 重写 | 1 | 只参考设计 |
| `shell/bash-local`、`shell/bash-sandbox`、`shell/tool-bash` | `@nexgent/workspace` | 重写 | 1 | Linux / macOS；只参考 `tool-bash` 的设计 |
| `shell/pwsh-local`、`shell/pwsh-sandbox`、`shell/tool-pwsh` | `@nexgent/workspace` | 重写 | 1 | Windows；只参考 `tool-pwsh` 的设计 |
| `shell/tool-bash-persistent`、`shell/tool-pwsh-persistent` | — | 不要 | — | 持久 shell 会话暂不做 |
| `subprocess/subprocess`、`subprocess/subprocess-local`、`subprocess/win32-process` | `@nexgent/workspace` | 改写 | 1 | 已复制 `subprocess-local/src/spawn.ts`（→ `process.ts`）：子进程与进程组 / `taskkill` 终止；`win32-process` 的 Job Object 未复制（后补） |
| `sandbox/sandbox`、`sandbox/sandbox-policy`、`sandbox/sandbox-local` | `@nexgent/workspace` | 重写 | 1 | 路径与命令策略，两平台先用这一层；只参考 `sandbox-policy` 的设计 |
| `sandbox/sandbox-windows-acl` | `@nexgent/workspace` | 改写 | 1（可选） | 先路径策略，ACL 后补（ADR 0001 决策 2）；PR #4 修过其错误路径 |
| `util/atomic-write`、`util/timeout`、`util/workspace-path`、`util/home-paths`、`util/output-retention`、`util/launch-environment`、`util/native-command`、`util/values`、`util/deque`、`util/chunked-list`、`util/crypto`、`util/time` | 各使用包内部 | 改写 | 1 | 按需复制到使用它的包内，不单独成包；步骤 1 已复制 `atomic-write/src/index.ts`、`timeout/src/index.ts`（→ `@nexgent/kernel` `util/`），其余未复制 |
| `util/http-proxy` | `@nexgent/llm` | 改写 | 1 | 已复制 `src/policy.ts`（→ `proxy/policy.ts`）；`install.ts` 的 undici dispatcher 换成自写隧道 `proxy/transport.ts` |
| `util/brand`、`util/lazy-require`、`util/package-manifest` | — | 不要 | — | |
| `test-support/agent-loop-testkit`、`test-support/llm-replay`、`test-support/llm-mock-server` | `packages/test-support` | 重写 | 1 | 只参考脚本化 provider 的设计（另参考 `session-snapshot/src/launcher.ts` 的 spawn / wait / kill）；Nexgent 自写仿真规范与故障注入，无复制件 |
| `test-support/session-snapshot`、`test-support/loader-smoke`、`test-support/remote-mock`、`test-support/client-runtime` | — | 不要 | — | 不复制 snapshot 测试体系 |

**步骤 1 复制件登记（按 Nexgent 包）。** 与各文件首行的 `Adapted from` 头和 [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) 一致；未列出的参考只用于设计，代码为 Nexgent 自写。

| Nexgent 包 | 复制并改写（Nexgent 文件 ← DSH 文件） | 只参考设计 |
| --- | --- | --- |
| `@nexgent/kernel` | `src/util/atomic-write.ts` ← `util/atomic-write/src/index.ts` + `storage/storage-json/src/atomic.ts`；`src/util/timeout.ts` ← `util/timeout/src/index.ts`；`src/storage/json-file.ts` ← `storage/storage-json/src/index.ts`；`src/profile.ts` ← `boot/app-boot/src/profile.ts` + `profile-plugins.ts`；`src/app.ts` ← `boot/app-boot/src/index.ts`；`src/agents.ts` ← `core/agent/src/index.ts` + `core/agent-default-model/src/index.ts`；`src/tools.ts` ← `core/tools/src`（作用域注册表）+ `core/scope/src/index.ts` | `core/agent-loop`、`core/system-prompt`、`credentials/credentials`、`credentials/credentials-local`、`guard/timeout-policy` |
| `@nexgent/llm` | `src/proxy/policy.ts` ← `util/http-proxy/src/policy.ts` | `llm/llm`、`llm/llm-pi-ai`、`llm/token-meter` |
| `@nexgent/session` | （无） | `session/session-persistence-jsonl`（`src/storage.ts`、`src/lease.ts`）、`session/session-checkpoint-policy`、`session/session-projection`、`session/session-format` |
| `@nexgent/workspace` | `src/paths.ts` ← `fs/fs-sandbox/src/containment.ts`；`src/process.ts` ← `subprocess/subprocess-local/src/spawn.ts` | `workspace/workspace`、`fs/tool-fs`、`fs/tool-fs-search`、`fs/tool-str-replace-editor`、`shell/shell-env`、`shell/tool-bash`、`shell/tool-pwsh`、`sandbox/sandbox-policy` |
| `packages/test-support` | （无） | `test-support/agent-loop-testkit`、`test-support/llm-replay`、`test-support/llm-mock-server`、`test-support/session-snapshot/src/launcher.ts` |
| `apps/cli` | `src/json-lines.ts` ← `bundle/headless/src/json-stream.ts` | `boot/cmdline`、`bundle/headless`（入口形态）、`bundle/base`、`apps/cli/src/process-shutdown.ts`（→ 自写 `signals.ts`）。`bin/nexgent.ps1` 移植自 PR #4 的 `run.ps1`（Nexgent 自己的代码，见下文“来源为 PR #4 的移植文件”），不是 DSH 代码 |

上表的 DSH 路径省略 `packages/` 前缀（`apps/cli/src/process-shutdown.ts` 除外）。

### 步骤 2：日常任务体验

| DSH 包组 / 具体包 | Nexgent 包 | 处理 | 归属步骤 | 备注 |
| --- | --- | --- | --- | --- |
| `context/file-reference`、`context/file-reference-local` | `@nexgent/context` | 改写 | 2 | 资料以文件引用注入对话 |
| `context/agent-instructions` | `@nexgent/context` | 改写 | 2 | 工作区说明文件注入 |
| `context/session-reference`、`context/time-context`、`context/tmux-context` | — | 不要 | — | |
| `compaction/compaction`、`compaction/compaction-basic` | `@nexgent/context` | 改写 | 2 | 只做基本摘要 |
| `compaction/command-compact`、`compaction-image-offload`、`compaction-tool-result-pruner` | — | 不要 | — | |
| `deliverables/tool-present`、`deliverables/workspace-changes` | `@nexgent/tasking` | 改写 | 2 | `present` 工具与每轮文件变更；`outputs/` 快照为 Nexgent 新增 |
| `feedback/message-feedback`、`feedback/command-feedback` | `@nexgent/tasking` | 改写 | 2、5 | 评分与评语关联成果版本，是步骤 5 的输入 |
| `goal/goal`、`goal/goal-round-driver`、`goal/tool-goal`、`goal/command-goal` | `@nexgent/tasking` | 改写 | 2 | 跨重启的持久目标 |
| `jobs/jobs`、`jobs/jobs-local`、`jobs/tool-jobs` | `@nexgent/tasking` | 改写 | 2、5 | 后台作业；步骤 5 的改进作业跑在其上 |
| `skill/skill`、`skill/tool-skill` | `@nexgent/skill` | 改写 | 2 | 技能说明注入 |
| `skill/skill-office` | `@nexgent/skill` | 改写 | 2 | Office 文件用技能说明 + 工具读取 |
| `skill/skill-badge`、`skill/tool-workspace-dependencies` | — | 不要 | — | |
| `attachment/attachment`、`attachment/attachment-local` | — | 不要 | — | 只支持图片，不作资料流程的参考（计划 4.2） |
| `interaction/user-approval`、`interaction/permission-presets` | `@nexgent/kernel` | 改写 | 2 | 工具审批；CLI 与桌面应用共用一套交互（`docs/spec/permissions.md`） |
| `interaction/tool-ask-user`、`interaction/user-questions`、`interaction/commands` | `@nexgent/tasking` | 改写 | 2 | 向用户提问与 `/` 命令 |
| `hooks/hook-protocol` | `@nexgent/kernel` | 改写 | 2（按需） | 只在步骤 2 需要钩子时改写 |
| `hooks/hooks-claude-code`、`hooks/hooks-codex` | — | 不要 | — | |
| `sdk/protocol`、`sdk/server`、`sdk/client` | `@nexgent/sdk` | 重写 | 2 | 进程内 TS API + Electron IPC；不复制远程协议；Python 客户端延后 |
| `apps/desktop`、`apps/desktop-host` | `apps/desktop` | 重写 | 2 | Electron 外壳（窗口、打包、更新）只参考结构；Codex 式三栏布局 |
| `client/ui-chat`、`ui-conversation`、`ui-approval`、`ui-deliverables`、`ui-sidebar`、`ui-workspace`、`ui-settings-models` | `apps/desktop` | 重写 | 2 | 只参考交互与组件划分；不复制 remote 协议耦合代码 |
| `client/` 其余 `ui-*`（`ui-goal`、`ui-jobs`、`ui-skill`、`ui-subagent`、`ui-workflow-run`、`ui-message-feedback` 等） | `apps/desktop` | 重写 | 2–3（按需） | 对应功能接入桌面应用时再参考 |

### 步骤 3：迁移与协作

| DSH 包组 / 具体包 | Nexgent 包 | 处理 | 归属步骤 | 备注 |
| --- | --- | --- | --- | --- |
| `subagent/subagent`、`subagent-spawn-in-process`、`subagent-fork-in-process`、`subagent-in-process-driver` | `@nexgent/subagent` | 改写 | 3 | 只要 fresh / fork 两种 |
| `subagent/tool-subagent`、`subagent/tool-subagent-control` | `@nexgent/subagent` | 改写 | 3 | 委派形态的工具 |
| `subagent/subagent-claude-code`、`subagent-codex`、`subagent-acp`、`subagent-dsh-sdk` | — | 不要 | — | 外部 provider |
| `experimental/agent-team`、`experimental/agent-team-profile` | `@nexgent/team` | 改写 | 3 | Lead + 具名队友 + 持久邮箱 + 任务板；去掉 experimental 兼容层，持久化语义用 Nexgent 测试固定 |
| `experimental/tool-agent-team` | `@nexgent/team` | 改写 | 3 | 九个团队工具 |
| `experimental/client-ui-agent-team` | `apps/desktop` | 重写 | 3 | |
| `workflow/workflow` | `@nexgent/workflow` | 改写 | 3 | 脚本工作流 `agent() / parallel() / pipeline()` |
| `workflow/workflow-ptc`、`workflow/tool-workflow` | `@nexgent/workflow` | 改写 | 3 | PR #4 的 `architecture.ts`、`architecture-store.ts`、persona / toolFilter 透传并入 |
| `workflow/tool-ralph` | — | 不要 | — | |
| `ptc-runtime/ptc-runtime`、`ptc-runtime/ptc-runtime-node` | `@nexgent/ptc` | 改写 | 3 | 模型写程序调用宿主函数；Node 后端 |
| `experimental/ptc-runtime-python` | — | 不要 | — | 需要 CPython 时再参考 |
| `preset/agent-preset`、`preset/persona` | `@nexgent/preset` | 改写 | 3 | 预设与人设；组织角色、团队模板（JSON）迁入 |
| `preset/agent-preset-registry` | `@nexgent/preset` | 改写 | 3、4 | 步骤 4 的能力版本把预设注入 profile |
| `skill/skill-filesystem` | `@nexgent/skill` | 改写 | 3 | SKILL.md 目录发现，替代 Python 技能编译器 |
| `mcp/mcp-client`、`mcp/mcp-resources` | `@nexgent/mcp` | 改写 | 3（按需） | 只在有真实需求时实现 |
| `web/web`、`web/tool-web`、`web/web-fetch-http` | `@nexgent/web` | 改写 | 3 | 公开网页读取，替代 Python 实现 |
| `web/web-search-deepseek`、`web-search-exa`、`web-search-perplexity` | — | 不要 | — | 搜索 provider 需要时作为配置项 |

### 步骤 4：能力版本

| DSH 包组 / 具体包 | Nexgent 包 | 处理 | 归属步骤 | 备注 |
| --- | --- | --- | --- | --- |
| `boot/plugin-manager` | `@nexgent/capabilities` | 重写 | 4 | 只参考 Creator 模式安装 bundle、逐次审批的语义；插件包每次人审批 |
| `settings/settings` | `@nexgent/kernel` | 改写 | 4 | profile patch 的持久化 |
| `skill/skill-filesystem`、`preset/agent-preset-registry` | `@nexgent/capabilities` | （见步骤 3） | 4 | 能力版本的加载路径 |
| （无 DSH 对应） | `@nexgent/capabilities` | 新写 | 4 | `CapabilityBundle`、激活存储、`capability_trial`、账本扩展；PR #4 的 `architecture-activation.ts`、`execution-ledger.ts`、`architecture-trials.ts` 执行框架移植 |

### 步骤 5：反馈改进

| DSH 包组 / 具体包 | Nexgent 包 | 处理 | 归属步骤 | 备注 |
| --- | --- | --- | --- | --- |
| `session-query/session-query`、`session-query/tool-session-query` | `@nexgent/evolve` | 改写 | 5 | 诊断会话读取历史会话 |
| `session-query/session-query-sqlite`、`session-query/session-log-export` | `@nexgent/evolve` | 重写 | 5（按需） | 索引与导出按 Nexgent 的 JSONL v1 自写 |
| `experimental/auto-review` | `@nexgent/evolve` | 重写 | 5 | 只参考单任务自动复核的诊断提示 |

### 不要（按组）

以下包组不进入 Nexgent；需要时再从参考库改写并更新本表。

| DSH 包组 | 处理 | 备注 |
| --- | --- | --- |
| `api/*`（gateway、各 controller、remotes、workspace-files） | 不要 | 不做浏览器访问的 Web 服务 |
| `host/*`（webserver、frontend-static、directory-picker-*、open-in-app、plugin-inventory、product-telemetry-otel） | 不要 | 同上；目录选择由 Electron 原生对话框提供 |
| `bundle/web-app`、`apps/web`、`client/web`，以及 `client/` 中的浏览器托管部分（`connection`、`store`、`modules`、`resources`、`hmr`、`locale`、`file-upload`、`ui-brand-official`、`ui-settings-account` 等） | 不要 | 桌面应用自有渲染进程与 IPC |
| `acp/*`、`bundle/acp-app`、`subagent/subagent-acp` | 不要 | |
| `computer-use/*`、`experimental/computer-use-*` | 不要 | |
| `browser-use/*`、`experimental/browser-use-*` | 不要 | |
| `experimental/speech-to-text*`、`api-speech-to-text`、`client-ui-voice-input`、`voice-input-bundle` | 不要 | 语音 |
| `credentials/deepseek-account*`、`identity/anonymous-user-id` | 不要 | |
| `host/product-telemetry-otel`、`session/session-telemetry*` | 不要 | 遥测 |
| `lsp/*`、`ssh/*`、`terminal/*`、`context/tmux-context`、`client/ui-sidebar-terminal` | 不要 | |
| `spill/*`、`webhook/*`、`document/*`、`typert/*` | 不要 | |
| `test-support/*`（DSH 自己的） | 不要 | Nexgent 自写 `packages/test-support` |
| `website/`、`snapshots/`、`.agents/`、`*.i18n.yaml` 与 `*.zh.md` 文档 | 不要 | |
| `subagent/subagent-claude-code`、`subagent-codex`、`hooks/hooks-claude-code`、`hooks/hooks-codex` | 不要 | Claude Code / Codex provider |
| `experimental/inspector`、`webworker-*`、`extensions/*`、`guard/*`、`plan/*`、`todo/*`、`schedule/*`、`runtime-diagnostics/*`、`native/`、`python/`、`patches/` | 不要 | 计划未提及，默认不要；`guard/timeout-policy` 在步骤 1 做超时边界时作过设计参考（`@nexgent/kernel`），未复制 |

### 来源为 PR #4 的移植文件

这些文件是 Nexgent 在 PR #4 分支（`refactor/dsh-application`）上自己写的，不是 DSH 代码，按计划 4.8 直接移植，不需要 `Adapted from` 头：

| PR #4 文件 | Nexgent 包 | 归属步骤 |
| --- | --- | --- |
| `cordis.patch.yml` 的产品默认值 | `@nexgent/kernel` | 1 |
| `execution-ledger.ts` | `@nexgent/llm`（请求记录）、`@nexgent/capabilities`（扩展字段） | 1、4 |
| `architecture-activation.ts` | `@nexgent/capabilities` | 4 |
| `architecture.ts`、`architecture-store.ts`、`tool-restriction.ts`、persona / toolFilter 透传 | `@nexgent/workflow`、`@nexgent/kernel` | 3 |
| `architecture-trials.ts` 的成对执行框架 | `@nexgent/capabilities` | 4（比较规则替换） |
| `run.ps1` 的参数设计 | `apps/cli/bin/nexgent.ps1` | 1 |
| 13 个验收脚本的流程设计 | `scripts/accept-step*.mjs` | 1–4 |

## 参考库的获取

参考库以 git submodule 登记在 `reference/deepseek-harness`，固定上述提交，只读、不参与构建。子模块登记时**没有**设 `shallow`，以保证固定的是精确提交；日常对照阅读只需要一个浅检出，按下面的步骤获取：

```sh
git submodule init reference/deepseek-harness
git -C reference/deepseek-harness init 2>/dev/null || true
git clone --no-checkout --filter=blob:none https://github.com/deepseek-ai/deepseek-harness.git reference/deepseek-harness
git -C reference/deepseek-harness checkout 46a7f68b0922371ce7144b668b90e377d8e799f4
```

`--filter=blob:none` 只在读取文件时按需拉取内容；不需要完整历史时不要 `git submodule update --init`（它会拉全量仓库）。不要在 `reference/` 下改动任何文件，也不要把它加入 pnpm workspace。

## 复制文件的规则

从参考库复制并改写的每个文件：

1. 文件第一行写明来源：`// Adapted from deepseek-harness@46a7f68b <path>`，`<path>` 是参考库内相对路径（如 `packages/core/agent-loop/src/loop.ts`）；非 `//` 注释语法的文件（YAML、Markdown）用该格式的注释写同一句。
2. 在根目录 [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) 的“改写文件清单”登记：Nexgent 路径、来源路径。
3. 在本表对应行的“处理”列保持为“改写”；若一个包全部由 Nexgent 自写、不含任何复制件，改为“重写”。
4. 只复制当前步骤需要的部分；复制的测试同样加头并登记。
