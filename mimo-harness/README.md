# MiMo Harness

A production-grade AI agent harness powered by Xiaomi MiMo model, following Claude Code architecture patterns.

> Part of the [Agent Learning Hub](https://github.com/datawhalechina/Agent-Learning-Hub) project.

## Features

- **Agent Loop**: DI, circuit breaker, token budget, parallel tool dispatch, streaming, effort levels
- **22 Tools**: File ops, shell, web, docs, math, notebooks, tasks, LSP, scheduler
- **Permission Pipeline**: 6 modes, 4-stage pipeline, protected paths
- **Context Management**: LLM semantic compression, 200K token window, thrashing protection
- **Memory System**: 4 types (user/feedback/project/reference), @import, path-scoped rules
- **Session Management**: Auto-save (JSONL), resume, named sessions, checkpoints
- **Settings Hierarchy**: 4-level config (managed → user → project → local)
- **Hook System**: 18 lifecycle events, command/function hooks
- **CLI**: Interactive REPL, pipe input, output formats, `!command`, `/context`

## Quick Start

```bash
cd mimo-harness
pip install -e .
cp .env.example .env  # Edit with your API key
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

> /context          # 查看 token 使用明细
> /tools            # 列出所有可用工具
> /memory           # 查看已存储的记忆
> !git status       # 直接执行 shell 命令
> /compact          # 手动压缩上下文
> /rewind           # 回退到上一个检查点
```

### 其他模式

```bash
mimo-harness --task "What is 247 * 893?"   # 单次任务
cat error.log | mimo-harness -p "分析这些错误"  # 管道输入
mimo-harness --continue                    # 恢复上次会话
mimo-harness --auto-approve --effort high  # 自动审批 + 高努力
```

## Architecture

```
mimo_harness/
├── agent.py              # Core loop, DI, circuit breaker, token budget
├── cli.py                # REPL, pipe input, output formats, session resume
├── context.py            # Compression, session management, checkpoints
├── hooks.py              # 18 lifecycle events
├── memory.py             # 4 typed memories
├── permissions.py        # 6 modes, 4-stage pipeline
├── settings.py           # 4-level settings hierarchy
├── security_pipeline.py  # 2-layer security (regex + model)
└── tools/                # 22 tools (file, shell, web, doc, math, monitor, notebook, task, lsp, plan, scheduler)
```

## Testing

```bash
pip install -e ".[dev]"
python -m pytest tests/ -v
```

923 tests across 19 test files. Covers: path traversal, SSRF, shell injection, large input, Unicode, permissions, concurrency, compression, parallel dispatch, streaming, background jobs, CLI, hooks, settings, notebooks, tasks, security pipeline, LSP, plan mode, scheduler.

## License

MIT License. See [LICENSE](../LICENSE) for details.
