# Nexgent

Nexgent 是一个通用的任务智能体应用，有桌面应用（Electron）和命令行两种用法。你打开一个项目文件夹，交给它资料，用平常的话说想要什么，它在文件夹里读、写、跑命令，把成果交回来；不满意就接着说，它接着改。

模型走 Claude Platform（Anthropic Messages API），默认 `claude-sonnet-5-5`，开启 thinking。运行架构用 [Cordis](https://www.npmjs.com/package/@deepseek-ai/cordis)；[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 只作只读参考，以子模块固定在 `reference/deepseek-harness`，不参与构建。

## 它能做什么

- **项目、对话、资料、成果。** 每个项目有自己的对话列表；加进来的资料是副本，原文件不动；成果带版本，可以看两版之间的差异、针对某一版提修改。
- **随时插话。** 它在干活时输入框不锁，你的话下一步就生效，也会转给正在干活的成员。压缩上下文时你说过的原话逐字保留，长任务里开头定的约定不会丢。
- **自己组队。** 小任务自己做；大一点的任务由它决定分工（规划、调查、实现、测试、审查），能并行的并行，卡住了换一种分工。
- **记住好的分工。** 同类任务上哪种分工更顺利、花多少钱都记下来，下次直接从效果好的开始，并始终留一小部分单独做作对照。
- **项目规则。** 你说过“以后都要这样”的话会记成项目规则，每次任务都遵守；规则和现有代码或测试冲突时，它先问你以哪个为准。
- **自己检查。** 每轮做完会跑测试、你设的检查命令，并确认交付的文件能打开；没通过就在同一轮里接着改。
- **停止、撤回、恢复。** 可以随时停止；可以把某条消息之后的文件改动撤回；应用或进程被强杀后，重开就能接着聊。
- **安全与费用。** 命令在系统沙箱里跑（Linux 与 macOS；macOS 还没实测，Windows 没有系统沙箱），写项目外的文件或敏感文件要你批准；每个任务、每段对话、整个项目都可以设费用上限。

各项都有脚本化模型（不调用真实模型）的自动测试。插话、组队、分工复用这些新机制只在 macOS 上用真实模型小规模试过，效果还需要更多真实任务来确认。

## 快速开始

需要 Node.js 22.12 或更新、pnpm 10.28.0；Windows 还需要 PowerShell 7（`pwsh`）。

```sh
git clone https://github.com/csxq0605/nexgent.git
cd nexgent
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @nexgent/desktop build      # 构建桌面界面

export NEXGENT_API_KEY=<key>               # 也可以在桌面应用的设置页填写
pnpm --filter @nexgent/desktop start       # 桌面应用

node apps/cli/bin/nexgent.mjs run --project <dir> --task "..."   # 命令行
```

完整的安装、打包、桌面应用与命令行用法见 [使用说明](docs/usage.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [使用说明](docs/usage.md) | 安装、桌面应用怎么用、命令行、数据放在哪、常见问题 |
| [设计理念](docs/design.md) | Nexgent 想做成什么样，以及插话与记忆、组队、分工复用、项目规则、经验这些机制怎么工作 |
| [设计决定](docs/decisions.md) | 仍然有效的设计决定，每条一两句话 |
| [数据格式](docs/spec/data-formats.md) | 用户数据目录、会话 JSONL、账本、组织库、经验手册等文件格式 |
| [权限](docs/spec/permissions.md) | 沙箱、命令策略、审批、费用上限、密钥、本地 IPC |
| [内核钩子](docs/spec/agent-hooks.md) | 一轮对话里各步骤的顺序与扩展点 |

各包的说明在 `packages/*/README.md`、`apps/*/README.md`。

## 仓库结构

```text
apps/cli          nexgent 命令
apps/desktop      桌面应用（Electron 主进程 + React 界面）
packages/kernel   一轮对话的循环、工具、契约（字段名以 src/contracts/ 为准）
packages/llm      模型接入（Anthropic Messages API）
packages/session  会话记录、账本、恢复
packages/workspace  工作区、沙箱、命令执行
packages/context  上下文、资料引用、压缩
packages/tasking  资料、成果、反馈、目标
packages/subagent | team | workflow | ptc   委派、团队、分工与工作流、代码执行
packages/capabilities | evolve   经验手册、项目规则、组织库；以及已关闭的旧改进机制
packages/sdk      进程内接口，桌面应用与命令行共用
packages/skill | preset | tool-spreadsheet | web   技能、预设、表格与网页工具
packages/test-support  测试与验收用的脚本化模型和工具
scripts/          验收与测量脚本
reference/        DeepSeek Harness 只读参考（子模块）
```

## 开发

```sh
pnpm build    # tsc -b，并对测试做类型检查
pnpm test     # vitest，用脚本化模型，不需要密钥
```

CI 只手动触发：`.github/workflows/nexgent.yml`（Linux 与 Windows 上 build、test）和 `windows-accept.yml`（Windows 上的桌面测试）。

## 旧版本

更早的开发历史（含 Python / PyQt 旧产品的归档分支 `archive/harness-gui`、`archive/python-host`）保留在 [csxq0605/Nexgent-archive](https://github.com/csxq0605/Nexgent-archive)。

## License

[MIT](LICENSE)
