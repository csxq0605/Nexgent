# MiMo Harness

A production-grade AI agent harness powered by Xiaomi MiMo model, following Claude Code architecture patterns.

> Part of the [Agent Learning Hub](https://github.com/datawhalechina/Agent-Learning-Hub) project.

## Features

- **Agent Loop**: Dependency injection, circuit breaker, token budget, parallel tool dispatch, streaming, effort levels
- **15 Tool Modules**: File ops, shell, code execution, web, docs, math, notebooks, tasks, LSP, scheduler, plan, monitor, interactive
- **Permission Pipeline**: 6 modes (default/auto_approve/dry_run/plan/hook_blocked/hard_deny), 4-stage pipeline, protected paths
- **Context Management**: LLM semantic compression, 200K token window, thrashing protection, progressive compression
- **Memory System**: 4 types (user/feedback/project/reference), @import directives, path-scoped rules, tiered loading
- **Session Management**: Auto-save (JSONL), resume, named sessions, session ID validation, checkpoints, fork
- **Settings Hierarchy**: 4-level config (managed → user → project → local)
- **Hook System**: 18 lifecycle events, command/function hooks, config hot-reload
- **CLI**: Interactive REPL, pipe input, output formats, `!command`, `/context`, `/rewind`, `/fork`

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
mimo-harness --stream                      # 流式输出 LLM 响应
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
| `--stream`, `-s` | 流式输出 LLM 响应 |
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
├── context.py            # Compression, session management, checkpoints, memory loading
├── hooks.py              # 18 lifecycle events, command/function hooks
├── logging_utils.py      # Structured logging with trace IDs
├── memory.py             # 4 typed memories, tiered loading
├── permissions.py        # 6 modes, 4-stage pipeline, protected paths
├── project_scanner.py    # Project analysis, AGENTS.md generation
├── security_pipeline.py  # 2-layer security (regex + model), action classification
├── settings.py           # 4-level settings hierarchy
└── tools/                # 15 tool modules
    ├── code_exec.py      # Python code execution
    ├── doc_tools.py      # Document creation and editing
    ├── file_ops.py       # File read/write/edit operations
    ├── interactive.py    # User interaction tools (ask, confirm)
    ├── lsp_tools.py      # Language Server Protocol integration
    ├── math_tools.py     # Calculator and math operations
    ├── monitor.py        # Background monitoring and task management
    ├── notebook_tools.py # Jupyter notebook operations
    ├── plan_tools.py     # Plan mode tools
    ├── registry.py       # Tool registration and dispatch
    ├── scheduler_tools.py # Cron-like scheduling
    ├── shell.py          # Shell command execution
    ├── task_tools.py     # Task creation and management
    └── web_tools.py      # Web search and fetch
```

## Testing

```bash
pip install -e ".[dev]"
python -m pytest tests/ -v
```

21 test files covering:
- **Security**: path traversal, SSRF, shell injection, large input, Unicode
- **Permissions**: 6 modes, 4-stage pipeline, protected paths
- **Context**: compression, parallel dispatch, streaming, thrashing protection
- **Tools**: file ops, shell, web, docs, math, notebooks, tasks, LSP, plan, scheduler
- **CLI**: interactive REPL, pipe input, output formats, session management
- **Hooks**: 18 lifecycle events, command/function hooks
- **Settings**: 4-level hierarchy, config hot-reload
- **Session**: ID validation, checkpoints, fork, resume

## License

MIT License. See [LICENSE](../LICENSE) for details.
