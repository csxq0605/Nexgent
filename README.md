# Agent Learning Hub - MiMo

基于 [Agent Learning Hub](https://github.com/datawhalechina/Agent-Learning-Hub) 学习路线，使用小米 MiMo 模型完成 Stage 0-8 实践，并构建生产级 Agent Harness。

## 模型配置

| 配置项 | 值 |
|--------|-----|
| Base URL | `https://token-plan-cn.xiaomimimo.com/v1` |
| Model | `mimo-v2.5-pro` |

## 阶段概览

| Stage | 主题 | 交付物 | 关键概念 |
|-------|------|--------|----------|
| 0 | 理论基础 | [学习笔记](stage-0/note-why-agent.md) | Agent vs Workflow、ReAct 范式 |
| 1 | 最小 Agent | [~220 行 Python agent](stage-1/) | Agent Loop、工具选择、安全数学求值 |
| 2 | RAG 研究助手 | [研究助手 agent](stage-2/) | 三级记忆、RAG 管线、引用 |
| 3 | Agent Harness | [Harness 演示](stage-3/) | 工具注册、权限门、会话存储 |
| 4 | 多 Agent 协作 | [多 agent 写作系统](stage-4/) | Supervisor 模式、角色分离、结构化 I/O |
| 5 | Skill 框架 | [Code Review Skill](stage-5/) | SKILL.md 格式、可复用工作流 |
| 6 | 浏览器自动化 | [浏览器研究 agent](stage-6/) | Playwright、安全守卫、审计追踪 |
| 7 | 评估框架 | [评估运行器](stage-7/) | 双层判定、失败分类、回归测试 |
| 8 | 生产级 DevOps Agent | [DevOps agent](stage-8/) | 可观测性、成本追踪、权限门 |

## Agent Hub

基于 Stage 0-8 经验构建的生产级模型无关 Agent Harness，参考 Claude Code 架构。

**核心特性**：Agent Loop、33 个工具、权限管线、安全管线、上下文管理、记忆系统、会话管理、Hook 系统、SubAgent、Skills、MCP 支持、TUI、CLI、自定义智能体、后台任务、@文件引用、目标管理

详见 [agent-hub/README.md](agent-hub/README.md)。

## 快速开始

```bash
git clone https://github.com/csxq0605/Agent-Learning-Hub-MiMo.git
cd Agent-Learning-Hub-MiMo/agent-hub
pip install -e .

# 配置 .env
cp .env.example .env
# 编辑 .env 填入你的 MIMO_API_KEY

ah          # 进入交互模式
```

## 测试

| 类型 | 数量 |
|------|------|
| 单元测试 | 1057 |
| E2E 测试 | 73（57 fast + 16 slow） |
| Stage 测试 | 67 |

```bash
cd agent-hub
pip install -e ".[dev]"
python -m pytest tests/ --ignore=tests/test_e2e.py -v  # 单元测试
python -m pytest tests/test_e2e.py -v                    # E2E fast
python -m pytest tests/test_e2e.py -v --run-slow         # E2E fast + slow
python run_tests.py --all                                 # 全部
```

## CI/CD

GitHub Actions 自动化测试：

- **unit-tests**: push/PR 自动运行，Python 3.10-3.13 矩阵，覆盖率报告上传 Codecov
- **e2e-fast**: 仅手动触发（`workflow_dispatch` 选择 `fast` 或 `all`）
- **e2e-full**: 仅手动触发（`workflow_dispatch` 选择 `all`）

## 项目结构

```
Agent-Learning-Hub-MiMo/
├── stage-0/ ~ stage-8/    # 学习阶段交付物
├── agent-hub/             # 生产级 Agent Harness（主要交付物）
│   ├── agent_hub/         # Python 包（核心代码）
│   │   ├── agent.py       # 核心 Agent Loop
│   │   ├── cli.py         # REPL + 斜杠命令
│   │   ├── tui.py         # 全屏 TUI 界面
│   │   ├── tools/         # 14 个工具模块（33 个工具）
│   │   └── ...
│   ├── tests/             # 1057 单元 + 73 E2E 测试
│   └── setup.py           # 包配置
├── tests/                 # Stage 级别测试
└── .github/workflows/     # CI/CD
```

## License

MIT License
