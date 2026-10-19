# 配置

Nexgent 的配置分三层：

1. **进程环境** —— 环境变量：密钥、数据目录、日志级别、开发与测试用的替换项。
2. **用户级** —— 用户数据目录里的文件：本机密钥、所有项目共用的分工记录和经验，以及外观、语言这类对所有项目生效的设置。
3. **项目级** —— 项目文件夹里的 `.nexgent/config.json`：模型、权限、检查、费用、学习。桌面应用的设置页改的就是它。

密钥只放在环境变量或用户数据目录的 `credentials.json` 里，绝不写进项目文件夹、仓库、日志或测试夹具。

---

## 1. 模型密钥

按顺序读：

1. 环境变量 `NEXGENT_API_KEY`；
2. 环境变量 `ANTHROPIC_API_KEY`；
3. `<NEXGENT_HOME>/credentials.json`：桌面应用 设置 → 高级 → 模型 API 密钥 写入这里，权限 0600，权限更宽的文件会被拒绝。保存后界面不再显示密钥。

```bash
export NEXGENT_API_KEY=<key>
```

---

## 2. 环境变量

| 变量 | 作用 |
|---|---|
| `NEXGENT_API_KEY` | 模型密钥（首选） |
| `ANTHROPIC_API_KEY` | `NEXGENT_API_KEY` 未设置时的回退 |
| `NEXGENT_HOME` | 用户数据目录，默认 `~/.nexgent`（Windows 为 `%USERPROFILE%\.nexgent`） |
| `NEXGENT_API_BASE_URL` | 替换模型端点（默认 `https://api.anthropic.com`），测试用它指向脚本化模型服务 |
| `NEXGENT_LOG_LEVEL` | 桌面日志级别：`debug` / `info`（默认）/ `warn` / `error` |
| `NEXGENT_COMPACTION_THRESHOLD` | 触发上下文压缩的估计输入 token 数，默认 160000 |
| `NEXGENT_AUTO_TITLE` | 设为 `0` 时，对话在第一轮后不自动起名 |
| `NEXGENT_DEBUG` | 设为 `1` 时命令行出错打印调用栈 |
| `NEXGENT_DESKTOP_DIR`、`NEXGENT_ELECTRON` | `nexgent app` 用哪个桌面应用目录和 Electron |

只在开发构建里生效、打包后被忽略的变量（`NEXGENT_DESKTOP_DEV_URL`、`NEXGENT_DESKTOP_RENDERER_DIR`、`NEXGENT_DESKTOP_SDK_MODULE`）见 [apps/desktop/README.md](../apps/desktop/README.md)。

---

## 3. 用户数据目录

`<NEXGENT_HOME>`（默认 `~/.nexgent`）：

| 位置 | 内容 |
|---|---|
| `projects/<id>/` | 每个项目的对话记录、账本、快照、资料副本、成果、学到的经验和“本项目总是允许”的授权，不放在项目文件夹里 |
| `organizations/runs.jsonl` | 所有项目共用的分工记录（只追加） |
| `credentials.json` | 设置页保存的密钥 |
| `logs/desktop-YYYY-MM-DD.log` | 桌面应用日志，保留 14 天 |

项目文件夹里只有 `.nexgent/` 下的项目标识和 `config.json`，可以和同事共享，不含授权和密钥。

格式细节见 [数据格式](spec/data-formats.md)。

---

## 4. 项目配置 `.nexgent/config.json`

每个字段都有默认值，文件不存在等于 `{}`。设置页里的改动直接写进这个文件。

| 字段 | 默认 | 设置页 | 说明 |
|---|---|---|---|
| `model` | `claude-sonnet-5-5` | 模型 | 执行任务用的模型 |
| `endpoint` | `https://api.anthropic.com` | — | 模型端点，不带路径和凭证 |
| `thinking` | `on` | 先思考再回答 | `off` 时用该模型最低的 thinking 设置 |
| `effort` | `medium` | 思考深度 | 想得越深越慢、越贵 |
| `sandboxMode` | `workspace-write` | 文件权限 | `read-only` / `workspace-write` / `full-access` |
| `checkRetries` | 2 | 没通过时自动再改 | 0–5，0 为不自动改 |
| `checkCommands` | 无 | 检查命令 | 每轮改过文件后依次运行，最多 5 条，每条最多 500 字符 |
| `costCaps` | 无 | 费用 | `perTask`、`perConversation`、`perProject`，各可设 `maxUsd`、`maxTokens`、`maxRequests`；`perProject` 另有 `windowDays`（默认 30） |
| `learning` | 开，30 天 3 美元 | 自动改进 | 后台自评与总结经验的开关和预算；`useShared`、`contribute` 控制经验是否跨项目共用 |
| `approvals` | `[]` | — | “本项目内允许”保存的授权规则 |
| `extraReadRoots` | `[]` | — | 项目外允许读取的目录 |
| `extraWriteRoots` | `[]` | — | 项目外允许写入的目录 |
| `maxStepsPerTurn` | 400 | — | 一轮最多调用模型几次，到了就停下，说一句“继续”接着做 |
| `commands.systemSandbox` | `auto` | — | `auto`：平台有系统沙箱就用；`required`：没有就不执行命令；`off`：不进系统沙箱 |
| `commands.network` | `true` | — | 命令能否联网，有系统沙箱的平台上由沙箱执行 |

权限、费用、学习和检查一类的字段，模型自己改总要你批准。字段名以 `packages/kernel/src/contracts/config.ts` 为准，规则见 [权限](spec/permissions.md)。

`autoImprove`、`improvement`、`capabilities`（以及 `learning.skills`）属于已关闭的旧改进机制，保留只为读得懂旧项目，平时不用设。

---

## 5. 用户级设置

设置页“通用”分组对所有项目生效：

- **外观**：跟随系统、浅色、深色，存在本机。
- **语言**：Nexgent 写给你的经验和说明用哪种语言，默认跟每个任务一致。界面目前只有中文。
