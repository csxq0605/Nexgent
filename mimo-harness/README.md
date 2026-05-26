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
mimo-harness --task "What is 247 * 893?"
mimo-harness          # Interactive mode
```

## Usage

```bash
# Single task
mimo-harness --task "Create a Python fibonacci script"

# Pipe input
cat error.log | mimo-harness -p "Analyze these errors"

# Interactive mode options
mimo-harness --auto-approve --effort high --bare
mimo-harness --continue   # Resume last session
```

### Commands

`/help` `/quit` `/clear` `/tools` `/memory` `/hooks` `/stats` `/compact` `/context` `/init` `/rewind` `!<cmd>`

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
