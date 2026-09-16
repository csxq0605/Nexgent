# 源码 RSI 共享实现契约

> 历史协作记录：以下为早期源码原型的合同，科学目录归属等内容已过时。现有 0.8 见 [实现快照](../architecture-0.8.md)，下一版范围以 [vNext 架构](../design/agent-architecture-vnext.md)为准；四文件限制不再定义目标框架。

状态：供本轮实现统一使用，接口变动由根代理协调。产品包唯一位置为 `src/nexgent`；旧 `nexgent/nexgent` 已连同旧运行产物迁出当前仓库，保存在相邻目录 `NExgent-rejected-prototype-20260915`。

## 1. 源码版本

`nexgent.kernel.programs.make_bundle(files, parent=None, rationale='', provenance=None)` 返回 JSON dict：

```text
id, digest, parent_id, generation, files, component_digests, rationale, provenance
```

`files` 至少包含 `task.py`、`meta.py`，可含 `workflow.py`、`roles.json`。所有内容参与 bundle digest。Python 文件共同构成可编辑程序；`task.py` 必须定义 `solve(problem, tools)`，`meta.py` 必须定义 `improve(context, broker)`，可定义 `select_parent(archive)`。`workflow.py` 可定义被它们调用的协作函数。`roles.json` 内容放入上下文的 `roles`。

任务程序可写新的函数、算法与控制流，不受旧五字段枚举限制。改进程序可改变研究/协作方法、角色数量、并行与顺序、模型请求内容、候选生成与修复循环。它返回 `{"candidates": [{"files": {文件名: 完整替换内容}, "rationale": 文本, "hypothesis": 文本}], "research": {...}}`。缺省文件继承父代，修改后的完整包重新计算身份。

## 2. 稳定执行器（根代理）

`nexgent.kernel.runner.ProgramRunner.run(bundle, entry, argument, *, handler=None, timeout=90, stop_event=None, max_work_units=20_000_000)`：

- `entry='solve_batch'`：argument 为 `{"problems": [...]}`；独立工作进程逐个调用 `solve(problem, tools)`。
- `entry='improve'`：argument 为上下文；调用 `improve(context, broker)`。
- `entry='select_parent'`：argument 为公开 archive；调用包内父代选择函数。
- 返回 `{"value": ..., "execution": {"bundle_id", "entry", "pid", "source_digest", "elapsed_seconds", "rpc_count", "work_units"}}`。
- solve_batch value 为逐任务的 `{"ok": bool, "submission": dict}` 或 `{"ok": false, "error": text}` 数组，单个科学失败不把整个套件改写成成功。

代码只拥有纯计算 builtins、math facade 和 tools/broker 能力。无动态 import、反射、文件、网络、子进程或宿主对象访问；AST 与 CPython audit hook 双重限制，输出与时间均受限。这是受能力约束的执行语言，不能称为 OS 容器。

broker 方法通过 IPC 进入 handler(method, params)。模型凭据、隐藏评分、数据库不进入源码进程。

## 3. 科学接口（科学子智能体）

文件归属 `src/nexgent/science/*`，测试 `tests/test_science.py`。

`Toolbox(max_work_units=...)` 提供公开、可组合的数值基础能力；方法名与签名需要在 `API_REFERENCE` 中给出。所有返回值为 JSON 基本类型，不能泄露 numpy/module/function 对象。可用函数族包括数值平滑/导数、构造特征、线性/稀疏拟合、积分与观测内验证。连续参数与程序组合可由源码决定；避免重新包装旧策略枚举。

`ResearchBenchmark.evaluate(bundle, split, seed, runner, *, stop_event=None, max_work_units=20_000_000)` 返回：

```text
score, tasks[{task_id, score, nrmse, family, equation, submission, ...}],
split, suite_digest, evaluator_digest, work_units, execution
```

评价器持有真值，源码进程只收到观察 problem。最少包括带噪动力系统方程发现、未见参数/初值与一组不同函数族的迁移；分别报告同族与不同族。

`ResearchBenchmark.problems(split, seed)` 只能在内核/评估器中调用。对源码暴露 observations、dt、opaque task_id、研究要求与工具文档，**不提供 family、真实参数或测试标签**。独立评分基于返回的模型/预测，不能接受 agent 自报 score。

提交包含可计算的模型表示、假说、实际实验摘要与局限。请在实现前尽快通知根代理准确模型表示与 toolbox 方法。强静态基线由 `strong_baseline_files()` 返回可执行 task.py，另提供简单 seed 作为演化起点；两者的地位在报告中区分。

## 4. 模型与科研编排（RSI 子智能体）

文件归属 `src/nexgent/agents/*`、`src/nexgent/models/*`、`src/nexgent/research/*`，测试 `tests/test_agents.py`。

- `ModelGateway(project_root, *, reserve, stop_event=None)`：读取本项目被忽略的模型配置与 .env。`ask(role, prompt, payload, max_tokens=...)` 返回解析 JSON；reserve(receipt) 在请求前后持久化。请求墙钟、模型 token 额度由宿主限制；禁止隐式离线替代。
- `seed_files()` 返回初始 task.py/meta.py/workflow.py/roles.json（task seed 与科学 owner 接口协调）。
- `ImprovementBroker(...).handle(method, params)` 执行源码发起的 `ask`、`parallel`、`experiment`、`search`、`log`。handler 参数见下面；不得在宿主写死研究角色序列。
- `ask` 参数 `{role,prompt,payload,max_tokens}`；`parallel` 参数 `{requests:[同ask参数]}`；`experiment` 参数 `{files, label}`，补全父代文件后仅运行公开 development 评价；`search` 参数 `{query}`；`log` 参数 `{kind,content}`。
- broker 中 experiment 的实际实现由注入回调 `experiment(files,label)` 提供；search 由研究文献服务提供。所有结果和依赖进入持久事件。
- 改进器上下文包括 user question、父代源码、实际 development 记录、失败反例、公开谱系/后代结果、预算、工具文档、文献证据。最终 audit 永不加入上下文。

## 5. 控制器与实验（根代理）

唯一 Store 统一保存研究、源码包、事件、测量、模型回执、知识/假说、档案和预算。保存部分运行、失败和余量；恢复不会自动重置预算。冻结内核/评价器与可变源码有不同 digest，源码晋升不导致整个研究不可恢复。

RSI 控制器调用当前 bundle 的 select_parent/improve，真实执行后代科学代码并更新档案。任务部署冠军与继续探索的源码档案分开。Meta 能力评价需真实运行被测 improve 产生后代，不能调用旧 task_mutations 代理。

标准研究对照：强静态基线、固定改进器的任务源码演化、完整 task/meta 源码演化、拟议机制消融。版本/模块替换实验用于归因。模型预算按实际调用与 token 记录，实验按配对 seed 与任务计费；失败均计入。

## 6. 信息窗口（架构子智能体，下一阶段）

包内 `ui/` 只依赖新控制器公开快照，不再导入旧模型注册器/Agent/Tools/permissions。界面围绕目标、证据、假说、实验、反例、知识和源码谱系。用户不需要编写验收 shell 命令或管理子智能体聊天。

控制器快照与具体 UI API 待内核第一版形成后冻结。先完成全仓迁移图和隔离审查，随后分配 UI 实现。
