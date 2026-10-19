# AGENTS.md — Nexgent 实施约定

本文件适用于整个仓库。在本仓库工作的智能体（包括 Claude）先读本文件及它引用的文档，并以实际源码、契约和测试校正文档里的描述。文档与代码冲突时，查清生产调用链后改文档或改实现，不保留已经废止的说法。

## 1. 必读顺序

1. [`docs/PROJECT_POSITIONING.md`](docs/PROJECT_POSITIONING.md)：产品与设计定位
2. [`docs/spec/`](docs/spec/)：数据格式、权限、内核钩子三份规范
3. `packages/kernel/src/contracts/`：字段名以这里为准
4. 当前改动涉及的源码、测试和各包 README

## 2. 目标形态

TypeScript 写的通用任务智能体应用（Electron 桌面应用 + CLI）：在真实项目里完成任务，并在日常任务中改进自己。

- **任务内**：随时插话，压缩时逐字保留用户原话，中途的话转给正在运行的成员。
- **组织**：小任务自己做，其余用 `organize` 自己组队，卡住时改组。
- **跨任务**：用户级组织库记住同类任务上顺利的分工；项目规则每次都给；经验手册靠随机对照留用。

运行架构用 Cordis（npm 上的 `@deepseek-ai/cordis` 等库）。DeepSeek Harness（DSH）只作只读参考，固定在子模块 `reference/deepseek-harness`（提交 `46a7f68b`），不参与构建、不作运行时依赖。模型走 Claude Platform（`@anthropic-ai/sdk`），默认 `claude-sonnet-5-5`，thinking 开，effort `medium`。

“拿旧任务重放打分”的旧改进机制（能力候选与门控、改进作业与改进器、技能库、离线进化）已关闭，代码保留，默认不运行、界面不显示；没有用户决定，不重新打开也不删除。

更早的历史、ADR 原文、计划与验收记录在归档仓库 `csxq0605/Nexgent-archive`。

## 3. 工作约定

- **真实模型实验等用户开口。** 在用户亲口说之前，不跑任何真实模型实验，也不去找用户批费用。
- **测试从简。** 只测改动的包及其依赖方，再加 `pnpm build`；之前通过的不重跑，不为每次改动写大量测试。
- **子智能体用 Sonnet、medium effort**，除非用户另有指示。
- **不设定时检查。** 不创建定时任务、轮询或周期性回访；等外部结果时结束本轮，由事件唤醒。
- **密钥只从环境读取，绝不写入文件。** 只通过 `NEXGENT_API_KEY`（回退 `ANTHROPIC_API_KEY`）提供；不写进仓库里的任何文件、日志、测试夹具与提交信息。文档里用 `<key>` 占位。
- **不做任务特化。** 产品代码、系统提示与判定规则里不写只为某个用例或某类任务服务的规则、例子或默认值；每项改动要能说明对任何任务都成立。用例只用来测量。
- **README 只写有依据的能力。** 写清是脚本化模型的测试还是真实模型的实测；没测出的不写成能做到。
- **证据卫生。** 未知结果不算成功；脚本化模型与真实模型分开记；原始 JSONL 与日志不进仓库。
- **设计变了就改 `docs/PROJECT_POSITIONING.md`。** 文件格式或权限变了，同步改 `docs/spec/` 与 `packages/kernel/src/contracts/`。
- **从 DSH 改写的文件**加头注 `Adapted from deepseek-harness@46a7f68b <path>`，并登记到 `THIRD_PARTY_NOTICES.md`。
- **共享根文件**（`package.json`、`pnpm-workspace.yaml`、`tsconfig*.json`、`.github/workflows/`、`.gitignore`）由集成者改；并行分工时子智能体之间不编辑同一文件。
- **提交与 PR** 只署用户的 GitHub 名字，不加 Co-Authored-By、会话链接或任何 Claude 字样。

## 4. 文档的安排

- 根目录：`README.md`（英文）与 `README_zh.md`（中文）内容对应，改一份就同步另一份；`AGENTS.md` 是开发与智能体约定。
- `docs/`：大写文件名的用户文档（操作手册、本地运行、配置、产品定位），`spec/` 放规范；不另立设计决定文档；[`docs/README.md`](docs/README.md) 是索引。
- `assets/`：README 用的标题图、架构图和界面截图。界面变了要更新截图。
- 过程文档（计划、调研、交接、实验报告、验收记录）不进仓库，放项目共享资料里。

## 5. 常用命令

要求 Node ≥ 22.12、pnpm 10.28.0。

```sh
pnpm install --frozen-lockfile
pnpm build            # tsc -b，并对测试做类型检查（tsconfig.tests.json）
pnpm test             # vitest，脚本化模型，不需要密钥
pnpm --filter <包名> test
pnpm --filter @nexgent/desktop build && pnpm --filter @nexgent/desktop start
node apps/cli/bin/nexgent.mjs run --project <dir> --task "..."   # 真实模型，需要密钥
```

CI 只手动触发：`.github/workflows/nexgent.yml`（Linux 与 Windows 上 build、test）；`windows-accept.yml`（Windows 上的桌面测试，可选真实模型层）。desktop 包的界面端到端测试会打开真实窗口，不要在用户的 Mac 上跑。
