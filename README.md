# Nexgent

**面向科研发现，通过可执行源码继承进行自我改进的智能体系统。**

用户提供研究问题与预算，在研究窗口查看资料、假说、实验、反例、结论和程序谱系。智能体运行自己的研究程序，修改科学求解算法以及提出下一轮改进的方法；后代从新进程加载并执行继承的源码。

当前研究场景是**从含噪观测发现动力学方程**：系统组织文献研究和竞争假说，编写估计与模型选择方法，进行开发实验，再由独立评价器测量新初值、更长轨迹及不同方程族的预测。科研目标是检验方法与智能体改进机制，合成方程的恢复结果不等同于发现新的自然定律。

## 启动研究窗口

需要独立的 Python 3.11+ 环境；本机验证使用 Python 3.12。Windows 使用该项目自己的 Python，避免 Qt/Conda 动态库混用。

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -e '.[dev]'
.\start.ps1
```

本机已有 `.venv` 可直接运行 `start.ps1`，或 `.venv\Scripts\python.exe -m nexgent gui`。

模型从本项目被 Git 忽略的 `models.json` 和 `.env` 读取。配置示例见 [models.example.json](models.example.json) 与 [.env.example](.env.example)。复制为对应本机文件后填写凭证。没有配置时显示具体错误；API 密钥不会进入智能体源码进程。

## 一次研究的完整过程

1. 注册问题、模型与数值预算、实现版本和评价规则。
2. 运行强静态求解器，得到开发诊断与研究选择基线。
3. 执行当前源码的 `select_parent` 和 `improve`。初始程序使用文献研究、独立批评、源码设计和开发实验；后代可以重写步骤、角色与信息流。
4. 执行候选科学程序，保存质量、成本、失败和真实数值工具回执。
5. 更新部署冠军与探索档案，把实际失败和后代结果交给下一轮研究。
6. 冻结方法，以三个独立种子检验未见轨迹与额外方程族。
7. 单独运行初始/演化改进器的真实后代对照，区分任务进步与改进能力变化。

arXiv 在线检索及原文片段与仓库已核实的一手研究笔记同时可用，记录明确区分当次获取、历史笔记及检索失败。

## 可演化对象

| 对象 | 内容 |
|---|---|
| `task.py` | 方程表达、估计、验证、模型选择及科学提交的可执行算法 |
| `meta.py` | `improve`、父代选择和改进策略的实现 |
| `workflow.py` | 角色协作、依赖、实验安排和共享研究函数 |
| `roles.json` | 程序使用的角色指令 |
| 固定宿主 | 进程、能力接口、独立评分、预算、停止和证据账本 |

源码可定义函数、循环、新表达式和研究控制流。文件共享名称空间；直接任务/元模块互换可能暴露依赖耦合，因此它与实际后代生产率分别报告。

执行边界包括独立进程、Python 能力限制、审计钩子、内存/指令/数值/请求预算；没有直接文件、网络、反射或子进程能力。它不是完整操作系统容器。`work_units` 是确定性数值计算代理，模型 token 与墙钟时间另记。

## 研究与复现

```powershell
# 真实研究；arm还可为task_only（文件范围消融）或greedy（只扩展冠军）
.venv\Scripts\python.exe -m nexgent research '改善动力学发现与自身研究程序' --generations 3 --arm full --seed 0

.venv\Scripts\python.exe -m nexgent list
.venv\Scripts\python.exe -m nexgent show STUDY_ID
.venv\Scripts\python.exe -m nexgent resume STUDY_ID
.venv\Scripts\python.exe -m nexgent export STUDY_ID

# 两版实际improver从共同起点产生后代，独立注册预算
.venv\Scripts\python.exe -m nexgent meta-evaluate STUDY_ID --seeds 401 502 603 --k 1

# 不用模型的固定方法控制
.venv\Scripts\python.exe scripts/run_research_study.py baseline --seeds 0 1 2

# 当前产品测试使用显式模拟模型，不发送真实请求
.venv\Scripts\python.exe -m pytest tests -q
```

停止保留已登记用量。恢复沿用冻结实现和账本，未提交的旧模型请求不会静默重发。数据保存在 `.nexgent/research/research.sqlite3`，导出保存在 `.nexgent/exports/`。

## 设计与证据

- [整体协作计划](REFACTOR_PLAN.md)
- [架构和文献到实现的映射](docs/research/design.md)
- [RSI 一手文献复核](docs/research/reboot-rsi-mechanisms.md)
- [科学协议、旧失败分析和控制实验](docs/research/reboot-scientific-protocol.md)
- [全仓迁移审计](docs/research/reboot-repository-map.md)
- [源码运行合同](docs/research/source-runtime-contract.md)
- [操作与故障恢复](docs/operations.md)

软件检查、实际自修改、任务性能、真实后代生产率是不同证据层次。完整研究保留所有失败和缺测，流程结束不自动代表科研假设成立。

## 单一产品结构

```text
src/nexgent/
  kernel/       源码版本、执行边界、统一账本
  models/       Provider请求进程和预算回执
  agents/       可继承研究程序和能力代理
  research/     原文检索与已核实文献笔记
  science/      可组合实验工具和独立动力学评价
  evolution/    源码演化、档案和真实改进器对照
  ui/           研究信息窗口
tests/          当前产品测试
scripts/        科研复现及报告
docs/research/  设计、协议与实验依据
```

旧 Harness、示例和被否定的有限策略原型已从活动源码退出，保留在本机仓库外快照及 Git 历史中。安装包只包含 `src/nexgent`。
