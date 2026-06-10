# MiMo Harness

A production-grade AI agent harness powered by Xiaomi MiMo model, following Claude Code architecture patterns.

> Part of the [Agent Learning Hub](https://github.com/datawhalechina/Agent-Learning-Hub) project.

## Features

- **Agent Loop**: Dependency injection, circuit breaker, token budget, parallel tool dispatch, streaming, effort levels, fallback model, graceful abort, _StreamReader with per-chunk 120s timeout
- **30 Tools across 14 Modules**: File ops (6), shell, code execution, web (2), docs (2), math, notebooks, tasks (5), LSP (3), scheduler (3), plan (2), monitor (3), interactive (2), subagent
- **Permission Pipeline**: 6 modes (DEFAULT/PLAN/AUTO/ACCEPT_EDITS/DONT_ASK/BYPASS), 4-stage pipeline, protected paths, symlink resolution, inline TUI prompts
- **Security Pipeline**: 2-layer defense (regex pre-filter + model classifier), sensitive data redaction, prompt injection detection, self-review mechanism
- **Context Management**: 1M token window, 4-level progressive compression (snip → microcompact → LLM semantic → truncation), warning at 85%, user-controlled `/compact`
- **Memory System**: 4 types (user/feedback/project/reference), @import directives, path-scoped rules, tiered loading, CLAUDE.md discovery
- **Session Management**: Auto-save (JSONL), resume, named sessions, session ID validation, checkpoints with rewind, fork, auto-cleanup
- **Settings Hierarchy**: 4-level config (managed → user → project → local), config hot-reload via ConfigWatcher
- **Hook System**: 18 lifecycle events, command/HTTP/prompt hooks, async fire-and-forget, SSRF protection on HTTP hooks
- **SubAgent System**: Parallel/Pipeline execution, resource limits (tokens/time/count), message channels, priority scheduling
- **Token Counter**: tiktoken precise counting with heuristic fallback, streaming accumulator, per-session stats
- **Display**: Structured CLI with Unicode/ASCII fallback, conversation bubbles, code syntax highlighting, spinner, status bar, collapsible tool calls, rich tables/panels
- **TUI**: Full-screen Textual interface with queue-based output (no deadlock), override callbacks for all display functions, builtins.print interception, fixed bottom input, scrolling output, tab completion, input history, inline permission prompts, Ctrl+K force-kill, real-time status bar
- **CLI**: Interactive REPL, pipe input, output formats (text/json/stream-json), streaming default ON, `!command`, 28 slash commands

## Quick Start

```bash
cd mimo-harness
pip install -e .
cp .env.example .env  # Edit with your API key

# 配置 .env 文件
# MIMO_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1
# MIMO_API_KEY=your-api-key-here
# MIMO_MODEL=mimo-v2.5-pro

mimo-harness          # 进入交互模式（自动启动 TUI）
```

## Usage

### 交互模式（推荐）

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

> 列出当前目录所有 Python 文件
# Agent 调用 glob_files 搜索

> 帮我创建一个 Jupyter notebook，写个数据分析模板
# Agent 调用 notebook_edit 创建 notebook

> 给我三个选项让我选下一步方向
# Agent 调用 ask_user_question 交互式提问

> /context   # 查看每条消息的 token 明细，找出最占 token 的消息
> /rewind    # 回退到上一个检查点，撤销 Agent 的文件修改
> /compact   # 手动压缩上下文（LLM 语义摘要），释放 token 空间
> !git diff  # 直接执行 shell 命令，查看代码变更
> /fork      # 分叉当前会话，创建新的 session ID
```

### TUI 快捷键

| 快捷键 | 说明 |
|--------|------|
| `Ctrl+C` | 优雅中止当前任务（如果在运行）或退出 |
| `Ctrl+K` | 强制终止卡住的 agent 线程 |
| `Escape` | 保存并退出 |
| `Up/Down` | 浏览输入历史 |
| `Tab` | 斜杠命令补全（循环匹配） |

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
| `/compact` | 手动压缩上下文（直接 LLM 摘要） |
| `/context` | 按消息显示 token 明细，标记最占 token 的消息 |
| `/init` | 扫描项目并生成 AGENTS.md |
| `/rewind` | 回退到上一个文件检查点（支持批量恢复） |
| `/fork` | 分叉当前会话（复制为新 session ID） |
| `/subagents` | 列出活跃的 SubAgent |
| `/subagent <task>` | 运行单个 SubAgent 任务 |
| `/parallel <t1> \| <t2>` | 并行运行多个任务 |
| `/pipeline <t1> \| <t2>` | Pipeline 模式运行多个任务 |
| `/effort [low\|medium\|high]` | 查看或切换推理强度 |
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
mimo-harness --no-stream                   # 禁用流式输出（默认启用）
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
| `--max-steps` | 最大 Agent 步数（0=无限，默认 0） |
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
├── agent.py              # Core loop, DI, circuit breaker, token budget, streaming, _StreamReader
├── cli.py                # REPL, pipe input, output formats, session resume, 28 commands
├── config.py             # Configuration management, API key validation
├── context.py            # 4-level compression, session management, checkpoints, memory loading
├── hooks.py              # 18 lifecycle events, command/HTTP/prompt hooks
├── logging_utils.py      # Structured logging with trace IDs
├── memory.py             # 4 typed memories, tiered loading, path-scoped rules
├── permissions.py        # 6 modes, 4-stage pipeline, protected paths, TUI callback
├── project_scanner.py    # Project analysis, AGENTS.md generation
├── security_pipeline.py  # 2-layer security (regex + model), sensitive data redaction
├── settings.py           # 4-level settings hierarchy
├── display.py            # Structured CLI display, TUI override callbacks
├── input_utils.py        # Shared prompt_toolkit input with auto-completion and history
├── tui.py                # Full-screen Textual TUI (queue-based, override callbacks, builtins.print)
├── subagent.py           # SubAgent lifecycle, parallel/pipeline execution, message channels
├── token_counter.py      # tiktoken counting, heuristic fallback, streaming accumulator
└── tools/                # 14 modules, 30 registered tools
    ├── code_exec.py      # execute_python — Python code execution in isolated subprocess
    ├── doc_tools.py      # create_doc, create_spreadsheet — Document and CSV creation
    ├── file_ops.py       # read_file, read_files, write_file, edit_file, glob_files, grep_files
    ├── interactive.py    # ask_user_question, read_memory_topic
    ├── lsp_tools.py      # lsp_definition, lsp_references, lsp_diagnostics
    ├── math_tools.py     # calculator — AST-based safe math evaluator
    ├── monitor.py        # monitor_start, monitor_stop, monitor_list
    ├── notebook_tools.py # notebook_edit — Jupyter notebook cell editing
    ├── plan_tools.py     # enter_plan_mode, exit_plan_mode
    ├── registry.py       # Tool registration, validation, 4-stage execution, disk spillover
    ├── scheduler_tools.py # cron_create, cron_delete, cron_list
    ├── shell.py          # run_command — shell execution with read-only auto-detection, env scrubbing
    ├── subagent_tools.py # subagent_run — LLM-driven task delegation to sub-agents
    ├── task_tools.py     # task_create, task_get, task_list, task_update, task_delete
    └── web_tools.py      # web_search, web_fetch — SSRF protection, response caching
```

## Context Management

- **Context Window**: 1,000,000 tokens (1M)
- **Warning Threshold**: 85% (850K tokens) — prints warning, user decides to `/compact`
- **No blocking** — agent never refuses to run, only warns
- **`/compact` command**: directly uses LLM semantic summarization (Level 3)

### 4-Level Progressive Compression

| Level | Method | Cost | Description |
|-------|--------|------|-------------|
| 1 | Snip | Free | Replace old tool results (>20 msgs ago) with `[Old tool result content cleared]` |
| 2 | Microcompact | Free | Keep only recent 5 tool results, clear the rest |
| 3 | LLM Semantic | API call | Full conversation summarization (~500 words max) |
| 4 | Truncation | Free | Keep last 15 messages only |

`/compact` directly invokes Level 3 (LLM summarization). Auto-compression is not triggered — only warnings are shown.

## TUI Architecture

The TUI uses a **queue-based output architecture** with **display override callbacks** to prevent thread deadlocks and ensure all output is captured:

```
Agent Worker Thread          Main Textual Thread
      │                            │
      │  builtins.print ──────────────→ _output_queue.put()
      │  display callbacks ───────────→ _output_queue.put()
      │  _StdoutProxy ────────────────→ _output_queue.put()
      │  (never blocks)            │
      │                            │  _drain_output_queue() ← 50ms timer
      │                            │  (processes ≤100 items/tick)
      ▼                            ▼
  _output_queue  ──────────→  RichLog / Static widgets
```

Key design decisions:
- **Override callbacks**: 7 callbacks in `display.py` (`_tui_stream_token`, `_tui_print`, `_tui_model_output_start/end`, `_tui_tool_call_collapsible/result`, `_tui_write`) intercept all output from agent.py, even when agent.py holds direct function references via `from .display import ...`
- **`builtins.print` replacement**: Catches all `print()` calls from any module, routes to queue based on `end=""` (stream) vs `end="\n"` (write)
- **`_console.file = io.StringIO()`**: Suppresses any direct `_console.print` calls that bypass both callbacks and builtins.print
- **`_StdoutProxy`**: Safety net for any remaining `sys.stdout.write()` calls
- **Permission prompts**: Inline in output area (Y/n via key press), not in input box
- **`Ctrl+K`**: Force-kills stuck agent thread via `PyThreadState_SetAsyncExc`, cleans up orphaned tool_calls
- **Status bar**: Updates every 50ms during agent execution (tokens, messages)
- **Tool call display**: Shows parallel index `[1/N]`, file path, command, error details

## Tool Summary

| Module | Tools | Permission | Description |
|--------|-------|-----------|-------------|
| file_ops | read_file, read_files, write_file, edit_file, glob_files, grep_files | READ/WRITE | File operations with session-scoped state |
| shell | run_command | READ (dynamic) | Shell execution, background jobs, env scrubbing |
| code_exec | execute_python | WRITE | Python code in isolated subprocess |
| web_tools | web_search, web_fetch | READ | SSRF-protected web search and fetch |
| doc_tools | create_doc, create_spreadsheet | WRITE | Document and CSV creation |
| math_tools | calculator | READ | AST-based safe math evaluator |
| interactive | ask_user_question, read_memory_topic | READ | User interaction and memory loading |
| monitor | monitor_start, monitor_stop, monitor_list | READ/WRITE | Background process monitoring |
| notebook_tools | notebook_edit | WRITE | Jupyter notebook cell editing |
| task_tools | task_create, task_get, task_list, task_update, task_delete | READ/WRITE | Task CRUD with dependencies |
| plan_tools | enter_plan_mode, exit_plan_mode | READ | Plan mode management |
| lsp_tools | lsp_definition, lsp_references, lsp_diagnostics | READ | LSP integration with grep fallback |
| scheduler_tools | cron_create, cron_delete, cron_list | READ | Session-scoped cron scheduling |
| subagent_tools | subagent_run | WRITE | LLM-driven task delegation |

## Skills 系统

Skills 是可复用的指令定义，可以扩展 Agent 的能力。创建一个 `SKILL.md` 文件，Agent 会将其添加到工具箱中。

### 目录结构

```
~/.mimo/skills/            # 个人级 skills（所有项目可用）
.mimo/skills/              # 项目级 skills（仅当前项目）
.mimo/commands/            # 兼容旧版 commands
```

### SKILL.md 文件格式

```yaml
---
name: my-skill
description: What this skill does
disable-model-invocation: true
user-invocable: true
allowed-tools: Read Grep
context: fork
agent: Explore
---

Skill instructions here...
```

#### Frontmatter 字段

| 字段 | 说明 |
|------|------|
| `name` | 显示名称 |
| `description` | 技能描述，Agent 用它来决定何时使用 |
| `when_to_use` | 额外的使用场景说明 |
| `argument-hint` | 参数提示 |
| `arguments` | 命名参数列表 |
| `disable-model-invocation` | 设为 `true` 阻止 Agent 自动调用 |
| `user-invocable` | 设为 `false` 隐藏用户调用 |
| `allowed-tools` | 技能激活时允许的工具 |
| `disallowed-tools` | 技能激活时禁止的工具 |
| `model` | 使用的模型 |
| `effort` | 努力级别 |
| `context` | 设为 `fork` 在子代理中运行 |
| `agent` | 子代理类型 |
| `paths` | 限制激活的文件模式 |
| `shell` | Shell 类型（bash 或 powershell） |

### 动态上下文注入

使用 `` !`command` `` 语法在技能加载时执行命令：

```markdown
## Current changes

!`git diff HEAD`

## Environment

```!
node --version
npm --version
```
```

### 参数替换

| 变量 | 说明 |
|------|------|
| `$ARGUMENTS` | 所有参数 |
| `$ARGUMENTS[N]` | 第 N 个参数（0 开始） |
| `$N` | `$ARGUMENTS[N]` 的简写 |
| `${CLAUDE_SESSION_ID}` | 当前会话 ID |
| `${CLAUDE_EFFORT}` | 当前努力级别 |
| `${CLAUDE_SKILL_DIR}` | 技能目录路径 |

### 使用 Skills

```
/skills                      # 列出可用 Skills
/<skill-name> [arguments]    # 调用 Skill
/summarize-changes           # 示例：总结变更
/fix-issue 123               # 示例：修复 issue #123
```

### 示例 Skill

创建文件 `.mimo/skills/code-review/SKILL.md`：

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
4. Verify test coverage
```

## MCP 支持

MCP (Model Context Protocol) 允许连接外部工具和数据源。

### 配置文件

#### 项目级配置（.mimo/mcp.json）

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "node",
      "args": ["@modelcontextprotocol/server-filesystem", "."]
    },
    "github": {
      "type": "stdio",
      "command": "github-mcp-server",
      "args": ["stdio"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  }
}
```

#### 用户级配置（~/.mimo/config.json）

```json
{
  "mcpServers": {
    "global-server": {
      "type": "http",
      "url": "https://mcp.example.com"
    }
  }
}
```

### 传输协议

| 类型 | 说明 | 配置示例 |
|------|------|----------|
| `stdio` | 本地子进程 | `"command": "npx", "args": ["-y", "server"]` |
| `http` | HTTP 远程服务器 | `"url": "https://mcp.example.com/mcp"` |
| `sse` | Server-Sent Events | `"url": "https://mcp.example.com/sse"` |
| `ws` | WebSocket | `"url": "wss://mcp.example.com/socket"` |

### 环境变量扩展

支持 `${VAR}` 和 `${VAR:-default}` 语法：

```json
{
  "command": "${HOME}/server",
  "env": {
    "API_KEY": "${API_KEY:-default-key}"
  }
}
```

### 使用 MCP

```
/mcp                         # 查看服务器状态
/mcp connect <server-name>   # 连接服务器
/mcp disconnect <server-name># 断开服务器
/mcp refresh                 # 刷新配置
```

### 资源引用

使用 `@` 语法引用 MCP 资源：

```
@github:issue://123
@postgres:schema://users
@docs:file://api/authentication
```

### 推荐 MCP 服务器

| 服务器 | 用途 | 安装方式 |
|--------|------|----------|
| `@modelcontextprotocol/server-filesystem` | 文件系统操作 | `npm install -g @modelcontextprotocol/server-filesystem` |
| `github-mcp-server` | GitHub 集成（issues、PRs） | [GitHub Releases](https://github.com/github/github-mcp-server/releases) |
| `@modelcontextprotocol/server-brave-search` | 网页搜索 | `npm install -g @modelcontextprotocol/server-brave-search` |
| `@bytebase/dbhub` | 数据库查询 | `npx -y @bytebase/dbhub --dsn postgresql://...` |

## Testing

```bash
pip install -e ".[dev]"
python -m pytest tests/ -v
```

**测试状态**: 884 tests across 25 test files

25 test files covering:
- **Security**: path traversal, SSRF, shell injection, large input, Unicode, sensitive data redaction, prompt injection detection
- **Permissions**: 6 modes, 4-stage pipeline, protected paths, symlink resolution, rule matching
- **Context**: 4-level compression, parallel dispatch, streaming, thrashing protection, orphan filtering
- **Tools**: file ops, shell, web, docs, math, notebooks, tasks, LSP, plan, scheduler, code execution
- **Display**: banner, step header, tool call display, spinner, status bar, Unicode fallback, conversation bubbles, code blocks, hard-wrap
- **CLI**: interactive REPL, pipe input, output formats, session management, argument parsing, streaming output
- **TUI**: queue-based output, command suggester, stream buffer, class attributes, inline permissions, override callbacks
- **Hooks**: 18 lifecycle events, command/HTTP/prompt hooks, async execution
- **Settings**: 4-level hierarchy, config hot-reload
- **Session**: ID validation, checkpoints, fork, resume, JSONL persistence
- **SubAgent**: lifecycle, parallel execution, pipeline, resource limits, message channels
- **Token Counter**: tiktoken counting, heuristic fallback, streaming accumulator
- **Stress/Boundary**: extreme inputs, concurrent access, resource limits

## License

MIT License. See [LICENSE](../LICENSE) for details.
