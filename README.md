# Agent Learning Hub - MiMo

基于 [datawhalechina/Agent-Learning-Hub](https://github.com/datawhalechina/Agent-Learning-Hub) 学习路线，使用小米 MiMo 模型完成 Stage 0-8 全部实践。

## 模型配置

| 配置项 | 值 |
|--------|-----|
| Base URL | `https://token-plan-cn.xiaomimimo.com/v1` |
| Model | `mimo-v2.5-pro` |
| 接口格式 | OpenAI Compatible |

## 阶段概览

| Stage | 主题 | 核心能力 | 交付物 |
|-------|------|----------|--------|
| 0 | 理论基础 | Agent 概念、ReAct 模式、Workflow vs Agent | 学习笔记 |
| 1 | 最小 Agent | 单轮 tool calling、安全数学求值、路径校验 | ~220 行 Python agent |
| 2 | RAG 研究助手 | 文本分块、关键词检索、三级记忆、代码执行 | 研究助手 agent |
| 3 | Agent Harness | 工具注册、权限门控、上下文压缩、会话管理 | Harness 演示 |
| 4 | 多 Agent 协作 | Supervisor 模式、研究→写作→审阅→修改 pipeline | 多 agent 写作系统 |
| 5 | Skill 框架 | 可复用 Skill 定义、结构化代码审查、烟雾测试 | Code Review Skill |
| 6 | 浏览器自动化 | Playwright 异步操作、URL 校验、表单安全守卫 | 浏览器研究 agent |
| 7 | 评估框架 | 15 项测试用例、关键词+LLM 双层评判、失败分类 | 评估运行器 |
| 8 | 生产级 DevOps Agent | 结构化日志、指数退避重试、成本追踪、干跑模式 | DevOps agent |

## 快速开始

```bash
git clone https://github.com/csxq0605/Agent-Learning-Hub-MiMo.git
cd Agent-Learning-Hub-MiMo
pip install openai python-dotenv prompt_toolkit rich

# 配置 .env
echo 'MIMO_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1' > .env
echo 'MIMO_API_KEY=your-api-key-here' >> .env
echo 'MIMO_MODEL=mimo-v2.5-pro' >> .env

# 运行任意 Stage
python stage-1/minimal_agent.py

# 或使用完整 Harness（推荐）
cd mimo-harness && pip install -e .
mimo-harness   # 进入交互模式
```

## MiMo Harness

基于 Stage 0-8 经验构建的完整 Agent Harness，参考 Claude Code 架构。

**核心特性**：
- **Agent Loop**: 依赖注入、熔断器、Token 预算、并行工具调度、流式输出
- **14 个工具模块**: 文件操作、Shell、代码执行、Web、文档、数学、笔记本、任务、LSP、调度器、子代理等
- **权限管线**: 6 种模式（DEFAULT/PLAN/AUTO/ACCEPT_EDITS/DONT_ASK/BYPASS），4 阶段管线
- **安全管线**: 2 层防御（regex 预过滤 + 模型分类器），敏感数据脱敏，Prompt injection 检测
- **上下文管理**: 4 级渐进压缩（snip → microcompact → LLM 压缩 → 激进截断），200K token 窗口
- **记忆系统**: 4 类型（user/feedback/project/reference），分层加载，路径作用域规则
- **会话管理**: JSONL 自动保存、检查点回滚、会话分叉、命名会话
- **Hook 系统**: 18 种生命周期事件，命令/HTTP/Prompt 三种 handler
- **SubAgent**: 并行/Pipeline 执行，资源限制，消息通道
- **CLI**: 25+ 斜杠命令、管道输入、多输出格式

详见 [mimo-harness/README.md](mimo-harness/README.md)。

## 测试状态

| 测试类型 | 数量 | 耗时 |
|---------|------|------|
| 单元测试 | 760 | ~9min |
| E2E fast | 34 | ~10min |
| E2E slow | 12 | ~6.5min |
| Stage 测试 | 67 (50 unit + 17 E2E) | ~3min |
| **总计** | **806+** | **~29min** |

所有测试通过，覆盖安全、权限、上下文、工具、CLI、Hook、设置、会话等模块。

## CI/CD

GitHub Actions 自动化测试：

- **unit-tests**: push/PR 自动运行，Python 3.10-3.13 矩阵，覆盖全部单元测试
- **e2e-fast**: 仅手动触发（`workflow_dispatch` + `run_e2e=fast/all`），34 个快速 E2E 测试（~10min）
- **e2e-full**: 仅手动触发（`workflow_dispatch` + `run_e2e=all`），12 个慢速 E2E 测试（~20min）

默认 push/PR 只运行单元测试，E2E 测试需手动触发以避免 API 消耗。

## License

MIT License. See [LICENSE](LICENSE) for details.
