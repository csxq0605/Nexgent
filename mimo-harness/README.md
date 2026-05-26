# MiMo Harness

A production-grade AI agent harness powered by Xiaomi MiMo model, following Claude Code architecture patterns.

> Part of the [Agent Learning Hub](https://github.com/datawhalechina/Agent-Learning-Hub) project.

## Features

- **Agent Loop**: Dependency injection, circuit breaker, token budget, parallel tool dispatch, streaming, effort levels
- **Tool System**: 18 tools with concurrency-safe markers, input validation, disk spillover, background execution
- **Permission Pipeline**: 6 modes, 4-stage pipeline, path-scoped rules, protected paths (.git, .env, etc.)
- **Context Management**: LLM-based semantic compression, progressive truncation, instruction preservation
- **Memory System**: 4 typed memories (user/feedback/project/reference), MEMORY.md index, @import syntax
- **Session Management**: Auto-save (JSONL), session resume, named sessions, checkpoint with /rewind
- **Settings Hierarchy**: 4-level config (managed → user → project → local), deny rules accumulate
- **Hook System**: 18 lifecycle events, command/function hooks, matcher patterns
- **CLI**: Interactive REPL with pipe input, output formats, bare mode, `!command` prefix

## Quick Start

```bash
cd mimo-harness
pip install -e .

# Configure API
cp .env.example .env
# Edit .env with your MiMo API key

# Run
mimo-harness --task "What is 247 * 893?"
mimo-harness  # Interactive mode
```

## Usage

```bash
# Single task
mimo-harness --task "Create a Python script that generates fibonacci numbers"

# Pipe input
cat error.log | mimo-harness -p "Analyze these errors and suggest fixes"

# Session resume
mimo-harness --continue       # Resume most recent session
mimo-harness --resume         # Pick a session to resume

# Options
mimo-harness --auto-approve   # Skip confirmation prompts
mimo-harness --plan           # Read-only mode
mimo-harness --bare           # Skip memory loading for speed
mimo-harness --effort high    # High effort
```

See [examples/](examples/) for more usage scenarios.

## Architecture

```
mimo_harness/
├── agent.py          # Core loop: DI, circuit breaker, token budget
├── cli.py            # Interactive REPL, pipe input, session resume
├── config.py         # Environment configuration
├── context.py        # Progressive compression, session, checkpoints
├── hooks.py          # 18 lifecycle events, command/function hooks
├── memory.py         # Typed memory system
├── permissions.py    # 6 modes, 4-stage pipeline, protected paths
├── settings.py       # 4-level settings hierarchy
├── project_scanner.py # /init: detect language/framework, generate AGENTS.md
├── security_pipeline.py # 2-layer security: regex + model classifier
└── tools/
    ├── registry.py   # Tool registration, validation, dispatch
    ├── file_ops.py   # File read/write/edit/glob/grep
    ├── shell.py      # Shell execution, credential scrubbing
    ├── code_exec.py  # Python code execution
    ├── web_tools.py  # Web search & fetch (SSRF protection)
    ├── doc_tools.py  # Document creation
    ├── math_tools.py # Safe math evaluation (AST-based)
    ├── interactive.py # AskUserQuestion tool
    ├── monitor.py    # Background process monitoring
    ├── notebook_tools.py # Jupyter notebook editing
    ├── task_tools.py # Task management
    ├── plan_tools.py # Plan mode workflow
    ├── lsp_tools.py  # LSP integration (definition/references/diagnostics)
    └── scheduler_tools.py # Session-scoped cron scheduling
```

## Testing

```bash
pip install -e ".[dev]"
python -m pytest tests/ -v
```

923 tests across 19 test files, covering security, stress, concurrency, and integration scenarios.

## License

MIT License. See [LICENSE](../LICENSE) for details.
