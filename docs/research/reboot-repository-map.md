# 全仓重构审计：从 coding harness 到科研源码 RSI

审计日期：2026-09-15。本文依据迁移启动前的工作树静态检查；没有执行模型、实验或迁移。文中的“当前/现有”旧代码描述指该审计快照。主代理随后已将旧包、运行记录、验证与构建产物移到同级 `NExgent-rejected-prototype-20260915/`；此后以 [源码运行合同](source-runtime-contract.md) 和仓库重构计划为当前实现依据。本文的路径表用于解释迁移与验收，不代表全部新能力已经实现。

## 1. 结论与重构边界

当前仓库已经更换默认 CLI 和 GUI，但仍以原 coding harness 为包主体。`nexgent/setup.py` 的 `find_packages` 分发全部旧模块，`nexgent/nexgent/__init__.py` 仍懒导出旧 Agent、权限、记忆、子智能体与安全工具接口。包内现有 89 个 Python 文件：根模块 30、GUI 15、runtime 13、工具 17、RSI 11、science 2、资源 1。更换默认入口没有完成整个产品的重构。

上一轮 RSI 是真实数值评估支持的有限策略搜索，但不是用户现在要求的源码 RSI。`rsi/contracts.py` 规定有限 `TASK_OPTIONS`，`rsi/proposals.py` 实现固定邻域，`rsi/worker.py` 的 meta 测试调用同一个预置 `task_mutations`。模型只能选择策略与顺序；没有可继承并实际执行的 `task.py`、`meta.py` 或编排源码。整包 `implementation_digest` 能证明实验解释器未变，不能证明智能体自行改进了源码。

建议一次完成以下边界切换：

1. 根目录成为唯一 Python 项目，采用 `src/nexgent`；当前嵌套包与上一轮交付整体移到仓库外归档，不进入 canonical package。
2. 保留一个冻结、可审计的科研内核，管理预算、执行隔离、工件、评估、晋升和恢复；从旧实现提取经过测试的机制，重写不适合的新接口。
3. 智能体成为内容寻址的源码 bundle。任务方法、改进算法、角色及编排都可修改；固定内核执行并比较这些版本，下一轮从真正晋升的版本继续。
4. 信息窗口围绕研究问题、科学证据、执行图、程序谱系与结论组织，正常研究流程不暴露 shell、文件树、slash command 或逐工具许可。

此处“可变”指能提交并执行新的算法或编排源码，受明确的能力和预算边界约束。源码变化本身不等于能力进步；运行完成也不等于证实 RSI，必须保留无改进、回归和证据不足的结论。

## 2. 根目录迁移图

归档目标应是仓库外独立目录，例如同级 `NExgent-pre-source-rsi/`，带来源提交、工作树清单和文件摘要。已有同级 `.baseline/NExgent` 与 `NExgent-retired-8e750a4` 可继续作为历史来源；不应把新旧源码再次复制进 canonical repo 的 `legacy/`。

| 当前路径 | 新位置或去向 | 处理与验收 |
| --- | --- | --- |
| `nexgent/setup.py`、`nexgent/pyproject.toml`、`nexgent/MANIFEST.in` | 根 `pyproject.toml` | 单一构建配置；包发现仅 `src`；资源白名单；无双重版本定义 |
| `nexgent/nexgent/` | 外部归档；择取代码进入 `src/nexgent/` | 不是整体重命名；下面模块表逐项处理 |
| `nexgent/tests/`、`nexgent/pytest.ini` | 根 `tests/` 与根测试配置 | 按新契约迁移有效断言；旧产品测试外归档 |
| `README.md`、`nexgent/README.md` | 根 `README.md` | 一个安装、启动、研究流程和能力边界说明；删除嵌套安装步骤 |
| `start.ps1` | 根 `start.ps1` | 调用安装后的 `nexgent`；不设置指向旧目录的 `PYTHONPATH`；保留调用者相对项目路径解析 |
| `.github/workflows/test.yml` | 原位置重写 | 根安装、清洁 wheel 安装、冻结内核与源码 RSI 测试；不再测试旧 coding 产品 |
| `scripts/run_scientific_validation.py` | `scripts/` 新验证脚本 | 接新接口；默认运行测试或离线基线，付费模型验证需显式命令和预算 |
| `nexgent/scripts/capture_gui_screenshots.py` | `scripts/capture_research_window.py` | 只读指定研究记录；不启动新研究 |
| `nexgent/scripts/build_brand_assets.py`、旧 assets/resources | 挑选品牌资源进入 `src/nexgent/gui/resources/` | 仅产品实际使用资源进入 wheel；构建残留外归档 |
| `docs/research/` | 原位置重写并标明方案版本 | 文献仍可用；旧有限策略实现合同不得作为源码 RSI 合同 |
| `nexgent/docs/desktop-gui.md`、`brand.md` | 根 `docs/` 合并 | 只说明当前研究信息空间 |
| `nexgent/docs/superpowers/`、`visible-gui-validation.md` | 外部归档 | 旧 coding GUI、旧路线和历史验证退出 canonical 文档 |
| `docs/validation/` 上一轮 JSON/PNG/报告 | 外部历史验收归档；当前目录重建 | 新源码 RSI 验收不能引用旧策略 campaign 冒充当前结果；可在迁移说明链接历史摘要 |
| `dist/`、`build-validation/` | 外部归档或可重建临时产物 | 旧 wheel 不作为新交付；新 wheel 由根配置重建 |
| `.nexgent/`、`validation-provider/`、`validation-workspace/` | 外部历史工作区 | 不把旧运行状态导入新活动谱系；必要时做只读历史导入 |
| `.env`、`models.json` | 用户私有配置，按新配置入口显式读取 | 不读取并打印凭据，不进仓库、bundle、导出或 worker 输入；迁移配置结构需保留用户已有值 |
| `.venv/` | 忽略的本地环境 | 重新安装根项目验证；不携带旧 editable 路径；不修改其他仓库环境 |
| `.gitignore`、`LICENSE` | 根目录 | 保留许可证与必要归属；更新运行数据与新构建目录忽略规则 |

目标结构建议如下，具体命名服从新实现合同：

```text
pyproject.toml
README.md
start.ps1
src/nexgent/
  __init__.py, __main__.py, cli.py
  kernel/       # 固定：契约、执行、预算、工件、持久化、图校验、broker
  research/     # 固定：研究控制器、查询模型、结论与报告投影
  evaluation/   # 固定：保护数据接口、评分、晋升协议、独立验证
  science/      # 科研领域与固定评估；首个是动力学发现
  agents/       # 初始源码 bundle 及提案 broker
  models/       # 显式配置与模型传输
  seeds/        # 只读初始源码 bundle，属于版本化产品资源
  ui/           # 研究信息空间与薄控制器适配
tests/
  kernel/, research/, evaluation/, source_rsi/, gui/, packaging/
docs/
  research/, operations/, validation/
scripts/
```

运行生成的后代 bundle 应存于用户研究工作区的内容寻址目录，不写回已安装 `src/nexgent`。这样自改进对象仍是真实可执行源码，同时冻结内核不会随着候选被修改。

## 3. 包内模块迁移表

### 3.1 冻结内核可提取能力

| 当前模块 | 可用机制 | 新去向与必须改变的部分 |
| --- | --- | --- |
| `runtime/contracts.py` | 类型化状态、事件、工件与依赖关系；显式 schema 版本 | `kernel/contracts.py` 重建科研契约；不迁旧修复分类、终端交互和通用 coding Goal 契约 |
| `runtime/store.py` | SQLite WAL、外键、状态比较更新、事件序号、租约、哈希工件、临时文件写入后替换 | `kernel/store.py` 和 `kernel/artifacts.py`；重建统一科研 schema，保留原子性与恢复断言 |
| `runtime/graph.py` | DAG 校验、显式输入绑定、拓扑顺序、效果冲突分批、节点状态与缓存 | `kernel/graph.py`；源 bundle 身份、工件边、执行环境与预算必须进入语义与缓存键 |
| `runtime/events.py` | 结构化事件传递思想 | 新事件协议；事件源来自 kernel，候选不能伪造评分/晋升事件 |
| `runtime/recorder.py` | 证据录入、事件与输出关联、终态核对 | 新 store 事务与报告投影；不原样迁移 943 行 recorder 和旧恢复模型 |
| `runtime/verify.py` | 独立导出核查、生命周期完整性检查 | `evaluation/verify.py`；核查 source→执行→工件→评分→晋升→后代链 |
| `rsi/store.py` | 单写者 OS 文件锁；进程退出自动释放 | 新 Store 可提取锁；不能继续以整 JSON 快照加第二 RunStore 作为两个事实来源 |
| `rsi/provider.py`、`provider_worker.py` | 请求前持久预算保留、独立请求进程、停止、超时、收据、无静默回退 | `kernel/broker.py` 及 provider adapter；剥离有限策略 schema 与固定三角色提案器 |
| `rsi/contracts.py` | 规范 JSON、SHA-256、有限数值核验、成对任务身份核对 | 摘取纯函数；以源码清单身份替代 `TASK_OPTIONS` 与策略身份 |
| `rsi/promotion.py` | 固定评估准则与模型自述分离；回归门槛 | 重新制定源码 task/meta 双评估；旧数值阈值是历史协议，不能直接宣称科学有效 |
| `rsi/report.py`、`sources.py` | 分离运行结论和科学结论；来源清单 | 研究报告与可追溯来源模型；引用要关联实际使用的工件/论断 |

当前 `runtime/graph.py` 的持久 runner 已使用 `_cache_key`，不是早期仅输入摘要的实现。但 `_cache_key` 只含节点、inputs、metadata、primitive、输入/输出 schema；没有强制绑定执行器源码、完整 bundle、环境、协议与随机种子。调用者可忘记放入 metadata，因此不足以作为源码 RSI 的缓存边界。

### 3.2 旧产品模块退出 canonical package

| 当前模块/目录 | 去向 | 理由 |
| --- | --- | --- |
| `agent.py`、`agents.py`、`subagent.py` | 外归档 | 基于 coding tools、共享 Python 进程/线程、Session 与旧权限依赖；不能当候选源码隔离执行器 |
| `workflow.py` | 外归档；只参考 typed DAG 接口经验 | 旧工作流脚本通过宿主 `exec` 执行；不是冻结 kernel 管理的源码 bundle |
| `cli.py`、`tui.py`、`commands.py`、`command_service.py`、`display.py`、`input_utils.py`、`file_references.py` | 外归档 | 终端聊天、slash command、交互式代码代理不是产品流程 |
| `context.py`、`memory.py`、`goal.py`、`hooks.py`、`settings.py`、`project_scanner.py`、`background_tasks.py` | 外归档 | 对话压缩、个人/项目记忆、通用工作区与后台工具生态；新的研究记忆是有来源的工件和结果 |
| `mcp.py`、`plugins.py`、`skills.py` | 外归档 | 不为假设的未来扩展保留任意外部工具装载；科研检索先使用显式 broker 能力 |
| `permissions.py`、`security_pipeline.py` | 外归档 | 工具许可和模型安全审查不能提供任意 Python 的 OS 隔离 |
| `token_counter.py`、`logging_utils.py` | 原文件外归档；必要纯函数另审后摘取 | 不携带旧 token/context/log 体系；新预算以 kernel 收据和明确上限为准 |
| `config.py`、`models.py` | 原文件外归档；重写显式配置服务 | 当前导入时加载 CWD/home/package 配置，形成全局状态；研究应按明确 workspace/profile 读取 |
| `branding.py` | 精简常量/资源定位 | 可保留名称、图标，不能借品牌模块导出旧 frontend 路由 |
| `tools/` 全部 17 个模块 | 外归档 | shell/file/code_exec/notebook/LSP/plan/task/交互/调度/子智能体/workflow 等 coding registry 不进入新包 |
| `runtime/coding_task.py`、`controller.py`、`interactions.py`、`service.py`、`strategy.py`、`telemetry.py` | 外归档 | 修复循环、全局 cwd、coding 交互、恢复策略与 simulator 产品接口退出 |
| `gui/app.py`、`main_window.py`、`runtime_bridge.py`、`project_dialog.py`、`widgets/*` | 外归档 | 旧聊天窗口、文件树、Agent 面板与 harness run 窗口退出 |
| `__init__.py`、`runtime/__init__.py`、`tools/__init__.py`、`gui/__init__.py` | 重写或删除 | 不保留旧 API 的懒兼容导出；新包 API 可小而明确 |

真实依赖风险：`rsi/engine.py::ProcessEvaluator` 仅为环境清洗导入 `tools.shell._scrub_env`，但 `tools.shell` 又导入 `registry` 和 `permissions`。这一条边足以将旧工具体系拉回新执行路径。新内核应自己定义子进程环境白名单，禁止以“只有一个帮助函数”为理由继续导入旧包。

### 3.3 上轮 RSI 与科学 demo 的拆分

| 当前模块 | 处理 |
| --- | --- |
| `rsi/engine.py` | 重写研究控制器。保留候选→独立评估→选择→最终审计的生命周期思想；删除固定政策提案、双 Store 写入与混合 fingerprint |
| `rsi/proposals.py` | 退出固定邻域实现。初始 `meta.py` 可借鉴其证据摘要，但候选应能改变真实源码生成/筛选/试验策略 |
| `rsi/worker.py` | 重写为 kernel 管理的 bundle 执行协议；任务 worker 与独立评分器分进程、分权限 |
| `science/dynamics.py` | 必须拆开：领域定义/轨迹生成/隐藏测评/评分进入固定 domain 与 evaluator；导数、特征库、拟合、模型选择等算法进入初始 `task.py` 或 bundle 本地模块 |
| `science/__init__.py` | 用新的 domain 接口替换 |
| `science_cli.py` | 迁移研究命令语义到根新 `cli.py`，取消旧兼容入口与 checkout 路径补丁 |

当前动力学背景值得延续：从有噪声时间序列发现低维动力系统，数值积分、稀疏模型拟合和轨迹外推都已真实计算。`discover_model` 与 `_suite`/`_evaluate_task` 当前同文件，源码 RSI 后必须隔开。允许任务程序改进导数估计、基函数构造、稀疏回归和实验分配；不能把隐藏方程、评分、保留任务实例或最终审计轨迹交给候选。基准的任务族定义可以公开，保留实例与评分端信息不应混入可访问输入。

## 4. 源码 bundle 与递归执行合同

建议每个 bundle 是不可变目录，manifest 列出全部相对路径及字节摘要：

```text
manifest.json       # schema/ABI、父版本、源码清单、入口、依赖环境身份
task.py             # observations + context → scientific artifact
meta.py             # parent bundle + development evidence → candidate source bundles
workflow.py         # task/meta 图、节点角色与数据依赖的构造逻辑
roles/              # 可变角色源码或提示词资源
lib/                # bundle 内算法模块；受同一执行权限约束
```

`task.py`、`meta.py`、图和角色都必须参与 bundle 内容身份。限制允许的文件路径、总字节、模块入口、依赖环境和执行能力，但不要把算法空间重新收窄为固定枚举或一组模板选择。仅修改注释、换标签、用 wrapper 转发固定旧函数不能证明源码级自改进。

最小真实循环：

1. kernel 读取当前 active bundle，向其 `meta.py` 提供父源码、开发数据上的证据、有限研究记忆和预算 capability。
2. `meta.py` 自行执行证据分析、调用角色、提出并组合源码修改，返回候选 bundle 工件；kernel 不在外面用固定模板代替其改进算法。
3. kernel 验证文件边界、ABI、源码摘要和执行条件，分别启动候选 task 与 meta 的评估。
4. 保护评估器用未交给提案器的任务计算 paired task、回归与 meta 迁移指标。元能力评估从一致的起始条件和等额资源运行父/子改进程序，比较它们实际产生并选中的后代。
5. 晋升事务同时写入评估引用、决策、active bundle 指针和事件；被拒候选也保存完整证据。
6. 下一轮装载新 active 的 `meta.py`、workflow 和 roles。执行收据记录实际装载源码摘要，证明这一继承关系；若未晋升则继续原版本。
7. 最终审计数据只在本轮选择结束后打开。根据任务能力、元能力及不确定性分别陈述结论，不把元代理分数增加自动解释为科学发现能力提高。

动态编排可以分阶段由候选生成图扩展请求。kernel 校验后追加版本化图再执行；候选不能直接修改已完成节点、删掉失败证据或绕过必需的评估节点。科研循环可以体现假设→方法→实验→分析→新假设，但不会因此获得无限循环或无限调用。

## 5. 执行、预算与隔离边界

### 5.1 fresh process 不等于安全隔离

当前 evaluator 清洗环境、设置 cwd 后启动 Python，并用 wall-time 停止直接子进程。这适用于固定可信解释器；对候选生成的源码不够。以宿主权限运行的 Python 仍能读取工作区 `models.json`、隐藏测试文件、安装包源码，甚至写数据库或派生进程。AST 检查、删 builtins、提示词要求和旧 PermissionGate 都不能单独作为任意 Python 的安全边界。

实际实现需要明确并记录执行等级。完整任意 Python 的 OS 隔离目标包括：

- 源码 worker 只读挂载当前 bundle、公共输入和固定科学 SDK；独立 scratch 可写；不可访问研究数据库、provider 凭据、其他项目或评分器输入。
- 评分器在不同信任域运行，只接收已验证模型/预测工件；自己生成或读取隐藏任务并评分。
- 凭据只由宿主 broker 持有。worker 使用经 kernel 授权的结构化能力请求，不直接获取 API key、任意 URL 或 shell。
- Linux 容器/namespace/cgroup 等、Windows 受限安全主体/容器及作业对象等需要落地验证。Windows Job Object 可限制资源并清理进程树，本身不能完成文件与网络隔离。
- 不支持 OS 隔离时，不能继续承诺支持任意 Python。需要明确收窄执行语言和能力，再独立审查这个边界；不能默默降级后仍把任意代码称为沙箱。
- 使用独立的依赖环境摘要；动态安装第三方依赖不是候选默认能力。没有依赖锁，源码相同也不能推断行为相同。

### 5.2 本轮选择的语言与能力边界

根据新共享合同，本轮使用**受能力约束的 Python 子集**，不是容器或 OS 沙箱。源码可以实现函数、算法、控制流与可变协作逻辑，任务空间不退回参数枚举；限制的是宿主 I/O、反射、动态代码装载和能够绕过 broker 的能力。

计划的防线为：编译前 AST 拒绝 import、反射、dunder、动态 eval 及不允许的语法/属性；全局空间仅放纯计算 builtins、受控 math facade 与科学工具/broker facade；返回值只允许 JSON 基本类型；工作进程安装 CPython audit hook 拒绝文件、网络、子进程等宿主访问；外部 runner 限制时间、输出、计算步数与 IPC；凭据、数据库、评分器和隐藏任务不进入候选上下文。

这些是待实现并测试的防线，不能据此直接宣称安全。残余风险包括：

- AST 属性黑名单可能遗漏隐式对象访问；必须采用能力白名单，并测试字符串 `format`/`format_map` 的属性遍历、异常与 traceback、迭代器/生成器、函数/类/模块引用等路径。
- 即使不允许 `__class__` 文本，传入的宿主对象也可能通过公开方法返回文件句柄、可调用对象或其它对象链。facade 入参、出参和错误必须验证并序列化，不能返回 numpy/module/function/exception 等实例。
- CPython audit hook 是运行时审计防线，不是操作系统权限边界；不应假定覆盖全部危险行为或解释器漏洞。不得允许候选移除 hook、调用 native/FFI 或接触未审查扩展。
- Python 大整数、巨型容器、复杂正则、无限迭代和输出洪泛可在有限源码中耗尽资源。wall-time 与 AST 拒绝 I/O 不能代替内存/输出/CPU 限制；没有真正硬内存隔离时要明确记录这一限制。
- 启动、加载源码和装 hook 的顺序需要核查：可信加载过程必须完成，但候选不能在 hook 或静态校验之前运行。worker 的诊断信息也不能把宿主路径、凭据或隐藏评估数据带回源码。

在目前没有已验证 Windows 容器边界的条件下，应把运行等级记录为语言/能力约束 worker，并说明不能抵御 Python 解释器漏洞或未覆盖的语言逃逸。恶意候选测试是针对已知路径的证据，不是任意代码隔离的证明。发现无法封堵的逃逸时，应拒绝对应语法/能力或关闭执行，而不是以测试数量证明安全。

### 5.3 预算由 kernel 持有

预算至少覆盖 provider 调用数、请求/输出 token 上限、评估次数、wall-time、CPU/内存、并发进程数、工件字节和图节点数量。meta、role 和 task 从同一 campaign 总账分配子预算，子程序不能自报消耗或重置额度。

必须在发出可计费请求、分配 worker 或提交耗时任务前持久保留预算，并有独立 operation ID。结果到达后结算；中断或网络结果不明记为 unknown，不静默退回预算并重发。API 超时/本地终止不能证明服务端未消费，费用信息未知时保留未知状态。

上轮 provider 的同步 receipt callback 与每次请求独立进程值得提取，但其三角色固定顺序、只计调用数的外层预算不能直接承载递归可变编排。输出流应边读边限长；目前 provider 在 `communicate` 全量读取后才判断字符数量，不是对恶意输出的内存上限。候选停止须终止整作业树，收齐可收集收据，再将控制状态转为 paused/interrupted。

## 6. 有工件边的可变编排

图节点不能只是给固定循环加角色名。每个输入应声明来源 `artifact_id`、内容摘要、schema 与生产者；输出由 kernel 收纳、哈希并记录。下游只获得声明可读的工件。例：

```text
文献记录 → 假设工件 → 方法源码 → 数值实验 → 误差/残差工件
                         ↑                         ↓
                   改进源码候选 ← 可引用的批评/分析工件
```

保护评估和晋升是 kernel 持有的必要步骤，不能因为候选改图而消失。可变的是角色拆分/合并、实验并行、反思次数、算法模块、数据分析与候选选择方法；上限和评分权限不可变。

缓存键至少包含 bundle 摘要、节点入口源码身份、环境/SDK/协议版本、输入工件摘要、图语义、随机种子以及影响计算的预算。带外部副作用的 broker 节点应使用已持久化请求收据恢复，不能当纯函数自动重放。未知 schema、缺失边、循环或未声明文件输入应报错，不能退化成 permissive JSON dict。

关键验收：改变上游实验工件确实改变下游请求与缓存身份；新增/移除/改序角色能改变执行轨迹；中断后恢复保留既有边并只重做未完成的安全步骤。只在 GUI 画线但执行器仍读取一个全局共享 dict，不满足此条件。

## 7. RunStore：提取机制，重写统一模型

不建议把原 `SQLiteRunStore` 整体改名迁入新包。其 1,634 行实现承载 experiment_runs、run_attempts、faults、diagnoses、recovery_actions、recovery_strategies、goals、verifications、workflow 等多套旧语义。上轮又加入独立 `CampaignStore` 的 JSON 快照，因此预算、状态、事件和证据跨两个 SQLite 文件提交，恢复不得不处理 snapshot 与 trace 不一致。

新内核建议一个权威数据库，至少表达 campaign、execution、bundle、lineage、graph_revision、node_execution、artifact、artifact_edge、evaluation、decision、budget_reservation、provider_receipt、event。不是要求全部都用独立 SQL 表；要求事务边界和查询语义清楚、身份可核查。GUI 的整快照是投影，不是另一份事实来源。

应复用或移植并验证：

- 显式迁移版本、外键、WAL、并发写冲突处理与单调事件序号。
- 先写内容寻址工件临时文件、刷盘、原子替换，再在事务里登记引用；崩溃留下的未引用 blob 可回收，不能出现成功事件指向缺失 blob。
- 同一事务保留预算、产生待执行 operation、更新阶段；完成事务关联输出和收据。
- 晋升与 active pointer 比较更新，避免多个恢复者相互覆盖。
- OS 所有的单写者锁或有 fencing token 的租约，防止失效 worker 继续写。
- 独立 verifier 对导出工件的源摘要、事件连续性、任务身份、评价与晋升引用做检查。

旧 DB 如需读取，应由显式离线 importer 转换成只读 `historical_evidence`，记录旧 schema、源库摘要、原 campaign ID 和“不构成新源码谱系”的标记。不要让新正常运行依赖旧 schema 兼容层。

## 8. Qt 研究信息空间接口

旧 `gui/science_window.py` 的信息架构与 start/stop/resume/history 隔离经验可以复用；新代码位于 `ui/`，接新的 typed controller/query API。样式与图标可按需要重新实现。旧 config_dialog、ModelRegistry、runtime bridge、聊天窗口、文件树和能力覆盖面板均退出，不能由新 UI 间接导入。

| 界面对象 | 所需后端信息 | 行为边界 |
| --- | --- | --- |
| 研究概览 | 研究问题、领域、状态、当前活动源码代数、执行轮数、预算、科学结论与 RSI 结论 | 活动代数与运行轮数分开；成功完成流程不显示为发现成立 |
| 科研工作空间 | 假设、方法、实验、模型/方程、误差图、批评、下一步；每项有工件身份 | 可查看证据和详情，不用用户编辑底层脚本才能继续 |
| 执行与编排 | 当前图版本、节点角色、状态、耗用与真实工件边 | 展示真实已执行图；不能把预设角色列表冒充动态编排 |
| 源码谱系 | 父子版本、源码 diff、task/meta/workflow/roles 变更、独立评分、晋升原因 | 主卡片显示“第 N 代”；完整摘要在详情可追溯 |
| 证据与结论 | 来源快照、实验/模型工件、provider 收据、评估协议、保留任务审计、限制 | 引用对应实际证据；隐藏测试细节按协议开放 |
| 配置 | 显式 workspace/profile、模型与预算；凭据仅配置服务处理 | GUI 不将凭据复制进快照、日志或导出；保存不得覆盖无关 provider |

建议命令：`create_campaign(request)`、`start(id)`、`pause(id)`、`resume(id)`、`export(id, destination)`。建议查询：`list_campaigns()`、`get_snapshot(id)`、`events(id, after_sequence)`、`get_artifact(id)`、`compare_bundles(parent, child)`。所有响应携带 campaign ID、revision 和事件序号。

Worker 只发不可变快照/事件，UI 只在选中 ID 匹配且 revision 更新时应用。浏览历史不得改变正在运行的对象；导出使用当前选中的明确 ID。关闭时异步请求停止并等待 kernel 确认作业树退出，QThread 不直接 `terminate`。进程崩溃后 running 状态可恢复，但是否存在活动写者由内核锁决定。用户干预集中于研究范围、资源预算和明确外部副作用。

## 9. 测试与依赖迁移

### 测试分类

| 当前测试 | 新测试去向 |
| --- | --- |
| `test_runtime_store.py`、`test_runtime_contracts.py`、`test_runtime_graph.py`、`test_runtime_events.py`、`test_runtime_verify.py`、`test_runtime_resume.py` | 摘取并重写事务、工件、图、恢复与完整性断言；不为兼容旧类而迁移 |
| `test_science_dynamics.py` | 拆成固定数据/评分器与 seed 算法测试；补数据权限隔离和独立评分 |
| `test_rsi_engine.py`、`test_rsi_provider.py`、`test_rsi_proposals.py` | 保留预算/错误/来源/防泄漏测试思想；有限枚举与固定角色测试退出，新增源码继承和 meta 行为改变测试 |
| `test_science_entrypoint.py`、`gui/test_science_window.py`、`gui/test_theme.py` | 改接新控制器；保留历史隔离、停止恢复、错误可见和资源加载断言 |
| `test_agent*`、`test_subagent*`、`test_cli.py`、`test_tui*`、`test_tools.py`、各 `*_tools.py`、`test_registry.py` | 外归档 |
| `test_coding_task.py`、`test_runtime_service.py`、`test_runtime_strategy.py`、`test_runtime_telemetry.py`、`test_runtime_interactions.py`、旧 controller/interaction 测试 | 外归档 |
| 旧 context/memory/permissions/security/hooks/skills/MCP/command/settings/goal/project scanner/background/frontends、GUI main_window/app/runtime_bridge/capability、harness demo/stress/e2e 测试 | 外归档；科研通用性质在新接口下重新测试 |
| `conftest.py`、`e2e_utils.py`、GUI conftest | 重建；不保留全局旧 Agent mock、旧入口 import 或仓库相对 PYTHONPATH |

上一轮大量旧测试通过只能作为历史回归证据，不能成为这次完成标准。新验收必须覆盖实际源码 bundle 与隔离边界。

### 依赖处理

原默认安装依赖包括 `prompt_toolkit`、`rich`、`textual`、`tiktoken`、`pyyaml`、`requests`、`openai`、`python-dotenv` 和 `PyQt6`。新核心不应为了旧终端 UI、工具 registry、YAML workflow 或对话 token 计数继续安装这些包。每个保留依赖要有新模块使用位置。

Qt 可作为桌面 extra；CLI/help/verify/导出不应导入 Qt。Provider SDK 与配置依赖按新 adapter 实际需要保留；统计/数值依赖可使用锁定环境明确声明。clean wheel 验证必须在源码树之外、没有旧 editable 路径的环境运行，并检查 `nexgent.__file__` 指向安装目录。

## 10. 完成验收条件

1. **整个仓库切换**：根只有一个构建入口，生产源码只有 `src/nexgent`；旧嵌套包、旧 coding 文档、旧产品测试和重复项目入口退出 canonical tree。新 wheel 无旧 Agent/tools/TUI/legacy runtime 模块或兼容导出。
2. **真实源码对象**：候选工件包含可执行 `task.py`/`meta.py`/workflow/roles 与完整 manifest；执行收据证明加载这些字节，而不是将源码文本留作说明后继续解释旧 JSON。
3. **实际递归继承**：至少一条受控测试谱系证明晋升后下一代提案确实由晋升版本 meta 与编排产生；非晋升分支不会被误用。真实模型 campaign 结果单独报告，不用测试替代。
4. **元改进有行为证据**：在一致开发输入、种子和资源下，修改 meta 源码能改变实际角色/候选/试验轨迹；由独立任务衡量后代能力，而非比较候选自述或固定枚举排序。
5. **冻结评估可信**：对受支持语言的候选，读取保留数据、改分数、写 kernel、伪造成功事件和逃逸到任意工具的已知路径均被实际防线阻止或拒绝执行；执行等级与残余风险明确可见，不将语言约束 worker 称为 OS 沙箱。
6. **工件图真实**：源→模型调用→代码→实验→评分→晋升的边可查、可导出、可独立核验；损坏摘要、缺失工件和未知 schema 会失败。
7. **公平预算与恢复**：并发候选不能突破总预算；请求发出后崩溃不重复计费重试；停止后没有候选子进程存活；恢复不会重放已完成副作用或复用不同源码的缓存。
8. **科学结论准确**：任务提升、元能力提升、总体 RSI 证据与流程完成分开；可诚实交付“未证实提升”；保留测试不能在候选设计回路里反复泄漏。
9. **信息空间可用**：默认安装启动科研界面；研究历史与运行快照互不污染；源码差异、真实执行图、预算、失败原因和证据可查看；无需 code harness 交互完成标准研究。
10. **可复现交付**：根安装、clean wheel、CLI、Qt、离线参考运行与显式预算真实模型验证分别留证；截图来自同一指定真实记录；导出包含源码、依赖/环境身份、协议、任务/模型来源与收据，凭据不进入产物。

## 11. 实施顺序与文件责任建议

先冻结新产品合同和外部归档清单，再建立根包装及最小 kernel。数据契约、source manifest、预算 capability、Store 事务和 worker IPC 必须先一致，否则 GUI、编排与领域实现会各自定义不兼容快照。

可并行的有界分工：

- **kernel/持久化与执行负责人**：`kernel/contracts.py`、`store.py`、`artifacts.py`、`budget.py`、`executor.py`、`graph.py`；配套崩溃/恶意候选/资源测试。
- **科研源码与 RSI 负责人**：`seeds/`、领域任务 ABI、研究控制器、task/meta 评估设计；证明源码继承和工件驱动编排。
- **独立评估负责人**：`science/` 与 `evaluation/` 的固定部分、数据隔离、指标/晋升与 provenance verifier；不得由候选自评替代。
- **产品界面负责人**：`ui/` 与 typed query/command 适配、CLI、研究报告；不依赖旧 runtime/Agent/config_dialog/ModelRegistry。
- **根仓交付负责人**：包装、外归档、依赖锁、测试迁移、README/CI、clean wheel 和真实验收材料。

包装切换必须与旧树退出一起完成；不能等到最后再留下“兼容旧系统”的默认借口。优先实现一个可以真实执行和审计的完整纵切面，再扩充科研角色数量。角色名更多、模块更多或窗口更丰富，都不能替代实际源码递归改进与独立科学证据。

## 12. 新内核第一版的独立审查记录

本节是重构后的阶段证据，区别于前文的旧代码审计。已检查 `src/nexgent/kernel/{programs,worker,runner,store}.py`，并新增 `tests/test_kernel_security.py`；内核修复由其负责人完成，本审计未并行修改内核。

| 发现 | 机制与修复 | 当前证据 |
| --- | --- | --- |
| 能力对象属性可写 | AST 原先只检查属性名；`broker.count = 0`、`tools.work_units = 0` 可重置计数。现拒绝 Attribute Store/Del，且 host 独立限制 RPC 次数 | 静态拒绝及实际 worker 预算重置测试通过 |
| 结构化模式匹配绕过属性检查 | `case list(__reduce_ex__=reducer)` 的私有属性藏于 MatchClass 字符串字段，不是 ast.Attribute。受控 worker 已证明私有方法被调用；未尝试读取用户文件。现禁用 Match | 两种私有属性 pattern 回归测试通过 |
| 指令预算异常可被捕获 | trace 回调抛 RuntimeError 后，源码可捕获且 CPython 停止 tracing。现由可信回调输出预算错误并终止 worker | 临时副本降低阈值的故障注入，RuntimeError 与 bare except 两种路径均被终止 |
| 同步能力调用阻塞停止 | 原 runner 在 handler 中不检查 deadline/stop；现可轮询取消并向可信能力传播 stop | 实际在途协作 handler 的停止与 deadline 测试通过；不可协作的宿主回调仍不应作为受支持能力 |
| 谱系代数可伪造 | 原 verify 只检查非负；现根版本必须是零代，Store 要求父存在且子代为父代加一 | source identity/component、父代代数与内容变更测试通过 |
| 候选可伪造顶层事件种类 | 原 broker.log 将任意 kind 送到同级事件通道；现固定 `agent_log`，保留 claimed_kind/source_bundle | 已静态检查修复；还需在完整报告投影中核对事件来源 |

本阶段执行结果：**40 passed，6.69 秒**。测试覆盖已知反射/I/O 语法、属性写入、真实源码执行、无限循环、停止、输出上限、Windows 512 MiB process-commit 限制、并发模型额度预扣、终态不退款、重新打开 Store 后预算保留和 worker 清理。大分配测试在独立受限 worker 内请求超限字符串，得到 MemoryError；没有在宿主分配大对象。

大部分执行边界测试使用当前 kernel 的临时副本和纯 Python Toolbox stub，使结果不依赖科学算法。另有单独测试使用真实 NumPy/SciPy Toolbox，完成平滑、导数、特征与拟合，并确认修改返回 receipt 副本不会改变可信收据。所有测试均无模型或网络调用。

这些检查没有证明任意 Python 或 OS 级安全。完整研究控制器、缓存包含 source/evaluator 双身份、知识工件边、源码编排与真实模型实验仍需各自验收；不能把本节测试数转写为整个 RSI 产品完成。

控制器落盘后追加一项独立缓存集成测试：使用不执行模型或数值程序的测试评分器，验证 source、evaluator、seed、protocol、budget 任一变化都会产生新测量；同一配置与重开 Store 则复用既有测量、保留计数。此项通过后安全/身份测试文件共 41 项；未修改实验运行中的内核或控制器源码。

新 `src/nexgent/ui/` 随后完成 15 项独立 Qt 测试，覆盖历史/后台隔离、旧快照拒绝、正确 arm 和预算、停止恢复与关闭、错误可见、导出身份、源码差异及凭据不显示。只读载入真实阶段记录 `study-b1b2c2500a5f4d54`，五个研究页面均正常渲染；明确显示当前任务冠军仍是第 0 代、来源检索失败和未见任务得分平均变化为零。该记录只是 GUI 整合证据，不构成科学提升验收。
