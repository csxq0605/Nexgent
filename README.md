# Nexgent

Nexgent 正在重写为一个 TypeScript 独立应用（Electron 桌面应用 + CLI），目标是能在真实项目里完成任务、持续积累能力并改进自身。运行架构用 Cordis；[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 只作只读参考，以固定提交的子模块供对照。模型走 Claude Platform，默认 `claude-sonnet-5-5`，执行时开 thinking（[ADR 0002](docs/adr/0002-claude-platform-route.md)、[ADR 0003](docs/adr/0003-thinking-on-by-default.md)）。

计划与六步顺序见 [docs/research/pr4-review-and-plan-2026-10/README.md](docs/research/pr4-review-and-plan-2026-10/README.md)，文档索引见 [docs/README.md](docs/README.md)。

## 已验收的能力

本节只写在 [`docs/validation/`](docs/validation/README.md) 里有验收记录的能力；未知结果不算成功。

- **步骤 1**（[`step-1-20261011.md`](docs/validation/step-1-20261011.md)）：通过 `nexgent run` / `resume`，真实 Claude Sonnet 5.5 在 Linux 上完成了一个两轮多文件代码任务。会话以原生 JSONL 保存，可以续聊，账本完整。
- **步骤 2**（[`step-2-20261011.md`](docs/validation/step-2-20261011.md)，Linux 与 Windows 都通过），经脚本化验收证明：
  - 项目：新建项目、从最近项目重新打开；
  - 资料：添加 .csv / .xlsx 资料，.xlsx 经 Office 技能读出；
  - 对话：多轮对话、流式输出、工具活动显示；
  - 成果：`present` 交付带版本的成果快照，针对某个版本反馈，修改后出新版本，可看版本间差异；
  - 持久目标；
  - 停止当前轮，已流出的文本保留；
  - 权限：沙箱拒绝写工作区以外的路径，写敏感文件需要审批，项目费用上限生效；
  - 上下文压缩（只在脚本化 provider 下验证）；
  - 进程被强杀后恢复，历史、资料与成果都在；
  - `nexgent export` 导出会话；
  - 桌面应用：主进程、界面、设置页，IPC 令牌守卫。
  - 真实 Claude Sonnet 5.5（thinking 开）在 Linux 和 Windows（shell 工具为 `pwsh`）上各完成了一个三轮表格数据任务，结果由脚本独立检查。三轮是：生成、按反馈修改、模型流到一半强杀后恢复。

**尚未验证：** macOS；Windows 安装包（Windows 上只验证了从源码运行）；真实模型下的上下文压缩；在桌面应用里接真实模型。

## 启动

需要 Node.js 22.12 或更新版本、pnpm 10.28.0。

```sh
git clone https://github.com/csxq0605/Nexgent.git
cd Nexgent
git checkout nexgent-app
pnpm install --frozen-lockfile
pnpm build

export NEXGENT_API_KEY=<key>      # 模型密钥只从环境读取；未设置时回退到 ANTHROPIC_API_KEY

# 桌面应用
pnpm --filter @nexgent/desktop start
node apps/cli/bin/nexgent.mjs app --project <dir>      # 或经 CLI 直接打开一个已有目录

# CLI
node apps/cli/bin/nexgent.mjs run --project <dir> --task "..."
node apps/cli/bin/nexgent.mjs resume <sessionId> --project <dir> --task "..."
node apps/cli/bin/nexgent.mjs export <sessionId> --project <dir>
```

- 安装、打包与数据目录见 [docs/install.md](docs/install.md)；CLI 的参数与退出码见 [apps/cli/README.md](apps/cli/README.md)。
- 桌面应用的设置页也能填写密钥，写入 `~/.nexgent/credentials.json`（权限 0600）。
- Linux 以 root 运行桌面应用时要加 `--no-sandbox`。
- 测试与验收：`pnpm test`（脚本化 provider，不需要密钥）；`node scripts/accept-step2.mjs`（无界面层与桌面层）；`node scripts/accept-step2.mjs --layer real`（真实模型，需要密钥）。

## 旧产品

旧的 Python 代码已从主干删除，归档在两个分支，说明见各分支的 README：

- [`archive/harness-gui`](https://github.com/csxq0605/Nexgent/tree/archive/harness-gui)：Python / PyQt 科研 Coding Harness（原 `nexgent/`、`stage-*`、`tests/`、`config.py`）。
- [`archive/python-host`](https://github.com/csxq0605/Nexgent/tree/archive/python-host)：Python 宿主与 benchmark 插件（PR #4 分支 `refactor/dsh-application` 的顶端 `fd0b2f42`）。

## License

[MIT](LICENSE)
