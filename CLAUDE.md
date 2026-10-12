# CLAUDE.md

在本仓库工作的 Claude 先读本文件。细节以下文指向的文档为准；本文件与它们冲突时，以文档为准并修正本文件。

## Nexgent 是什么

Nexgent 正在被重写为一个 TypeScript 独立应用（Electron 桌面应用 + CLI）：能在真实项目里完成任务、持续积累能力并改进自身。运行架构用 Cordis（npm 上的 `@deepseek-ai/cordis` 等库），DeepSeek Harness（DSH）只作只读参考，固定在子模块 `reference/deepseek-harness`（提交 `46a7f68b`），不参与构建、不作运行时依赖。用户面对的是项目、对话、资料和成果；订单、Excel、科研、OpenFOAM 是应用案例，benchmark 只用于测量。

模型路由是 Claude Platform（Anthropic Messages API，`@anthropic-ai/sdk`），默认 `claude-sonnet-5-5`，执行时默认开 thinking（ADR 0003 取代 ADR 0002 的默认值）、effort `medium`。

旧的 Python 代码已从主干删除（步骤 3 第 1 轮）：Python / PyQt 科研 Coding Harness 在分支 `archive/harness-gui`，Python 宿主与 benchmark 插件在分支 `archive/python-host`（`fd0b2f42`）。主干上不再有 Python 文件，新工作不往主干加 Python。

## 六步计划与当前进度

计划正文：[`docs/research/pr4-review-and-plan-2026-10/README.md`](docs/research/pr4-review-and-plan-2026-10/README.md) 第 4 节（每步的参考实现、工作项、验收；里程碑见 4.7）。

| 步骤 | 内容 | 状态 |
| --- | --- | --- |
| 0 | 横切：仓库骨架、两平台 CI、证据政策、reference 子模块 | 已验收（[`step-0-20261007.md`](docs/validation/step-0-20261007.md)） |
| 1 | 主应用：kernel / llm / session / workspace 重写，CLI 接通 | 已验收（[`step-1-20261011.md`](docs/validation/step-1-20261011.md)：`accept-step1` 两平台通过；真实 Claude Sonnet 5.5 经 `nexgent run` / `resume` 完成两轮多文件代码任务，独立检查通过） |
| 2 | 日常任务体验：项目、资料、成果（`present`）、反馈修改、停止与恢复、上下文压缩、Electron 桌面应用与进程内 SDK | 已验收（[`step-2-20261011.md`](docs/validation/step-2-20261011.md)：Linux 与 Windows 上无界面层 23/23、桌面层 10/10、真实模型层通过） |
| 3 | 迁移已有能力与灵活协作（subagent、team、workflow、ptc），删除 Python | 已验收（[`step-3-20261011.md`](docs/validation/step-3-20261011.md)：无界面层 23/23、桌面层 14/14 在 Linux 与 Windows 通过；真实 Claude Sonnet 5.5 用五种形态完成补货任务，约 0.79 美元） |
| 4 | 能力版本（`CapabilityBundle`）进入真实运行系统，门控采用与回滚 | 验收记录待用户认可（[`step-4-20261012.md`](docs/validation/step-4-20261012.md)：无界面层 19/19、桌面层 18/18 在 Linux 与 Windows 通过；真实 Claude Sonnet 5.5 第 6 次运行 R01–R06 通过，6 次累计约 5.67 美元） |
| 5 | 默认的反馈改进流程（`@nexgent/evolve`） | 未开始 |
| 6 | 递归改进并检验收益，可复现报告 | 未开始 |

步骤 0–1 的代码已合入集成分支 `nexgent-app`（PR #5）。步骤 1 记录里列出的 Windows Job Object、`perProject` 费用上限与 `pause_turn` 续跑已在步骤 2 补上（`packages/workspace/src/windows-job.ts`、`packages/kernel/src/project-config.ts`、`packages/kernel/src/agent.ts`）。

## 工作约定

- **子智能体用 Sonnet、medium effort。** 派出子智能体（Agent 工具等）时指定 Sonnet 模型与 medium effort，除非用户另有指示。
- **不设定时检查。** 不创建定时任务、轮询或周期性回访（cron、`/loop`、定时触发器等）；需要等待外部结果时结束本轮，由事件唤醒。
- **密钥只从环境读取，绝不写入文件。** API 密钥只通过环境变量（`NEXGENT_API_KEY`，回退 `ANTHROPIC_API_KEY`）提供；不写进仓库里的任何文件，包括 `.env`、`.nexgent/`、验收记录、日志、测试夹具与提交信息。文档与示例里用 `<key>` 占位。密钥的产品侧规则见 `docs/spec/permissions.md`“密钥存放”。
- **顺序不颠倒。** 按六步顺序做，先机制后扩展；每步有验收脚本与验收记录。每个包只实现当前步骤需要的部分，边界用测试固定，不追求与 DSH 功能对等。
- **根 README 只描述已验收能力。** 一项能力在 `docs/validation/` 有对应记录之前，只能出现在计划、规范和研究文档里。
- **决策不改旧文。** 要改一项决策就写一份新 ADR 取代旧的，编号递增；研究文档发布后只勘误。
- **规范先于编码。** 文件格式与权限策略以两份规范为准，字段名以 `packages/kernel/src/contracts/` 为准；契约变更走单独的修改并同步规范。
- **从 DSH 改写的文件**加头注 `Adapted from deepseek-harness@46a7f68b <path>`，登记到 `THIRD_PARTY_NOTICES.md`，并更新 `docs/reference-map.md` 对应行。
- **证据卫生。** 未知结果不算成功；脚本化 provider 与真实模型分开记；每份验收记录写明证明什么、不证明什么；原始 JSONL 不进主分支（细则见 `docs/validation/README.md`）。
- **共享根文件**（`package.json`、`pnpm-workspace.yaml`、`tsconfig*.json`、`.github/workflows/`、`.gitignore`）由集成者改；并行分工时各包文件归属固定，子智能体之间不编辑同一文件（见 `docs/plan/`）。

## 常用命令

要求 Node ≥ 22.12、pnpm 10.28.0。

```sh
pnpm install --frozen-lockfile
pnpm build            # tsc -b, then type-checks the tests (tsconfig.tests.json)
pnpm test             # vitest，脚本化 provider，不需要密钥
node scripts/accept-step2.mjs --out accept-step2.json   # 无界面层 + 桌面层，脚本化 provider
node apps/cli/bin/nexgent.mjs run --project <dir> --task "..."   # 真实模型，需 NEXGENT_API_KEY 在环境中
```

CI 只能手动触发（用户 2026-10-11）：`.github/workflows/nexgent.yml` 在 Linux 与 Windows 跑 build、test 与 accept-step2 无界面层；`windows-accept.yml` 在 Windows 跑无界面层、桌面层、desktop 包测试，可选真实模型层。平时在各自会话里本地测试改动的包及其依赖方。

## 文档在哪

| 内容 | 位置 |
| --- | --- |
| 文档索引与目录规则 | [`docs/README.md`](docs/README.md) |
| 计划（六步、横切安排、里程碑、待定事项） | [`docs/research/pr4-review-and-plan-2026-10/README.md`](docs/research/pr4-review-and-plan-2026-10/README.md) |
| ADR | [`docs/adr/0001-reference-rewrite.md`](docs/adr/0001-reference-rewrite.md)（参考重写与 16 项决策）、[`docs/adr/0002-claude-platform-route.md`](docs/adr/0002-claude-platform-route.md)（Claude Platform 路由，取代 0001 的模型部分） |
| 规范 | [`docs/spec/data-formats.md`](docs/spec/data-formats.md)（`.nexgent/`、会话 JSONL v1、账本）、[`docs/spec/permissions.md`](docs/spec/permissions.md)（沙箱、命令策略、审批、费用上限、密钥） |
| 分工表 | [`docs/plan/step-1-work-partition.md`](docs/plan/step-1-work-partition.md) |
| 验收记录与证据政策 | [`docs/validation/`](docs/validation/README.md)（模板 `TEMPLATE.md`，每步 `step-<n>-<yyyymmdd>.md` 与 `step-<n>/` 摘要） |
| DSH 对照表 | [`docs/reference-map.md`](docs/reference-map.md) |
| 各包说明 | `packages/{kernel,llm,session,workspace,test-support}/README.md`、`apps/cli/README.md` |
