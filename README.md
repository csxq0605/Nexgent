# Agent Learning Hub - MiMo

基于 [datawhalechina/Agent-Learning-Hub](https://github.com/datawhalechina/Agent-Learning-Hub) 学习路线，使用小米 MiMo 模型完成 Stage 0-8 全部实践，并构建生产级 Agent Harness。

## 项目简介

本项目是一个完整的 AI Agent 学习与实践项目，包含：

1. **9 个学习阶段（Stage 0-8）**：从理论基础到生产级 DevOps Agent
2. **MiMo Harness**：基于 Claude Code 架构的生产级 Agent 框架
3. **完整测试套件**：900+ 测试用例，覆盖安全、性能、边界场景

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

### Stage 详情

- **Stage 0** (`stage-0/`): 理论学习笔记，理解 Agent 核心概念
- **Stage 1** (`stage-1/minimal_agent.py`): 最小 Agent 实现，展示 tool calling 基础
- **Stage 2** (`stage-2/research_assistant.py`): RAG 研究助手，实现文本检索和记忆系统
- **Stage 3** (`stage-3/harness_demo.py`): Harness 演示，展示工具注册和权限管理
- **Stage 4** (`stage-4/multi_agent_writer.py`): 多 Agent 写作系统，实现 pipeline 协作
- **Stage 5** (`stage-5/code-review-skill/`): Code Review Skill，可复用的代码审查框架
- **Stage 6** (`stage-6/browser_agent.py`): 浏览器自动化 Agent，使用 Playwright
- **Stage 7** (`stage-7/eval_runner.py`): 评估框架，支持多维度测试评判
- **Stage 8** (`stage-8/devops-agent/`): 生产级 DevOps Agent，包含完整日志和监控

## MiMo Harness

基于 Stage 0-8 经验构建的完整 Agent Harness，参考 Claude Code 架构设计。

### 核心特性

| 特性 | 说明 |
|------|------|
| **Agent Loop** | 依赖注入、熔断器、Token 预算、并行工具调度、流式输出 |
| **30 个工具** | 文件操作(6)、Shell、代码执行、Web(2)、文档(2)、数学、笔记本、任务(5)、LSP(3)、调度器(3)、计划(2)、监控(3)、交互(2)、子代理 |
| **权限管线** | 6 种模式（DEFAULT/PLAN/AUTO/ACCEPT_EDITS/DONT_ASK/BYPASS），4 阶段管线 |
| **安全管线** | 2 层防御（regex 预过滤 + 模型分类器），敏感数据脱敏，Prompt injection 检测 |
| **上下文管理** | 1M token 窗口，4 级渐进压缩（snip → microcompact → LLM 压缩 → 截断） |
| **记忆系统** | 4 类型（user/feedback/project/reference），分层加载，CLAUDE.md 发现 |
| **会话管理** | JSONL 自动保存、检查点回滚、会话分叉、命名会话 |
| **Hook 系统** | 18 种生命周期事件，命令/HTTP/Prompt 三种 handler |
| **SubAgent** | 并行/Pipeline 执行，资源限制，消息通道，优先级调度 |
| **Skills 系统** | SKILL.md 文件格式、YAML frontmatter、动态上下文注入 |
| **MCP 支持** | Model Context Protocol 集成、多种传输协议、工具发现 |
| **TUI** | 全屏 Textual 界面，队列输出架构，8 个 override 回调 |
| **CLI** | 30+ 斜杠命令 + `!` shell、管道输入、多输出格式 |

### 架构设计

```
mimo-harness/
├── mimo_harness/
│   ├── agent.py              # 核心循环、DI、熔断器、Token 预算、流式输出
│   ├── cli.py                # REPL、管道输入、输出格式、会话恢复、30+ 命令
│   ├── config.py             # 配置管理、API key 验证
│   ├── context.py            # 4 级压缩、会话管理、检查点、记忆加载
│   ├── hooks.py              # 18 种生命周期事件、命令/HTTP/Prompt hooks
│   ├── logging_utils.py      # 结构化日志、trace ID
│   ├── memory.py             # 4 类型记忆、分层加载、路径作用域规则
│   ├── permissions.py        # 6 种模式、4 阶段管线、保护路径、TUI 回调
│   ├── project_scanner.py    # 项目分析、AGENTS.md 生成
│   ├── security_pipeline.py  # 2 层安全（regex + 模型）、敏感数据脱敏
│   ├── settings.py           # 4 级配置层次、热重载
│   ├── display.py            # 结构化 CLI 显示、TUI 回调
│   ├── input_utils.py        # 共享输入、自动补全、历史
│   ├── tui.py                # 全屏 Textual TUI（队列输出、回调、builtins.print）
│   ├── subagent.py           # SubAgent 生命周期、并行/Pipeline 执行
│   ├── token_counter.py      # tiktoken 计数、启发式回退、流式累加器
│   ├── skills.py             # Skills 系统、SKILL.md 解析、参数替换
│   └── mcp.py                # MCP 支持、多协议连接、工具发现
└── tools/                    # 14 个模块、30 个注册工具
    ├── code_exec.py          # execute_python — Python 代码执行
    ├── doc_tools.py          # create_doc, create_spreadsheet — 文档创建
    ├── file_ops.py           # read_file, write_file, edit_file, glob_files, grep_files
    ├── interactive.py        # ask_user_question, read_memory_topic
    ├── lsp_tools.py          # lsp_definition, lsp_references, lsp_diagnostics
    ├── math_tools.py         # calculator — AST 安全数学求值
    ├── monitor.py            # monitor_start, monitor_stop, monitor_list
    ├── notebook_tools.py     # notebook_edit — Jupyter notebook 编辑
    ├── plan_tools.py         # enter_plan_mode, exit_plan_mode
    ├── registry.py           # 工具注册、验证、4 阶段执行
    ├── scheduler_tools.py    # cron_create, cron_delete, cron_list
    ├── shell.py              # run_command — Shell 执行、环境变量清洗
    ├── subagent_tools.py     # subagent_run — LLM 驱动的任务委派
    ├── task_tools.py         # task_create, task_get, task_list, task_update, task_delete
    └── web_tools.py          # web_search, web_fetch — SSRF 防护、响应缓存
```

## 快速开始

### 安装

```bash
# 克隆仓库
git clone https://github.com/csxq0605/Agent-Learning-Hub-MiMo.git
cd Agent-Learning-Hub-MiMo

# 安装 Harness
cd mimo-harness
pip install -e .

# 配置环境变量
cp .env.example .env
# 编辑 .env 文件，填入你的 API key
```

### 环境变量配置

```bash
# .env 文件
MIMO_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1
MIMO_API_KEY=your-api-key-here
MIMO_MODEL=mimo-v2.5-pro
```

### 运行

```bash
# 交互模式（推荐）
mimo-harness

# 单次任务
mimo-harness --task "What is 247 * 893?"

# 管道输入
cat error.log | mimo-harness -p "分析这些错误"

# 恢复会话
mimo-harness --continue
mimo-harness --resume

# 运行 Stage 示例
python stage-1/minimal_agent.py
python stage-2/research_assistant.py
```

## 使用指南

### 交互模式

```bash
mimo-harness
# Session 4a2f  |  Tokens 5.4K/1.0M  |  Msgs 12

> 读取当前目录的 README.md，帮我总结要点
# Agent 自动调用 read_file 工具读取文件并给出摘要

> 帮我写一个 fibonacci 函数，保存到 fib.py
# Agent 自动调用 write_file 创建文件

> 运行一下看看结果对不对
# Agent 调用 execute_python 执行代码

> 搜索一下 Python 异步编程的最佳实践
# Agent 调用 web_search 搜索并整理结果

> /context   # 查看每条消息的 token 明细
> /compact   # 手动压缩上下文
> /rewind    # 回退到上一个检查点
> !git diff  # 直接执行 shell 命令
```

### TUI 快捷键

| 快捷键 | 说明 |
|--------|------|
| `Ctrl+C` | 优雅中止当前任务或退出 |
| `Ctrl+K` | 强制终止卡住的 agent 线程 |
| `Escape` | 保存并退出 |
| `Up/Down` | 浏览输入历史 |
| `Tab` | 斜杠命令补全 |

### 斜杠命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助信息 |
| `/quit` `/exit` `/q` | 退出 |
| `/clear` | 清空当前会话 |
| `/tools` | 列出所有可用工具 |
| `/save <path>` | 保存会话到文件 |
| `/load <path>` | 从文件加载会话 |
| `/dry-run` | 切换干跑模式 |
| `/auto` | 切换自动审批模式 |
| `/plan` | 切换计划模式 |
| `/abort` | 请求中止当前任务 |
| `/memory` | 列出已存储的记忆 |
| `/remember` | 将当前上下文保存为记忆 |
| `/hooks` | 列出已注册的 Hook |
| `/stats` | 显示会话统计 |
| `/tokens` | 显示 token 用量进度条 |
| `/compact` | 手动压缩上下文 |
| `/context` | 按消息显示 token 明细 |
| `/init` | 扫描项目并生成 AGENTS.md |
| `/rewind` | 回退到上一个文件检查点 |
| `/fork` | 分叉当前会话 |
| `/subagents` | 列出活跃的 SubAgent |
| `/subagent <task>` | 运行单个 SubAgent 任务 |
| `/parallel <t1> \| <t2>` | 并行运行多个任务 |
| `/pipeline <t1> \| <t2>` | Pipeline 模式运行多个任务 |
| `/effort [low\|medium\|high]` | 查看或切换推理强度 |
| `/mode [default\|plan]` | 查看或切换权限模式 |
| `!<cmd>` | 直接执行 shell 命令 |

### CLI 参数

| 参数 | 说明 |
|------|------|
| `--task`, `-t` | 执行单次任务后退出 |
| `--model`, `-m` | 指定模型名称 |
| `--auto-approve`, `-y` | 自动审批所有写操作 |
| `--dry-run` | 干跑模式 |
| `--plan` | 计划模式（只读） |
| `--max-steps` | 最大 Agent 步数 |
| `--verbose`, `-v` | 详细输出 |
| `--no-stream` | 禁用流式输出 |
| `--bare` | 裸模式（跳过记忆加载） |
| `--effort` | 努力级别：low/medium/high |
| `--output-format` | 输出格式：text/json/stream-json |
| `--fallback-model` | 备用模型 |
| `--continue` | 恢复最近一次会话 |
| `--resume` | 列出最近 10 个会话，交互式选择 |
| `--session-id` | 按指定 ID 恢复或创建会话 |
| `--name` | 给当前会话命名 |

## 核心功能详解

### 上下文管理

- **Context Window**: 1,000,000 tokens (1M)
- **Warning Threshold**: 85% (850K tokens)
- **4 级渐进压缩**:

| 级别 | 方法 | 成本 | 说明 |
|------|------|------|------|
| 1 | Snip | 免费 | 替换旧工具结果为摘要 |
| 2 | Microcompact | 免费 | 仅保留最近 5 个工具结果 |
| 3 | LLM Semantic | API 调用 | 完整对话摘要（~500 词） |
| 4 | Truncation | 免费 | 仅保留最后 15 条消息 |

### 权限系统

6 种权限模式，4 阶段管线：

| 模式 | 说明 |
|------|------|
| DEFAULT | 默认模式，需要确认写操作 |
| PLAN | 计划模式，只读操作 |
| AUTO | 自动审批所有写操作 |
| ACCEPT_EDITS | 自动审批文件编辑 |
| DONT_ASK | 不询问，直接执行 |
| BYPASS | 绕过所有权限检查 |

### 安全管线

2 层防御机制：

1. **Regex 预过滤**：检测路径遍历、Shell 注入、敏感数据
2. **模型分类器**：使用 LLM 评估操作安全性

### Skills 系统

可复用的指令定义，扩展 Agent 能力：

```yaml
---
name: code-review
description: Review code changes and suggest improvements
disable-model-invocation: true
allowed-tools: Read Grep
---

## Current changes

!`git diff HEAD`

## Instructions

Review the changes above and:
1. Identify potential bugs
2. Suggest improvements
3. Check for security issues
```

### MCP 支持

Model Context Protocol 集成，连接外部工具和数据源：

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "node",
      "args": ["@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

## 测试

### 测试状态

| 测试类型 | 数量 | 耗时 |
|---------|------|------|
| 单元测试 | ~861 | ~10min |
| E2E fast | 34 | ~10min |
| E2E slow | 12 | ~6.5min |
| Stage 测试 | 83 (58 unit + 25 E2E) | ~3min |
| **总计** | **~950** | **~30min** |

### 运行测试

```bash
cd mimo-harness

# 安装测试依赖
pip install -e ".[dev]"

# 运行单元测试
python -m pytest tests/ --ignore=tests/test_e2e.py -v

# 运行 E2E 测试（需要 API key）
python -m pytest tests/test_e2e.py -m "not slow" -v  # fast 测试
python -m pytest tests/test_e2e.py -m "slow" -v      # slow 测试

# 运行 Stage 测试
cd ..
python -m pytest tests/test_stage_unit.py -v
```

### 测试覆盖

26 个测试文件，覆盖：

- **安全**: 路径遍历、SSRF、Shell 注入、大输入、Unicode、敏感数据脱敏、Prompt injection 检测
- **权限**: 6 种模式、4 阶段管线、保护路径、符号链接解析
- **上下文**: 4 级压缩、并行调度、流式输出、Thrashing 防护
- **工具**: 文件操作、Shell、Web、文档、数学、笔记本、任务、LSP、计划、调度器、代码执行
- **显示**: Banner、步骤头部、工具调用显示、Spinner、状态栏、Unicode 回退、对话气泡、代码块
- **CLI**: 交互式 REPL、管道输入、输出格式、会话管理、参数解析
- **TUI**: 队列输出、命令建议、流缓冲、内联权限、回调
- **Hooks**: 18 种生命周期事件、命令/HTTP/Prompt hooks
- **设置**: 4 级层次、配置热重载
- **会话**: ID 验证、检查点、分叉、恢复、JSONL 持久化
- **SubAgent**: 生命周期、并行执行、Pipeline、资源限制、消息通道
- **Token 计数器**: tiktoken 计数、启发式回退、流式累加器
- **压力/边界**: 极端输入、并发访问、资源限制

## CI/CD

GitHub Actions 自动化测试：

- **unit-tests**: push/PR 自动运行，Python 3.10-3.13 矩阵
- **e2e-fast**: 仅手动触发，34 个快速 E2E 测试（~10min）
- **e2e-full**: 仅手动触发，12 个慢速 E2E 测试（~20min）

默认 push/PR 只运行单元测试，E2E 测试需手动触发以避免 API 消耗。

## 项目结构

```
Agent-Learning-Hub-MiMo/
├── README.md                 # 本文件
├── TODO.md                   # 开发流程和待办事项
├── config.py                 # 全局配置
├── .env.example              # 环境变量示例
├── .github/workflows/        # CI/CD 配置
├── mimo-harness/             # 主项目：Agent Harness
│   ├── README.md             # Harness 详细文档
│   ├── setup.py              # 包配置
│   ├── mimo_harness/         # 源代码
│   └── tests/                # 测试文件
├── stage-0/                  # 理论学习笔记
├── stage-1/                  # 最小 Agent
├── stage-2/                  # RAG 研究助手
├── stage-3/                  # Harness 演示
├── stage-4/                  # 多 Agent 写作系统
├── stage-5/                  # Code Review Skill
├── stage-6/                  # 浏览器自动化 Agent
├── stage-7/                  # 评估框架
├── stage-8/                  # DevOps Agent
└── tests/                    # Stage 测试
```

## 相关资源

- [Agent Learning Hub 学习路线](https://github.com/datawhalechina/Agent-Learning-Hub)
- [小米 MiMo 模型](https://token-plan-cn.xiaomimimo.com)
- [Claude Code 架构参考](https://docs.anthropic.com/claude-code)

## License

MIT License. See [LICENSE](LICENSE) for details.
