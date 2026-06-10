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
pip install openai python-dotenv prompt_toolkit rich textual

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
- **Agent Loop**: 依赖注入、熔断器、Token 预算、并行工具调度、流式输出、_StreamReader per-chunk 120s 超时、retry_with_backoff
- **30 个工具 / 14 个模块**: 文件操作(6)、Shell、代码执行、Web(2)、文档(2)、数学、笔记本、任务(5)、LSP(3)、调度器(3)、计划(2)、监控(3)、交互(2)、子代理
- **权限管线**: 6 种模式（DEFAULT/PLAN/AUTO/ACCEPT_EDITS/DONT_ASK/BYPASS），4 阶段管线，TUI 内联提示
- **安全管线**: 2 层防御（regex 预过滤 + 模型分类器），敏感数据脱敏，Prompt injection 检测，自审机制
- **上下文管理**: 1M token 窗口，4 级渐进压缩（snip → microcompact → LLM 压缩 → 截断），85% 预警，用户手动 `/compact`
- **记忆系统**: 4 类型（user/feedback/project/reference），分层加载，路径作用域规则，CLAUDE.md 发现
- **会话管理**: JSONL 自动保存、检查点回滚、会话分叉、命名会话、自动清理
- **Hook 系统**: 18 种生命周期事件，命令/HTTP/Prompt 三种 handler，SSRF 防护
- **SubAgent**: 并行/Pipeline 执行，资源限制（token/时间/数量），消息通道，优先级调度
- **Skills 系统**: SKILL.md 文件格式、YAML frontmatter、动态上下文注入（!`command`）、参数替换（$ARGUMENTS）、个人/项目级 skills 目录、`/skill-name` 调用
- **MCP 支持**: Model Context Protocol 集成、多种传输协议（stdio/HTTP/SSE/WebSocket）、工具发现和注册、OAuth 认证、资源引用（@server:protocol://resource）
- **TUI**: 全屏 Textual 界面，队列输出架构（无死锁），8 个 override 回调，builtins.print 拦截，底部固定输入，Tab 补全，输入历史，内联权限提示，Ctrl+K 强制终止，实时状态栏
- **CLI**: 30+ 斜杠命令 + `!` shell、管道输入、多输出格式（text/json/stream-json）

详见 [mimo-harness/README.md](mimo-harness/README.md)。

## 测试状态

| 测试类型 | 数量 | 耗时 |
|---------|------|------|
| 单元测试 | ~823 | ~10min |
| E2E fast | 34 | ~10min |
| E2E slow | 12 | ~6.5min |
| Stage 测试 | 83 (58 unit + 25 E2E) | ~3min |
| **总计** | **~907** | **~30min** |

26 个测试文件，覆盖安全、权限、上下文、工具、CLI、TUI、Hook、设置、会话、SubAgent、Token 计数器、压力/边界测试、Skills、MCP。

## CI/CD

GitHub Actions 自动化测试：

- **unit-tests**: push/PR 自动运行，Python 3.10-3.13 矩阵，覆盖全部单元测试
- **e2e-fast**: 仅手动触发（`workflow_dispatch` + `run_e2e=fast/all`），34 个快速 E2E 测试（~10min）
- **e2e-full**: 仅手动触发（`workflow_dispatch` + `run_e2e=all`），12 个慢速 E2E 测试（~20min）

默认 push/PR 只运行单元测试，E2E 测试需手动触发以避免 API 消耗。

## License

MIT License. See [LICENSE](LICENSE) for details.
