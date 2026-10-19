<div align="center">

![Nexgent](assets/brand/title.svg)

### One project. A team that learns.

**在你的项目文件夹里干活、自己组队、记住什么做法有效的桌面智能体**

[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](#)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.12-green.svg)](https://nodejs.org/)
[![Built with Electron](https://img.shields.io/badge/built%20with-Electron-blue.svg)](https://www.electronjs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) | 中文

</div>

## 理念

Nexgent 的出发点是：**改进应该发生在你手上正在做的事情里，而不是在离线的实验室里。**

你打开一个项目文件夹，交给它资料，用平常的话说想要什么。它在文件夹里读、写、跑命令，把成果交回来。它干活时你可以随时插话；它记得你说过的话，自己判断这件事要不要组队，并记下同类任务上哪种做法更顺利，下一次直接从那里开始。

> **One project. A team that learns.**

---

## 设计原则

1. **用户的话优先**  
   随时可以插话，下一次模型请求就带上，正在干活的成员也会收到。压缩上下文时你说过的原话逐字保留，长任务里开头定的约定不会丢。你说过“以后都要这样”的项目规则，每次任务都给。

2. **由智能体组织工作**  
   小任务自己做；大一点的任务用一个 `organize` 工具声明分工：1–6 个角色（规划、调查、实现、测试、审查），能并行的并行，每个成员在自己的工作副本里干活。没有进展时换一种分工，并写明原因。

3. **看结局，不看自夸**  
   算数的是确定性检查、你的纠正与返工、外部评审和花费，同一个模型不给自己打分。始终留一部分任务单独做，作为对照。

4. **通用，不为某类任务特化**  
   不为让某类任务通过而写规则、提示或默认值；案例只用来测量。

5. **可恢复、安全**  
   会话是只追加的记录：可以停止、撤回文件改动，进程被强杀后接着聊。命令在系统沙箱里跑，写项目外的文件要你批准，花费有美元上限。

完整定位见 [`docs/PROJECT_POSITIONING.md`](docs/PROJECT_POSITIONING.md) 与 [`AGENTS.md`](AGENTS.md)。

---

## 系统形态

![Nexgent architecture](assets/diagrams/architecture.svg)

```text
桌面应用（Electron + React）          命令行
              │                        │
              └────── 进程内 SDK ───────┘
                          │
                          ▼
   内核循环：收进插话 → 模型请求 → 工具 → 交付成果 → 完成检查
        │                 │                      │
      上下文            组织者                  工作区
 规则 · 经验 · 资料   单独做 / organize      系统沙箱 · 审批
   用户原话           成员：委派 · 团队 · 工作流   费用上限
                          │
                          ▼
   会话存储（JSONL、账本、快照）           结局记忆
                                     （经验手册、组织库）
                          │
                          └──── 用到下一轮
```

---

## 仓库内容

| 路径 | 内容 |
|---|---|
| `apps/desktop/` | Electron 主进程与 React 界面 |
| `apps/cli/` | `nexgent` 命令 |
| `packages/kernel/` | 一轮对话的循环、工具、契约（字段名以 `src/contracts/` 为准） |
| `packages/llm/` | Claude Platform 接入（Anthropic Messages API） |
| `packages/session/` | 会话记录、账本、恢复 |
| `packages/workspace/` | 工作区、系统沙箱、命令策略 |
| `packages/context/` | 上下文、资料引用、压缩 |
| `packages/tasking/` | 资料、成果、反馈、目标 |
| `packages/subagent/`、`team/`、`workflow/`、`ptc/` | 委派、团队、`organize` 与工作流、代码执行 |
| `packages/capabilities/`、`evolve/` | 经验手册、项目规则、组织库；以及已关闭的旧改进机制 |
| `packages/sdk/` | 桌面应用与命令行共用的进程内接口 |
| `packages/skill/`、`preset/`、`tool-spreadsheet/`、`web/` | 技能、预设、表格与网页工具 |
| `packages/test-support/`、`scripts/` | 脚本化模型、验收与测量脚本 |
| `reference/deepseek-harness/` | 只读参考（子模块，不参与构建） |
| `docs/` | 定位、操作、配置、规范（[索引](docs/README.md)） |

---

## 能做什么

- **项目、对话、资料、成果** —— 资料是副本，原文件不动；成果带版本，可看差异、针对某一版提修改
- **干活时随时插话** —— 下一步就生效，正在跑的成员也收到
- **自己组队** —— 按角色分工、并行，卡住时改组
- **记住好的分工** —— 按任务类别和单独做比较，能力页上一句话说明
- **项目规则与经验** —— 规则每次都给，与现有测试或代码冲突时先问你；经验靠随机给与不给的对照决定留不留
- **自己检查** —— 测试、你设的检查命令、交付的文件要能打开；没过就在同一轮里接着改
- **停止、撤回、恢复** —— 以及审批、沙箱和费用上限

每一项都有脚本化模型的自动测试。插话、组队、分工复用这些新机制只在 macOS 上用真实模型小规模试过，效果还要更多日常任务来确认。

<p align="center"><img src="assets/screenshots/steer.png" width="720" alt="运行中插话"></p>

---

## 快速开始

需要 Node.js 22.12+、pnpm 10.28.0、一个 Anthropic API 密钥；Windows 还需要 PowerShell 7。

```bash
git clone https://github.com/csxq0605/nexgent.git
cd nexgent
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @nexgent/desktop build

export NEXGENT_API_KEY=<key>          # 也可以在设置页填写
pnpm --filter @nexgent/desktop start
```

命令行：

```bash
node apps/cli/bin/nexgent.mjs run --project <dir> --task "..."
```

从源码运行与打包见 [本地运行](docs/RUN_LOCAL.md)，日常使用见 [操作手册](docs/OPERATION_MANUAL.md)。

---

## 文档

| 用途 | 文档 |
|---|---|
| 操作手册 | [docs/OPERATION_MANUAL.md](docs/OPERATION_MANUAL.md) |
| 本地运行与打包 | [docs/RUN_LOCAL.md](docs/RUN_LOCAL.md) |
| 配置 | [docs/CONFIGURATION.md](docs/CONFIGURATION.md) |
| 产品与设计定位 | [docs/PROJECT_POSITIONING.md](docs/PROJECT_POSITIONING.md) |
| 设计决定 | [docs/architecture/DESIGN_DECISIONS.md](docs/architecture/DESIGN_DECISIONS.md) |
| 仓库约定（开发 / 智能体） | [AGENTS.md](AGENTS.md) |
| 文档索引 | [docs/README.md](docs/README.md) |

更早的开发历史（含已归档的 Python 旧产品）在 [csxq0605/Nexgent-archive](https://github.com/csxq0605/Nexgent-archive)。

---

## License

MIT，见 [LICENSE](LICENSE)。
