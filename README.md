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

- **步骤 3**（[`step-3-20261011.md`](docs/validation/step-3-20261011.md)，脚本化验收在 Linux 与 Windows 都通过），经脚本化验收证明：
  - 委派：主对话把子任务交给成员，fresh（带资料）与 fork（带父历史）两种；成员可以交付成果；只读父会话下成员继承预设与沙箱；
  - 团队：队友并发工作，经邮箱通信，任务板按依赖推进；
  - 工作流：脚本与图两种写法，含环的图被拒绝；
  - 工具：PTC（`run_code`，超时会被终止）、表格（.xlsx 读写，公式用纯 JS 计算）、网页；用户级与项目级技能；
  - 委派与团队只有一层；成员的审批规则与主对话相同，审批提示写明是哪个成员请求的；
  - 取消会传到成员；费用按会话树汇总，单任务上限生效；
  - 进程在成员流到一半时被强杀后可以恢复，恢复后能查询子会话与协作记录；
  - 桌面应用：显示成员块、子会话只读视图、成员审批，成员流式时强杀主进程后重启可恢复；
  - 主干上没有 Python 文件。
  - 真实 Claude Sonnet 5.5（thinking 开）在 Linux 上用直接、委派、团队、工作流四种形态，以及不指定形态，各完成了一次两轮补货表格任务（生成，再按反馈修改），结果由脚本独立检查。这不说明协作形态比直接执行更好或更省。

- **步骤 4**（[`step-4-20261012.md`](docs/validation/step-4-20261012.md)，脚本化验收在 Linux 与 Windows 都通过），经脚本化验收证明：
  - 能力版本：任务里起草、试用函数模块与技能，只在本会话可用，草稿区文件工具读写都拒绝；只有成功调用过的组件能提交为候选；能力包内容寻址，写成后不可改；
  - 门控：历史不足时等待；候选与当前版本在回放集上两侧各跑多次，按检查、费用与（打平时）评审模型决定采用或拒绝；被拒候选的组件、回执、费用与原因保留；试验额度用尽时结论为 unknown，不采用；试验不改真实项目；门控进程被强杀后不重复采用；
  - 新 OS 进程里的任务自动加载已采用版本并调用组件，账本记录版本与 componentsUsed；
  - 自动回滚：已采用组件连续出错，或能力包被篡改导致加载失败时，退回上一版本；
  - 上下文策略不能改审批、费用、沙箱与门控；插件试用与采用各审批一次；成员不能开发组件；
  - 桌面应用：右栏显示当前能力版本，候选状态与拒绝原因可见，插件审批框，手动回滚。
  - 真实 Claude Sonnet 5.5（thinking 开）在 Linux 上跑通一次主链：任务 A 开发并使用一个函数模块，门控以更省采用，新进程里的任务 B 自动调用它，注入退化后 3 个任务内自动回滚到原版本。所有回放两侧检查都通过，所以这不说明能力版本让任务更准；门控的采用率没有统计。

- **步骤 5**（[`step-5-20261013.md`](docs/validation/step-5-20261013.md)，脚本化验收在 Linux 与 Windows 都通过），经脚本化验收证明：
  - 反馈计数：对成果的评分 ≤3 或只有评论的反馈计入，交付检查失败计 1，计满 3 条自动开始改进作业；成果卡片上的“改进”按钮立即开始；设置里可以关掉自动改进；
  - 改进作业：在独立进程里诊断（报告合 schema）、在快照副本里重做任务并提出一个组件，再交给门控；改进预算按项目计，用尽后停止；每个项目同时只有一个作业，作业进程被强杀后标为中断、不重跑；
  - 门控接反馈：回放集含反馈任务，评审模型的反馈检查与确定性检查分开记录；质量提高不因费用拒绝，费用超过 2 倍时等用户批准（[ADR 0007](docs/adr/0007-gate-cost-rule.md)）；
  - 采用后，新 OS 进程里的下一次任务自动加载并调用组件，作业记下首次被使用；
  - 桌面应用：“改进”页显示作业状态、诊断、候选与门控结论，设置保持。
  - 真实 Claude Sonnet 5.5（thinking 开）在 Linux 上跑通一次主链：任务与反馈都不提能力工具，用户只指出地区表缺一列，3 条计入的反馈后改进作业自动开始，提出一个技能，门控以质量提高采用（检查 100% 对 67%，反馈检查 100% 对 0%），新进程里的下一次任务自动调用它，表里有了那一列。修复后只跑通一次，成功率没有统计；反馈检查由评审模型判定，没有人工复核。

**尚未验证：** macOS；Windows 安装包（Windows 上只验证了从源码运行）；真实模型下的上下文压缩；在桌面应用里接真实模型；Windows 上的真实模型协作任务；协作形态的成功率与收益；Windows 上真实模型的能力版本、门控与改进作业；改进流程的成功率与长期收益。

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
- 测试与验收：`pnpm test`（脚本化 provider，不需要密钥）；`node scripts/accept-step2.mjs`（无界面层与桌面层）；`node scripts/accept-step2.mjs --layer real`（真实模型，需要密钥）；步骤 3–5 同理用 `scripts/accept-step3.mjs`、`scripts/accept-step4.mjs`、`scripts/accept-step5.mjs`。

## 旧产品

旧的 Python 代码已从主干删除，归档在两个分支，说明见各分支的 README：

- [`archive/harness-gui`](https://github.com/csxq0605/Nexgent/tree/archive/harness-gui)：Python / PyQt 科研 Coding Harness（原 `nexgent/`、`stage-*`、`tests/`、`config.py`）。
- [`archive/python-host`](https://github.com/csxq0605/Nexgent/tree/archive/python-host)：Python 宿主与 benchmark 插件（PR #4 分支 `refactor/dsh-application` 的顶端 `fd0b2f42`）。

## License

[MIT](LICENSE)
