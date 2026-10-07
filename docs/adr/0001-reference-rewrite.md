# ADR 0001：以 DSH 为参考重写 Nexgent 运行时

- **状态**：已接受
- **日期**：2026-10-07
- **来源**：[计划 4.0、4.9](../research/pr4-review-and-plan-2026-10/README.md)；计划 4.9 表中的 12 项“仍需拍板”事项全部按建议接受，连同已定事项一起记录于此。

## 背景

Draft PR #4（`refactor/dsh-application`）把 DeepSeek Harness（DSH）13,321 个文件以 subtree 整体导入，Nexgent 自己的 TypeScript 只有约 1,500 行且分散在上游包里；DSH 处于 developer preview（仓库固定 0.1.7-rc.1，上游 npm 已到 0.2.0-rc.2），整体导入使 PR 无法评审、锁文件与上游分叉、无关内容进入主干。与此同时，45,288 行 Python 宿主仍留在仓库，五代入口并存，只有 Windows 能跑，TypeScript 运行时没有 CI。

用户在 2026-10-07 给定的产品定义是：以 DSH 源码为基础、使用并改造其 Cordis 运行架构，做成能完成真实任务、持续积累能力并改进自身的 Nexgent 独立应用；用户面对项目、对话、资料和成果；默认模型 `mimo-v2.6-pro`；订单、Excel、科研、OpenFOAM 是应用案例，benchmark 只用于测量。接入方式由用户决定为**参考重写**。本 ADR 把这一决定及其派生决策固定下来。

## 决策

### 接入方式与仓库

1. **DSH 只作只读参考。** 参考库以 git submodule 登记在 `reference/deepseek-harness`，固定提交 `46a7f68b0922371ce7144b668b90e377d8e799f4`，不参与构建，不作为运行时 npm 依赖，也不以 subtree 进入仓库。允许从中复制并改写文件（MIT），复制件加 `Adapted from deepseek-harness@46a7f68b <path>` 头并登记到 `THIRD_PARTY_NOTICES.md`；对照表维护在 `docs/reference-map.md`。保留 DSH 的服务名与模块边界作为 Nexgent 内部接口命名。
2. **Cordis 从 npm 取。** 运行架构直接使用 `@deepseek-ai/cordis` 4.0.4、`@deepseek-ai/schemastery` 3.18.4 与 `@cordisjs/loader`；它们是库，不是 DSH 应用代码。模型接入用 pi-ai 的 OpenAI 兼容客户端。
3. **六步顺序。** 按计划第 4 节执行：（0）横切：仓库骨架、CI、证据、reference 子模块；（1）主应用：kernel / llm / session / workspace 重写；（2）日常任务体验：资料、成果、反馈、恢复、桌面应用；（3）迁移已有能力与灵活协作；（4）能力版本进入真实运行系统；（5）默认的反馈改进流程；（6）递归改进并检验收益。每一步有验收脚本与验收记录，先机制后扩展的顺序不再颠倒。
4. **集成分支替换 `main`。** 新建集成分支从 `main` 起，每步以小 PR 合入；步骤 2 验收通过后用集成分支替换 `main`，现有 PyQt Harness 归档为 `archive/harness-gui`；Python 宿主在步骤 3 删除并归档为 `archive/python-host`。PR #4 分支保留为参考与移植来源，不再提交。仓库只描述一个产品。

### 模型

5. **默认模型 `mimo-v2.6-pro`。** 执行（主智能体、成员）关闭 thinking；改进与审核（步骤 5–6 的诊断、提案、审核模型）允许开启 thinking 或换更强模型，费用计入改进本身。
6. **单路由 + 可配置端点。** 步骤 1 只接 MiMo 一条 OpenAI 兼容路由；其他 OpenAI 兼容端点作为配置项，不做多 provider 抽象。
7. **真实模型实验只设预算上限、不设停止条件。** 步骤 4–6 每轮实验的调用与 token 上限在开工前按任务族约定；达到上限即停，不以降低门槛换取正例。

### 界面与平台

8. **Codex 式 Electron 桌面应用。** 界面是 Electron + React 桌面应用（`apps/desktop`），布局参考 Codex 桌面应用，外壳参考 DSH `apps/desktop`，信息架构与品牌沿用 Nexgent 现有 PyQt 设计；Electron 主进程持有 kernel，渲染进程经 IPC 调用进程内 SDK。**不做浏览器访问的 Web 服务**，DSH 的 `api / host / web-app` 不进入 Nexgent。
9. **Windows 沙箱先路径策略、后 ACL。** 步骤 1 在两平台先实现路径与命令策略（参考 `sandbox-local`、`fs-sandbox`）；Windows ACL 隔离（参考 `sandbox-windows-acl`）作为步骤 1 的可选项后补。代价是 Windows 隔离强度暂弱于 DSH，省 1–2 周。
10. **两平台 CI 先于新机制。** 从步骤 1 验收起 Linux 与 Windows 同时通过；GitHub Actions 以 push / pull_request 触发，真实模型验收保留手动 workflow。

### 回退与采用边界

11. **DSH npm 包只在步骤 1 中期检查点作为备选。** 若 kernel 重写超期，允许临时以 DSH 的 npm 包作为后端先打通步骤 2；这一选项只在步骤 1 中期检查点（第 2–3 周末）决定，默认不用；检查点的内容见 `docs/plan/step-1-work-partition.md`。
12. **插件包类候选每次人审批；技能与 PTC 函数可自动采用。** 插件包在宿主进程内执行、不受沙箱约束，采用前每次都要人审批，不做“审批一次后自动采用”；SKILL.md 与 PTC 函数模块通过门控后自动采用。
13. **反馈触发的改进默认累计 3 条运行一次。** 自动改进作业默认每累计 N=3 条反馈运行一次，项目级可切为即时；设置只有“自动改进开 / 关”和预算上限。

### 评价与数据

14. **两个任务族，OpenFOAM 可选。** 步骤 6 的测量用表格 / 数据与多文件代码两个任务族；OpenFOAM 作为可选插件族，不作为通过条件。
15. **旧数据不迁移。** Python Episode、组织 SQLite、PR #4 的 `.nexgent/native/` 不迁移，只保留只读导出；删除 Python 时附说明。
16. **Python SDK 延后。** 步骤 2 只做 TS 的进程内 SDK 与 Electron IPC；Python 客户端延后，何时做另立 ADR。

## 后果

- 步骤 1–2 比 fork 方案多出约 5–7 周（计划 4.7），换来 Nexgent 对运行时的完整所有权、仓库体积与可评审性、不受上游 preview 版本变动牵制。
- 重写初期缺少 DSH 多年积累的边界处理（取消、超时、并行工具调用），要靠验收脚本与故障注入测试补回，不靠复制整包；`packages/test-support` 因此在步骤 1 与 kernel 同时开工。
- 每个 Nexgent 包只实现当前步骤需要的部分，边界用测试固定；不复制 DSH 的 session 格式迁移、多 provider、i18n 文档、snapshot 测试体系。目标规模约为 DSH 对应代码的三分之一。
- 在步骤 2 验收前，仓库同时存在旧 Python 产品与新 TypeScript 工作区；根 README 只描述已验收能力，顶部一段指向新应用的文档。
- 决策 11 的备选若被启用，`@nexgent/kernel` 的交付延到步骤 2 之后，且 Nexgent 会短暂依赖上游 0.2.x 的 npm 包（与参考库固定的 0.1.7-rc.1 不同版本）；启用时必须另写 ADR 记录恢复重写的时间点。
- 决策 12 把插件包的安全边界放在人审批上；决策 9 把 Windows 的隔离强度暂时放在路径策略上。两者都是已知的弱点，在 `docs/spec/permissions.md` 的“已知边界”中如实写出。
- 决策 7、14 使步骤 4–6 的结果可能为零或负；届时按原定规则如实记录。
