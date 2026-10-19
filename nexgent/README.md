![Nexgent — Agents in motion](assets/brand/nexgent-title.png)

Nexgent 是面向长周期科研代码与模拟任务的可追踪、自排查、自进化 Coding Harness。
它把 Agent 的代码修改、Shell、测试和模拟器操作放入持久、验证驱动的工程闭环，并通过
PyQt6 GUI、Textual TUI 和无界面 CLI 提供同一套能力。

## 安装与配置

要求 Python 3.10+。

```bash
git clone https://github.com/csxq0605/Nexgent.git
cd Nexgent/nexgent

python3 -m venv .venv
source .venv/bin/activate
pip install -e .

cp .env.example .env
cp models.json.example models.json
```

在 `.env` 中填写 Provider 密钥。`models.json` 使用 `provider/model` 标识，并分别配置
主 Agent、SubAgent 和快速任务的默认模型。

## GUI 快速开始

```bash
nexgent-gui --project /path/to/repository
```

1. 通过 **File → Model & Provider Settings…** 配置模型；
2. 打开左侧 **Runs** 页面并点击 **New Run**；
3. 填写 Task、Acceptance command、Maximum attempts 和 Check timeout；
4. 点击 **Start Run**，在 Conversation 中查看执行、诊断、恢复与验收；
5. 在 Runs 中使用 **Details、Resume、Export、Refresh** 管理持久任务。

Files、Sessions、Runs 与 Agents 都是可点击页面。写入、Shell、导出等受控操作使用 GUI
确认框，不要求返回终端处理。

![Nexgent Runs workspace](assets/screenshots/main-window.png)

三种前端共享 Agent、工具注册表、权限、Session、SubAgent、Workflow、MCP、Skills、
上下文管理和 `.nexgent/runs` 持久状态。CLI 与管道模式不会导入 Qt。

## Verified Coding Harness

### GUI 启动闭环

在 **New Run** 表单中把科研代码或模拟修复目标填写到 Task，把测试、模拟不变量或产物检查
填写到 Acceptance command。只有验收命令退出码为 0，Run 才会变成 `SUCCEEDED`。

例如模拟任务可填写：

```text
Task: Diagnose the unstable timestep and produce a verified result
Acceptance command: python simulate.py --case case.yaml --verify
```

每次 attempt 都会：

1. 运行 Agent，并记录模型、工具和工作区变化；
2. 在独立子进程中执行 `--check`；
3. 失败时记录症状和证据依赖，排序相关代码或配置变化；
4. 将候选根因与验收输出交给下一次最小修复；
5. 仅在验收通过后把 Run 标记为 `succeeded`。

验收命令仍经过权限系统。`--attempts` 限制 attempt 数，`--timeout` 限制每次验收命令；
预算耗尽会得到 `paused`，普通 Agent 回复只会得到 `completed_unverified`。

### 无需 API Key 的运行 Demo

```bash
python examples/harness_fault_recovery_demo.py
```

该 Demo 使用脚本化 Agent 和正式 `CodingTaskLoop`，依次展示模拟参数故障、独立验收失败、
依赖归因、恢复指导、第二次修复、成功验收、JSONL 导出及独立完整性校验。它不会调用
Provider；输出会给出可继续检查的临时工作区、Run ID 与导出路径。

需要真实 Provider 的 Skills、SubAgent 与 Workflow 交互展示，见
[demo-project](demo-project/README.md)；该目录是功能沙箱，不作为 Harness 闭环证据。

### GUI 查询、继续和导出

Runs 页面按最近时间列出持久 Run：

- **Details**：在 Preview 中查看状态、目标、attempt、故障、诊断、恢复、验证和变更文件；
- **Resume**：为 `PAUSED` Run 增加 attempt 与 timeout 后继续同一 Run；
- **Export**：选择保存位置并导出脱敏 JSONL；
- **Refresh**：重新读取项目的 Run Store。

### 自动化命令（可选）

```text
/harness run --check "python -m pytest -q" --task "Repair the failing tests"
/harness list
/harness status <run-id>
/harness resume <run-id> --attempts 3 --timeout 120
/harness export <run-id>
/harness export <run-id> --output /path/to/evidence.jsonl
```

`resume` 在原 Run 上增加有界预算，创建 `resume` attempt，并由 SQLite lease 保证单写者；
不会重新播放中断前尚未确认的工具副作用。导出内容经过敏感字段脱敏，包含 Run、attempt、
事件、依赖边、产物元数据、目标、故障、诊断、恢复和验证。

```bash
# 直接检查项目 Run Store
nexgent-verify-run \
  --store .nexgent/runs \
  --run-id <run-id> \
  --strict-lifecycles

# 检查可移植导出
nexgent-verify-run \
  --jsonl .nexgent/exports/<run-id>.jsonl \
  --strict-lifecycles
```

## 功能

- **Durable Run Trace**：SQLite WAL、顺序事件、attempt、artifact content address、
  dependency edge、lease 与可移植 JSONL。
- **Dependency Diagnosis**：追踪模型到工具、代码/配置变化到命令失败，以及 control、
  data、artifact、resource、causal、recovery、verification 关系。
- **Verified Recovery**：显式状态机执行 `execute → validate → detect → attribute →
  recover → rerun`，所有验收由注册 validator 完成。
- **Verified Experience Evolution**：按故障类别、文件类型、validator 和信号特征选择
  恢复策略；只有 accepted verification 可以晋升，失败会降权并在连续失败后禁用。
- **Persistent Typed DAG**：输入/输出 Schema、effect-safe 并发、精确缓存键、持久节点
  结果和 fresh-runner resume。
- **Scientific Telemetry**：`SimulatorAdapter`、模拟器状态、缺失字段、资源占用和外部
  副作用记录；不可逆副作用必须获得显式批准。
- **Agent Workspace**：文件与 Shell、代码执行、搜索、LSP、Notebook、Skills、MCP、
  SubAgent、Workflow、会话恢复、`@file` 引用、运行中 `/btw` 和 Stop。

## 科研模拟接入

无需修改 Harness 核心即可接入已有模拟器。最小要求是：

- 提供可重复执行的验收命令；
- 让关键配置、代码和产物位于项目工作区或被记录为 artifact；
- 若需要内部状态级排查，实现 `SimulatorAdapter.snapshot()` 并通过
  `HarnessTelemetry` 记录；
- 对外部写入、作业提交或设备操作声明副作用与审批要求。

## 安全边界

- 写文件、Shell、验收命令、SubAgent 和外部副作用继续经过现有权限管线；
- 无验证结果不能晋升恢复策略，高风险策略需要持久批准证据；
- 自进化是恢复经验的验证式选择，不是基础模型训练，也不是无条件补丁复用；
- 项目效果评估不属于内置运行时，由外部任务体系统一负责。

## 测试

```bash
pip install -e ".[dev]"
QT_QPA_PLATFORM=offscreen pytest -q
```

桌面端说明见 [docs/desktop-gui.md](docs/desktop-gui.md)。

## License

[MIT](../LICENSE)
