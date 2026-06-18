# Agent Hub

基于 Claude Code 架构的生产级模型无关 AI Agent Harness。

版本：`0.4.0` | Python：`>=3.10` | License：MIT

## 核心特性

- **Agent Loop**: 依赖注入、熔断器（CircuitBreaker）、Token 预算、并行工具调度、流式输出、指数退避重试、优雅中断
- **33 个工具**（14 个模块）: 文件操作、Shell、代码执行、Web 搜索/抓取、文档创建、数学计算、笔记本编辑、任务管理、LSP 集成、调度器、计划模式、进程监控、交互提示、子代理
- **权限管线**: 6 种模式（DEFAULT/PLAN/AUTO/ACCEPT_EDITS/DONT_ASK/BYPASS），4 阶段管线（验证→规则匹配→上下文评估→用户提示），规则优先级 deny > ask > allow
- **安全管线**: 2 层防御（regex 预过滤 + 模型分类器），敏感数据自动脱敏，提示注入检测
- **上下文管理**: 1M token 窗口，4 级渐进压缩（snip → microcompact → collapse → autocompact），85% 阈值触发
- **记忆系统**: 4 类型记忆（user/feedback/project/reference），MEMORY.md 索引，YAML frontmatter 格式
- **会话管理**: JSONL 自动保存、检查点回滚、会话分叉、会话恢复、自动清理
- **Hook 系统**: 18 种生命周期事件，3 种 Hook 类型（command/HTTP/prompt），优先级排序，超时管理
- **SubAgent**: 并行/Pipeline 执行，生命周期管理，资源限制（最大步数/时长/token）
- **Skills**: SKILL.md 格式、动态上下文注入、参数替换、GitHub URL 安装
- **MCP**: Model Context Protocol 集成，多协议支持（stdio/HTTP/SSE/WebSocket），OAuth 认证
- **TUI**: 全屏 Textual 界面，固定输入区 + 滚动输出，队列架构，斜杠命令自动补全
- **CLI**: 34 个斜杠命令，管道输入，3 种输出格式（text/json/stream-json），配置热重载
- **自定义智能体**: YAML frontmatter 定义，项目级/用户级，6 个预设模板（code-reviewer/researcher/debugger/writer/tester/planner）
- **后台任务**: 异步执行、状态跟踪、取消、自动清理
- **@文件引用**: `@file`、`@folder/`、`@*.ext` 语法，自动注入上下文，路径遍历保护
- **目标管理**: `/goal` 设置完成条件，自动评估，持续工作直到满足
- **设置层级**: 4 级配置（managed → user → project → local），deny 规则不可覆盖
- **显示层**: Rich 终端输出，对话气泡、代码语法高亮、工具调用可折叠展示、状态栏、Unicode/ASCII 自动降级

## 快速开始

```bash
pip install -e .
cp .env.example .env  # 配置 API key
ah                   # 交互模式（TUI）
```

## 环境变量

在 `agent-hub/.env` 中配置：

```
MIMO_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1
MIMO_API_KEY=your-api-key-here
MIMO_MODEL=mimo-v2.5-pro
```

## 常用命令

```bash
ah                                  # 交互 TUI 模式
ah --task "问题"                    # 单次任务
cat file | ah -p "分析"             # 管道输入
ah --continue                       # 恢复最近会话
ah --resume                         # 选择会话恢复
ah --effort high                    # 高推理力度
ah --plan                           # 只读计划模式
ah --auto-approve                   # 自动批准写操作
ah --bare                           # 跳过记忆加载
ah --output-format json             # JSON 输出
ah --output-format stream-json      # 流式 JSON 输出
```

## 斜杠命令

| 命令 | 说明 |
|------|------|
| `/help` | 帮助 |
| `/tools` | 列出工具 |
| `/compact` | 压缩上下文 |
| `/context` | 逐消息 token 分解 |
| `/stats` | 会话统计 |
| `/tokens` | Token 使用量 |
| `/rewind` | 回退检查点 |
| `/fork` | 分叉会话 |
| `/clear` | 清除会话消息 |
| `/save <path>` | 保存会话到文件 |
| `/load <path>` | 从文件加载会话 |
| `/effort <low\|medium\|high>` | 设置推理力度 |
| `/mode <default\|plan>` | 切换权限模式 |
| `/dry-run` | 切换干运行模式 |
| `/auto` | 切换自动批准 |
| `/plan` | 切换计划模式 |
| `/abort` | 中止当前任务 |
| `/memory` | 列出记忆 |
| `/remember` | 保存新记忆 |
| `/hooks` | 列出 Hook |
| `/init` | 生成 AGENTS.md |
| `/subagents` | 列出活跃子代理 |
| `/subagent <task>` | 运行单个子代理 |
| `/parallel <t1> \| <t2>` | 并行运行任务 |
| `/pipeline <t1> \| <t2>` | 流水线运行任务 |
| `/agents list\|create\|show\|delete` | 自定义智能体管理 |
| `/tasks list\|show\|cancel\|cleanup` | 后台任务管理 |
| `/goal <condition>` | 设置目标条件 |
| `/skills` | 查看/安装 Skills |
| `/mcp` | MCP 服务器管理 |
| `/btw` | 注入运行中指导 |
| `@file` | 引用文件内容 |
| `!<cmd>` | 执行 shell |
| `/quit`, `/exit`, `/q` | 退出 |

## 架构

```
agent_hub/
├── agent.py              # 核心循环（AgentHub、AgentDeps、CircuitBreaker、TokenBudget）
├── cli.py                # REPL 入口、斜杠命令处理
├── context.py            # 会话管理 + 渐进压缩
├── permissions.py        # 4 阶段权限管线
├── security_pipeline.py  # 2 层安全防御
├── memory.py             # 4 类型记忆系统
├── hooks.py              # 18 种生命周期 Hook
├── subagent.py           # SubAgent 生命周期管理
├── skills.py             # Skills 系统
├── mcp.py                # MCP 支持
├── tui.py                # 全屏 TUI 界面
├── display.py            # 显示层（Rich 输出、对话气泡、语法高亮）
├── commands.py           # 命令定义（单一来源）
├── agents.py             # 自定义智能体（YAML frontmatter）
├── background_tasks.py   # 后台任务管理
├── file_references.py    # @文件引用
├── goal.py               # 目标管理
├── settings.py           # 4 级层级设置
├── config.py             # 配置加载
├── token_counter.py      # tiktoken 精确计数
├── project_scanner.py    # 项目分析 + AGENTS.md 生成
├── input_utils.py        # prompt_toolkit 集成
├── logging_utils.py      # 结构化追踪日志
└── tools/                # 14 个工具模块
    ├── file_ops.py       # read_file, write_file, edit_file, glob_files, grep_files
    ├── shell.py          # run_command（后台任务支持、只读自动检测）
    ├── code_exec.py      # execute_python
    ├── web_tools.py      # web_search, web_fetch（SSRF 防护、响应缓存）
    ├── doc_tools.py      # 文档创建
    ├── math_tools.py     # 数学计算
    ├── interactive.py    # 交互提示
    ├── monitor.py        # 进程监控
    ├── notebook_tools.py # Jupyter 笔记本编辑
    ├── task_tools.py     # 任务管理
    ├── plan_tools.py     # 计划模式
    ├── lsp_tools.py      # LSP 集成
    ├── scheduler_tools.py # Cron 调度器
    ├── subagent_tools.py # 子代理工具
    └── registry.py       # 工具注册 + 分发
```

## 测试

```bash
pip install -e ".[dev]"
python -m pytest tests/ --ignore=tests/test_e2e.py -v  # 单元测试（1057 个）
python -m pytest tests/test_e2e.py -v                    # E2E fast（57 个）
python -m pytest tests/test_e2e.py -v --run-slow         # E2E fast + slow（73 个）
python run_tests.py --all                                 # 全部
```

**测试分层**：
- `fast`：无 API 调用，mock 驱动，每个 <1s（默认运行）
- `slow`：真实 API 调用，网络依赖，可能需要几分钟
- `e2e`：端到端测试，真实 API + 真实工具

## Python API

```python
from agent_hub import AgentHub, Session

harness = AgentHub(model="mimo-v2.5-pro", auto_approve=True)
session = Session(session_id="test")
result = harness.run("What is 2+2?", session=session)

# 子代理
result = harness.run_subagent("Analyze codebase")
results = harness.run_parallel_subagents(["Task 1", "Task 2"])
results = harness.run_pipeline_subagents([{"task": "Research"}, {"task": "Write"}])
```

## 配置文件

| 文件 | 位置 | 说明 |
|------|------|------|
| `.env` | agent-hub/ | API 凭据 |
| `.mimo/config.json` | 项目根 | 运行时配置 |
| `.mimo/permissions.json` | 项目根 | 权限规则 |
| `.mimo/settings.json` | 项目根 | 项目级设置 |
| `.mimo/settings.local.json` | 项目根 | 本地设置（gitignore） |
| `.mimo/managed.json` | 项目根 | 企业级设置（不可覆盖） |
| `~/.mimo/settings.json` | 用户目录 | 用户级设置 |
| `~/.mimo/sessions/*.jsonl` | 用户目录 | 会话存储 |
| `~/.mimo/skills/*/SKILL.md` | 用户目录 | 已安装 Skills |
| `~/.mimo/agents/*.md` | 用户目录 | 自定义智能体 |

## 设计模式

本项目采用 Claude Code 架构的 20 种设计模式：

1. **依赖注入** — `AgentDeps` 注入 LLM 客户端工厂、UUID 生成器、重试参数
2. **熔断器** — `CircuitBreaker` 连续 N 次错误后停止（默认 3）
3. **状态机** — `TerminationReason` 枚举，7 种终止路径
4. **Fail-Closed 默认** — 工具必须显式声明安全性
5. **4 阶段权限管线** — 验证→规则匹配→上下文评估→用户提示
6. **渐进压缩** — 4 级压缩，85% 阈值触发
7. **类型化记忆** — 4 类型 + YAML frontmatter + MEMORY.md 索引
8. **Hook 生命周期** — 18 事件 × 3 类型
9. **会话作用域状态** — `contextvars` 防止跨 SubAgent 污染
10. **指数退避重试** — HTTP 429/500/502/503/504 + 网络错误
11. **流式分块超时** — `_StreamReader` 后台线程，120s 分块超时
12. **优雅中断** — `GracefulAbort` 使用 `threading.Event` 协作取消
13. **并发工具执行** — `is_concurrency_safe=True` 的工具通过 `ThreadPoolExecutor` 并行
14. **磁盘溢出** — 超过 10K token 的工具结果溢出到 `.mimo/outputs/`
15. **配置热重载** — `ConfigWatcher` 监控 `.mimo/config.json` 变更
16. **层级设置** — 4 级配置，deny 规则累积不可覆盖
17. **2 层安全防御** — regex 预过滤 + 模型分类器
18. **合成响应对象** — `_AttrBag` 替代 `MagicMock` 构建流式响应
19. **Unicode/ASCII 自动降级** — 检测终端编码支持，自动切换
20. **磁盘溢出阈值** — SPILL_THRESHOLD_TOKENS=10000，MAX_RESULT_TOKENS=25000

## License

MIT License
