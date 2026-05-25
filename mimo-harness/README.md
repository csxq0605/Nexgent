# MiMo Harness

A production-grade AI agent harness powered by Xiaomi MiMo model, following Claude Code architecture patterns. Provides coding assistance, file management, web search, document creation, and more.

> Part of the [Agent Learning Hub](https://github.com/datawhalechina/Agent-Learning-Hub) project.

## Features

- **Agent Loop**: Dependency injection, circuit breaker, token budget tracking, 7 termination reasons, parallel tool dispatch, streaming responses
- **Tool System**: 15 tools with concurrency-safe/unsafe markers, input validation, result budget management, background execution
- **Permission Pipeline**: 4-stage pipeline (validate → rules → context → prompt), plan mode, rule-based matching, path-scoped rules
- **Context Management**: LLM-based semantic compression (summarize old messages), fallback to progressive truncation (snip → microcompact → orphan filter)
- **Memory System**: 4 typed memories (user/feedback/project/reference), MEMORY.md index, path security
- **Project Init**: `/init` command scans project and generates AGENTS.md with language/framework/tool detection
- **Hook System**: Lifecycle events (PreToolUse, PostToolUse, Stop), command/function hooks, matcher patterns
- **CLI**: Interactive REPL with /plan, /memory, /hooks, /stats, /init commands, config file support

## Quick Start

```bash
# 1. Install
cd mimo-harness
pip install -e .

# 2. Configure API
cp .env.example .env
# Edit .env with your MiMo API key

# 3. Run
mimo-harness --task "What is 247 * 893?"
mimo-harness  # Interactive mode
```

## Usage

### Single Task
```bash
mimo-harness --task "Create a Python script that generates fibonacci numbers"
mimo-harness --task "Search the web for latest AI news"
mimo-harness --task "Read the README.md and summarize it"
```

### Interactive Mode
```bash
mimo-harness
# Prompt shows real-time token usage:
# You [5.4K/200.0K]: ████---------------------------------------- 2.7%

# or with options:
mimo-harness --auto-approve   # Skip confirmation prompts
mimo-harness --dry-run        # Show actions without executing
mimo-harness --plan           # Read-only mode (no writes)
mimo-harness --verbose        # Show trace logs
mimo-harness -c config.json   # Load configuration file
```

### Commands (Interactive Mode)
| Command | Description |
|---------|-------------|
| `/help` | Show help |
| `/quit` | Exit |
| `/clear` | Clear conversation |
| `/tools` | List available tools with markers |
| `/save <path>` | Save session |
| `/load <path>` | Load session |
| `/dry-run` | Toggle dry-run mode |
| `/auto` | Toggle auto-approve mode |
| `/plan` | Toggle plan mode (read-only) |
| `/memory` | List stored memories |
| `/remember` | Save context as memory |
| `/hooks` | List registered hooks |
| `/stats` | Show session statistics |
| `/tokens` | Show current token usage with progress bar |
| `/compact` | Manually compress conversation context |
| `/init` | Scan project and generate AGENTS.md |

## Architecture

```
mimo_harness/
├── agent.py          # Core loop: DI, circuit breaker, token budget
├── cli.py            # Interactive REPL and single-shot modes
├── config.py         # Environment configuration (lazy API key)
├── context.py        # Progressive compression, session management
├── hooks.py          # Lifecycle events, command/function hooks
├── logging_utils.py  # Structured logging with trace IDs
├── memory.py         # Typed memory system (user/feedback/project/reference)
├── permissions.py    # 4-stage pipeline, rule matching, plan mode
├── project_scanner.py # /init: detect language/framework/tools, generate AGENTS.md
└── tools/
    ├── registry.py   # Tool registration, validation, dispatch
    ├── file_ops.py   # File read/write/edit/glob/grep
    ├── shell.py      # Shell command execution
    ├── code_exec.py  # Python code execution
    ├── web_tools.py  # Web search & fetch (SSRF protection)
    ├── doc_tools.py  # Document creation
    └── math_tools.py # Safe math evaluation (AST-based)
```

### Agent Loop (Ch2: Dialog Loop)
```
User Task → System Prompt + Context → LLM (MiMo)
    ↓
Tool Call? → Permission Pipeline → Execute → Feed Result Back → Loop
    ↓                                    ↓
No Tool Call → Final Response      Circuit Breaker / Token Budget
```

### Permission Pipeline (Ch4: 4-Stage)
```
Stage 1: validateInput (parameter validation)
    ↓
Stage 2: Rule matching (deny > ask > allow)
    ↓
Stage 3: Context evaluation (plan mode, tool-specific)
    ↓
Stage 4: Interactive prompt (user confirmation)
```

### Context Compression (Ch7: Token-Based, Claude Code Style)
```
Context Window: 200K tokens (Claude Code standard)
├── Startup reserve:  10K (system prompt + memory + AGENTS.md)
└── Compression trigger: 170K tokens (85% of window)

Compression produces a single summary (~1-10K tokens):
  1. LLM Summarize  — Structured summary of entire conversation (preferred)
  2. Truncation      — System marker + last 2 messages (fallback)

After compression: ~190K tokens available for continued work.
```

### Memory System (Ch6: Four Types)
| Type | Purpose | Example |
|------|---------|---------|
| user | User profile, preferences | "Prefers TypeScript over JavaScript" |
| feedback | Validated practices, corrections | "Always run lint before commit" |
| project | Decisions, deadlines | "Using event-driven architecture" |
| reference | External links, dashboards | "Monitoring at Grafana X" |

## Configuration

### Environment (.env)
```
MIMO_BASE_URL=https://token-plan-cn.xiaomimimo.com/v1
MIMO_API_KEY=your-api-key-here
MIMO_MODEL=mimo-v2.5-pro
```

### Permission Rules (.mimo/permissions.json)
```json
{
  "permissions": {
    "allow": ["read_file", "glob_files", "grep_files", "run_command:git:*"],
    "deny": ["run_command:rm -rf *"],
    "ask": ["write_file", "edit_file"]
  }
}
```

### Hooks (.mimo/config.json)
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "run_command",
        "hooks": [
          {"type": "command", "command": "echo ok", "timeout": 5}
        ]
      }
    ]
  }
}
```

## Tool Markers

Each tool has safety markers (Ch3: fail-closed defaults):
- **RO** (Read-Only): Auto-approved, no side effects
- **CS** (Concurrency-Safe): Can run in parallel with other CS tools
- **DST** (Destructive): Requires explicit confirmation

| Tool | Permission | RO | CS | Description |
|------|-----------|----|----|-------------|
| read_file | READ | ✓ | ✓ | Read file contents with line range |
| write_file | WRITE | | | Write content to file |
| edit_file | WRITE | | | Replace text in file |
| glob_files | READ | ✓ | ✓ | Find files by pattern |
| grep_files | READ | ✓ | ✓ | Search file contents |
| run_command | DYNAMIC | | | Execute shell commands |
| execute_python | WRITE | | | Run Python code |
| web_search | READ | ✓ | ✓ | DuckDuckGo search |
| web_fetch | READ | ✓ | ✓ | Fetch URL content |
| create_doc | WRITE | | | Create markdown/txt |
| create_spreadsheet | WRITE | | | Create CSV |
| calculator | READ | ✓ | | Safe math evaluation |
| ask_user_question | READ | ✓ | | Multi-choice interactive questions |
| monitor_start | WRITE | | | Start background process monitor |
| monitor_stop | WRITE | | | Stop a running monitor |
| monitor_list | READ | ✓ | | List active monitors |

## Testing

```bash
pip install -e ".[dev]"
python -m pytest tests/ -v
```

306 tests across 9 test files:

| Test File | Tests | Coverage |
|-----------|-------|----------|
| test_agent.py | 27 | DI, circuit breaker, token budget, retry, compression, parallel dispatch, streaming, CLAUDE.md survival |
| test_permissions.py | 21 | 4-stage pipeline, rule matching, plan mode, path-scoped rules |
| test_context.py | 42 | Token-based compression, LLM compression, edge cases, session management |
| test_registry.py | 13 | Validation, dispatch, truncation |
| test_hooks.py | 12 | Lifecycle events, command/function hooks |
| test_memory.py | 14 | Typed storage, frontmatter, validation |
| test_tools.py | 31 | File ops, shell, code exec, math, web, interactive, monitor |
| test_stress_boundary.py | 119 | Path traversal, SSRF, shell injection, large input, Unicode, permissions, concurrency, math DoS, context compression, memory boundaries, registry edge cases, background jobs, monitors |
| test_project_scanner.py | 18 | Language/framework detection, AGENTS.md generation |

## Performance

Benchmark results:
- Tool registry: 142K executions/sec
- Permission checks: 67K checks/sec (100 rules)
- Context compaction: 800 messages → 30 in <1ms
- Concurrent tools: 20 parallel in 3ms
- Memory: 30 saves in 151ms, index auto-rebuild

## License

MIT License. See [LICENSE](../LICENSE) for details.
