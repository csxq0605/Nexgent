# MiMo Harness

A production-grade AI agent harness powered by Xiaomi MiMo model, following Claude Code architecture patterns.

> Part of the [Agent Learning Hub](https://github.com/datawhalechina/Agent-Learning-Hub) project.

## Features

- **Agent Loop**: Dependency injection, circuit breaker, token budget, parallel tool dispatch, streaming, effort levels, fallback model, graceful abort
- **14 Tool Modules**: File ops, shell, code execution, web, docs, math, notebooks, tasks, LSP, scheduler, plan, monitor, interactive, subagent
- **Permission Pipeline**: 6 modes (DEFAULT/PLAN/AUTO/ACCEPT_EDITS/DONT_ASK/BYPASS), 4-stage pipeline, protected paths, symlink resolution
- **Security Pipeline**: 2-layer defense (regex pre-filter + model classifier), sensitive data redaction, prompt injection detection, self-review mechanism
- **Context Management**: 4-level progressive compression (snip → microcompact → LLM semantic → aggressive truncation), 200K token window, thrashing protection
- **Memory System**: 4 types (user/feedback/project/reference), @import directives, path-scoped rules, tiered loading, CLAUDE.md discovery
- **Session Management**: Auto-save (JSONL), resume, named sessions, session ID validation, checkpoints with rewind, fork, auto-cleanup
- **Settings Hierarchy**: 4-level config (managed → user → project → local), config hot-reload via ConfigWatcher
- **Hook System**: 18 lifecycle events, command/HTTP/prompt hooks, async fire-and-forget, SSRF protection on HTTP hooks
- **SubAgent System**: Parallel/Pipeline execution, resource limits (tokens/time/count), message channels, priority scheduling
- **Token Counter**: tiktoken precise counting with heuristic fallback, streaming accumulator, per-session stats
- **Display**: Structured CLI with Unicode/ASCII fallback, conversation bubbles, code syntax highlighting, spinner, status bar, collapsible tool calls, rich tables/panels
- **TUI**: Full-screen Textual interface with fixed bottom input, scrolling output, command auto-complete, input history (up/down arrows)
- **CLI**: Interactive REPL, pipe input, output formats (text/json/stream-json), streaming default ON, `!command`, 26 slash commands

## Quick Start

```bash
cd mimo-harness
pip install -e .
cp .env.example .env  # Edit with your API key

# 配置 .env 文件
# MIMO_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1
# MIMO_API_KEY=your-api-key-here
# MIMO_MODEL=mimo-v2.5-pro

mimo-harness          # 进入交互模式
```

## Usage

### 交互模式（推荐）

```bash
mimo-harness
# You [5.4K/200.0K]: ████---------------------------------------- 2.7%

> 读取当前目录的 README.md，帮我总结要点
# Agent 自动调用 read_file 工具读取文件并给出摘要

> 帮我写一个 fibonacci 函数，保存到 fib.py
# Agent 自动调用 write_file 创建文件

> 运行一下看看结果对不对
# Agent 调用 execute_python 执行代码

> 搜索一下 Python 异步编程的最佳实践
# Agent 调用 web_search 搜索并整理结果

> 列出当前目录所有 Python 文件
# Agent 调用 glob_files 搜索

> 帮我创建一个 Jupyter notebook，写个数据分析模板
# Agent 调用 notebook_edit 创建 notebook

> 给我三个选项让我选下一步方向
# Agent 调用 ask_user_question 交互式提问

> /context   # 查看每条消息的 token 明细，找出最占 token 的消息
> /rewind    # 回退到上一个检查点，撤销 Agent 的文件修改
> /compact   # 手动压缩上下文，释放 token 空间
> !git diff  # 直接执行 shell 命令，查看代码变更
> /fork      # 分叉当前会话，创建新的 session ID
```

### 斜杠命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助信息 |
| `/quit` `/exit` `/q` | 退出 |
| `/clear` | 清空当前会话 |
| `/tools` | 列出所有可用工具及标记（RO/CS/DST） |
| `/save <path>` | 保存会话到文件 |
| `/load <path>` | 从文件加载会话 |
| `/dry-run` | 切换干跑模式（只显示不执行） |
| `/auto` | 切换自动审批模式 |
| `/plan` | 切换计划模式（只读，不写文件） |
| `/abort` | 请求中止当前任务（优雅中断） |
| `/memory` | 列出已存储的记忆 |
| `/remember` | 将当前上下文保存为记忆 |
| `/hooks` | 列出已注册的 Hook |
| `/stats` | 显示会话统计（消息数、token、压缩次数、熔断器状态） |
| `/tokens` | 显示 token 用量进度条 |
| `/compact` | 手动压缩上下文 |
| `/context` | 按消息显示 token 明细，标记最占 token 的消息 |
| `/init` | 扫描项目并生成 AGENTS.md |
| `/rewind` | 回退到上一个文件检查点（支持批量恢复） |
| `/fork` | 分叉当前会话（复制为新 session ID） |
| `/subagents` | 列出活跃的 SubAgent |
| `/subagent <task>` | 运行单个 SubAgent 任务 |
| `/parallel <t1> \| <t2>` | 并行运行多个任务 |
| `/pipeline <t1> \| <t2>` | Pipeline 模式运行多个任务 |
| `/effort [low\|medium\high]` | 查看或切换推理强度 |
| `/mode [default\|plan]` | 查看或切换权限模式 |
| `!<cmd>` | 直接执行 shell 命令（如 `!git status`），通过权限系统 |

### 其他模式

```bash
mimo-harness --task "What is 247 * 893?"   # 单次任务
cat error.log | mimo-harness -p "分析这些错误"  # 管道输入
mimo-harness --continue                    # 恢复上次会话
mimo-harness --resume                      # 从列表中选择会话恢复
mimo-harness --session-id my-project       # 按指定 ID 恢复或创建会话
mimo-harness --name "weekly-report"        # 命名当前会话
mimo-harness --auto-approve --effort high  # 自动审批 + 高努力
mimo-harness --no-stream                    # 禁用流式输出（默认启用）
mimo-harness --bare                        # 裸模式（跳过记忆加载）
mimo-harness --fallback-model gpt-4o       # 设置备用模型
```

### 会话管理

会话自动保存到 `~/.mimo/sessions/`（JSONL 格式），支持多种恢复方式（优先级从高到低）：

| 参数 | 说明 |
|------|------|
| `--session-id <id>` | 按指定 ID 恢复或创建会话（仅允许字母、数字、连字符、下划线，最长 64 字符） |
| `--continue` | 恢复最近一次会话 |
| `--resume` | 列出最近 10 个会话，交互式选择 |
| `--name <name>` | 给当前会话命名 |
| `--session-dir <dir>` | 自定义会话存储目录（默认 `~/.mimo/sessions/`） |
| `--cleanup-days <N>` | 自动清理 N 天前的旧会话（默认 30 天） |

损坏的会话文件会自动重命名为 `.jsonl.corrupt`，防止恢复循环。会话元数据（名称、压缩次数等）保存在 JSONL 文件末尾的 `__session_meta__` 消息中。

### 会话检查点

会话支持文件检查点功能（`/rewind` 命令）：
- 编辑/写入文件前自动创建快照
- 支持批量操作的检查点
- 恢复时保留原始路径元数据
- 防止重复恢复同一检查点

### 全部 CLI 参数

| 参数 | 说明 |
|------|------|
| `--task`, `-t` | 执行单次任务后退出 |
| `--model`, `-m` | 指定模型名称（默认：mimo-v2.5-pro） |
| `--auto-approve`, `-y` | 自动审批所有写操作 |
| `--dry-run` | 干跑模式（只显示不执行） |
| `--plan` | 计划模式（只读操作） |
| `--max-steps` | 最大 Agent 步数（默认 20） |
| `--verbose`, `-v` | 详细输出 |
| `--log-file` | 日志文件路径 |
| `--config`, `-c` | 配置文件路径 |
| `--rules`, `-r` | 权限规则文件路径 |
| `--no-stream` | 禁用流式输出（默认启用） |
| `--bare` | 裸模式：跳过记忆加载，使用最小系统提示 |
| `--effort` | 努力级别：low / medium（默认） / high |
| `--output-format` | 输出格式：text（默认） / json / stream-json |
| `--append-system-prompt` | 追加到系统提示的额外文本 |
| `--fallback-model` | 主模型 429/503 时的备用模型 |
| `--session-dir` | 自定义会话存储目录（默认 ~/.mimo/sessions/） |
| `--continue` | 恢复最近一次会话 |
| `--resume` | 列出最近 10 个会话，交互式选择 |
| `--name` | 给当前会话命名 |
| `--session-id` | 按指定 ID 恢复或创建会话（仅字母、数字、连字符、下划线，最长 64 字符） |
| `--cleanup-days` | 自动清理 N 天前的旧会话（默认 30 天） |

## Architecture

```
mimo_harness/
├── agent.py              # Core loop, DI, circuit breaker, token budget, streaming
├── cli.py                # REPL, pipe input, output formats, session resume, commands
├── config.py             # Configuration management, API key validation
├── context.py            # 4-level compression, session management, checkpoints, memory loading
├── hooks.py              # 18 lifecycle events, command/HTTP/prompt hooks
├── logging_utils.py      # Structured logging with trace IDs
├── memory.py             # 4 typed memories, tiered loading, path-scoped rules
├── permissions.py        # 6 modes, 4-stage pipeline, protected paths, symlink resolution
├── project_scanner.py    # Project analysis, AGENTS.md generation
├── security_pipeline.py  # 2-layer security (regex + model), sensitive data redaction
├── settings.py           # 4-level settings hierarchy
├── display.py            # Structured CLI display (banners, spinners, status bar, syntax highlighting)
├── input_utils.py        # Shared prompt_toolkit input with auto-completion and history
├── tui.py                # Full-screen Textual TUI (fixed bottom input, scrolling output)
├── subagent.py           # SubAgent lifecycle, parallel/pipeline execution, message channels
├── token_counter.py      # tiktoken counting, heuristic fallback, streaming accumulator
└── tools/                # 14 tool modules + registry
    ├── code_exec.py      # Python code execution in isolated subprocess
    ├── doc_tools.py      # Document and CSV creation
    ├── file_ops.py       # File read/write/edit, session-scoped state via contextvars
    ├── interactive.py    # User interaction (ask_user_question), memory topic loading
    ├── lsp_tools.py      # LSP integration (definition, references, diagnostics)
    ├── math_tools.py     # AST-based safe math evaluator
    ├── monitor.py        # Background process monitoring
    ├── notebook_tools.py # Jupyter notebook cell editing
    ├── plan_tools.py     # Plan mode (enter/exit with user approval)
    ├── registry.py       # Tool registration, validation, disk spillover
    ├── scheduler_tools.py # Cron-like session-scoped scheduling
    ├── shell.py          # Shell execution with read-only auto-detection, env scrubbing
    ├── subagent_tools.py # LLM-driven task delegation to sub-agents
    ├── task_tools.py     # Task CRUD (create/get/list/update/delete)
    └── web_tools.py      # Web search (DuckDuckGo/Bing) and fetch with SSRF protection
```

## Testing

```bash
pip install -e ".[dev]"
python -m pytest tests/ -v
```

**测试状态**: 760 unit + 46 E2E = 806 tests passed

24 test files covering:
- **Security**: path traversal, SSRF, shell injection, large input, Unicode, sensitive data redaction, prompt injection detection
- **Permissions**: 6 modes, 4-stage pipeline, protected paths, symlink resolution, rule matching
- **Context**: 4-level compression, parallel dispatch, streaming, thrashing protection, orphan filtering
- **Tools**: file ops, shell, web, docs, math, notebooks, tasks, LSP, plan, scheduler, code execution
- **Display**: banner, step header, tool call display, spinner, status bar, Unicode fallback, conversation bubbles, code blocks, hard-wrap
- **CLI**: interactive REPL, pipe input, output formats, session management, argument parsing, streaming output
- **Hooks**: 18 lifecycle events, command/HTTP/prompt hooks, async execution
- **Settings**: 4-level hierarchy, config hot-reload
- **Session**: ID validation, checkpoints, fork, resume, JSONL persistence
- **SubAgent**: lifecycle, parallel execution, pipeline, resource limits, message channels
- **Token Counter**: tiktoken counting, heuristic fallback, streaming accumulator
- **Stress/Boundary**: extreme inputs, concurrent access, resource limits

## License

MIT License. See [LICENSE](../LICENSE) for details.
