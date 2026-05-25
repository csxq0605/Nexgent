# Gap Analysis: MiMo Harness vs Claude Code + Codex CLI

> Comprehensive comparison based on Claude Code official documentation (code.claude.com), OpenAI Codex CLI (developers.openai.com/codex), and deep audit of mimo-harness codebase.

## Executive Summary

MiMo Harness has a solid foundation (11 tools, 4-stage permissions, LLM-based compression, memory system, hooks), but significant gaps exist compared to Claude Code (40+ tools, MCP, sub-agents, streaming, worktrees) and Codex CLI (platform-native sandboxing, image I/O, cloud tasks). This document categorizes gaps by priority and provides an optimization roadmap.

---

## 1. TOOLS GAP

### 1.1 Tools Present in Claude Code but Missing from MiMo Harness

| Priority | Tool | Claude Code Description | MiMo Status |
|----------|------|------------------------|-------------|
| **P0** | `AskUserQuestion` | Multi-choice questions for requirements gathering | **MISSING** — no interactive clarification mechanism |
| **P0** | `EnterPlanMode`/`ExitPlanMode` | Switch to read-only planning mode mid-conversation | **PARTIAL** — `plan_mode` is constructor-only, can't toggle mid-conversation |
| **P0** | `Monitor` | Background process watching, streams output lines as events | **MISSING** |
| **P1** | `NotebookEdit` | Jupyter notebook cell editing (replace/insert/delete) | **MISSING** |
| **P1** | `LSP` | Language server integration (jump-to-def, find references, type errors) | **MISSING** |
| **P1** | `Glob` (enhanced) | `**` recursive, sorted by mtime, 100 cap, `.gitignore` respect | **PARTIAL** — `glob_files` exists but limited |
| **P1** | `Grep` (enhanced) | Context lines (-A/-B/-C), multiline, type filtering, ripgrep-based | **PARTIAL** — `grep_files` exists but no context lines |
| **P1** | `WebSearch` | Anthropic-backed web search with domain filtering | **PARTIAL** — uses DuckDuckGo HTML scraping |
| **P2** | `TaskCreate`/`TaskGet`/`TaskList`/`TaskUpdate` | Persistent task list with dependencies | **MISSING** |
| **P2** | `CronCreate`/`CronDelete`/`CronList` | Session-scoped scheduled tasks | **MISSING** |
| **P2** | `PushNotification` | Desktop/mobile push notifications | **MISSING** |
| **P2** | `PowerShell` | Native PowerShell execution on Windows | **MISSING** — uses Bash only |
| **P3** | `Skill` | Reusable prompt-based workflow execution | **MISSING** |
| **P3** | `SendMessage` | Agent team communication | **MISSING** |

### 1.2 Tools Present in Codex CLI but Missing from MiMo Harness

| Priority | Feature | Codex Description | MiMo Status |
|----------|---------|------------------|-------------|
| **P1** | Image input | Paste/upload images, `-i` flag | **MISSING** |
| **P1** | Web search (cached) | Pre-indexed results, reduced prompt injection | **PARTIAL** — DuckDuckGo scraping is fragile |
| **P2** | `/review` command | Code review against branch/commit/uncommitted | **MISSING** |
| **P2** | Cloud tasks | `codex cloud` for remote execution | **MISSING** (out of scope for local harness) |
| **P3** | Image generation | `gpt-image-2` integration | **MISSING** (model-dependent) |

### 1.3 Tool Quality Gaps

| Tool | Claude Code Feature | MiMo Gap |
|------|-------------------|----------|
| `Edit` | Read-before-edit check, uniqueness enforcement, `replace_all` flag | Simple string replacement, no read-before-edit, no uniqueness check |
| `Bash` | 2-min default timeout, 10-min max, 30K char output cap, `run_in_background`, env persistence | 30s default, 8K output cap, no background execution |
| `Read` | Images, PDFs, Jupyter notebooks, offset/limit pagination | Text only, basic offset/limit |
| `Write` | Read-before-write for existing files | No such check |
| `Grep` | ripgrep-based, multiline, `.gitignore` respect, type filtering | Basic regex, no multiline, no `.gitignore` |
| `Glob` | `.gitignore` respect (configurable), mtime sorting | No `.gitignore` respect |
| `WebFetch` | Markdown conversion, 15-min cache, redirect handling, SSRF protection | HTML-to-text, SSRF protection, no cache |

---

## 2. ARCHITECTURE GAP

### 2.1 Agent Loop

| Feature | Claude Code | Codex CLI | MiMo Harness |
|---------|------------|-----------|--------------|
| Parallel tool dispatch | Yes — concurrent tool calls processed simultaneously | Yes | **NO** — sequential `for tc in tool_calls` loop |
| Streaming responses | Yes — real-time token streaming | Yes | **NO** — waits for full completion |
| Sub-agent delegation | Yes — `Agent` tool spawns sub-agents with own context | Yes — subagents on explicit request | **NO** |
| Max turns control | `--max-turns` flag | Config-based | `max_steps` (20 default) |
| Cost tracking | `--max-budget-usd` | Token usage display | **NO** |
| Session resume | `claude --resume`, `claude -c` | `codex resume` | **PARTIAL** — `/load` from JSON |
| Background sessions | `--bg`, agent view | `codex cloud` | **NO** |
| Fork session | `--fork-session` | N/A | **NO** |

### 2.2 Permission System

| Feature | Claude Code | Codex CLI | MiMo Harness |
|---------|------------|-----------|--------------|
| Permission modes | default, acceptEdits, plan, auto, bypassPermissions | auto, read-only, full-access | DEFAULT, PLAN, AUTO |
| Path-scoped rules | `Read(~/secrets/**)`, `Edit(/src/**)` | Writable roots | **NO** — tool-level only |
| Command patterns | `Bash(npm run *)`, `Bash(git diff *)` | Per-command-prefix rules | **PARTIAL** — `run_command:npm:*` |
| Domain rules | `WebFetch(domain:example.com)` | N/A | **NO** |
| Disallowed tools | `--disallowedTools` | N/A | **NO** — only allow/deny/ask |
| Auto mode classifier | Built-in classifier rules | N/A | **NO** — simple auto-approve |
| Rejection circuit breaker | Yes | N/A | **YES** — 3 rejections → fall through |

### 2.3 Context Management

| Feature | Claude Code | Codex CLI | MiMo Harness |
|---------|------------|-----------|--------------|
| Context window | 200K tokens | Model-dependent | 200K tokens |
| Compression trigger | 85% of window | Summarization | 85% of window |
| LLM-based compression | Yes — structured summary | Yes | **YES** — `llm_compress()` |
| CLAUDE.md survival | Re-read from disk after compact | N/A | **NO** — compressed away |
| `/compact` command | Manual trigger | N/A | **YES** |
| Token display | Real-time in prompt | Token usage display | **YES** — `[X.XK/200.0K]` |
| Session persistence | Auto-save, resume | Local session storage | Manual `/save`/`/load` |

### 2.4 Memory System

| Feature | Claude Code | Codex CLI | MiMo Harness |
|---------|------------|-----------|--------------|
| CLAUDE.md hierarchy | Managed → User → Project → Local | AGENTS.md | **PARTIAL** — flat loading |
| Auto memory | 4 types, auto-saved by Claude | N/A | **YES** — 4 types |
| Path-scoped rules | `.claude/rules/*.md` with `paths` frontmatter | Rules with per-command-prefix | **NO** |
| `@import` syntax | Import files into CLAUDE.md | N/A | **NO** |
| Memory toggle | `/memory` to enable/disable | N/A | **NO** |
| Memory validation | Stale date detection, missing refs | N/A | **YES** |

### 2.5 Hooks System

| Feature | Claude Code | Codex CLI | MiMo Harness |
|---------|------------|-----------|--------------|
| Lifecycle events | PreToolUse, PostToolUse, Stop, SessionStart, SessionEnd, etc. | N/A | PreToolUse, PostToolUse, Stop + 4 more |
| Matcher patterns | `Bash(npm *)`, `Edit(src/**)` | N/A | **PARTIAL** — exact/wildcard only |
| `if` conditions | Filter by tool name + arguments | N/A | **NO** |
| Priority ordering | userSettings > projectSettings > localSettings | N/A | **DOCUMENTED but not implemented** |
| Async hooks | Yes | N/A | **YES** — `async_mode` flag |
| Setup hooks | `--init`, `--maintenance` matchers | N/A | **NO** |

---

## 3. CLI GAP

| Feature | Claude Code | Codex CLI | MiMo Harness |
|---------|------------|-----------|--------------|
| Pipe input | `cat file \| claude -p "query"` | stdin support | **NO** |
| Session resume | `claude -c`, `claude -r "name"` | `codex resume --last` | **NO** |
| Named sessions | `--name`, `/rename` | N/A | **NO** |
| Output formats | text, json, stream-json | stdout | text only |
| `--bare` mode | Skip auto-discovery for speed | N/A | **NO** |
| `--append-system-prompt` | Append to default prompt | N/A | **NO** |
| `--fallback-model` | Auto-fallback on overload | N/A | **NO** |
| `--effort` level | low/medium/high/xhigh/max | N/A | **NO** |
| Shell completions | bash/zsh/fish | bash/zsh/fish | **NO** |
| `@file` fuzzy search | N/A | `@` triggers file search | **NO** |
| `!command` prefix | N/A | Run shell inline | **NO** |
| Theme support | N/A | `/theme` | **NO** |
| Prompt history | N/A | Ctrl+R search | **NO** |

---

## 4. TESTING GAP

| Area | Current Coverage | Gap |
|------|-----------------|-----|
| CLI (`cli.py`) | **0 tests** | No REPL command tests, no arg parsing tests, no config loading |
| Logging (`logging_utils.py`) | **0 tests** | TraceLogger completely untested |
| Hook command execution | Function hooks only | `_run_command_hook()` with subprocess not tested |
| Agent `run()` integration | Mocked LLM only | No test exercising real tool dispatch |
| Dynamic shell permission | Not tested | `_check_shell_permission()` untested |
| Session persistence | Basic save/load | No corrupt JSON test, no missing fields test |
| Config file loading | Not tested | `_load_config()` untested |
| System prompt caching | Not tested | Cache behavior untested |
| Web tools | URL validation only | Actual `web_search()`/`web_fetch()` not tested |
| Doc tools | Basic only | `create_spreadsheet` with dict/list rows not tested |

---

## 5. OPTIMIZATION PLAN

### Phase 1: Critical Tools & Architecture (P0)

1. **Parallel tool dispatch** — Use `is_concurrency_safe` markers, `concurrent.futures.ThreadPoolExecutor`
2. **Streaming responses** — Use `stream=True` in OpenAI API, yield tokens as they arrive
3. **`AskUserQuestion` tool** — Multi-choice interactive clarification
4. **`Monitor` tool** — Background process watching with event streaming
5. **Enhanced `Edit` tool** — Read-before-edit check, uniqueness enforcement, `replace_all`
6. **`EnterPlanMode`/`ExitPlanMode`** — Mid-conversation plan mode switching

### Phase 2: Tool Enhancements (P1)

7. **Enhanced `Grep`** — Context lines (-A/-B/-C), multiline, type filtering
8. **Enhanced `Glob`** — `.gitignore` respect, mtime sorting
9. **Enhanced `Bash`** — `run_in_background`, 10-min timeout, 30K output cap
10. **Enhanced `Read`** — Image support, PDF support
11. **`NotebookEdit` tool** — Jupyter notebook cell editing
12. **`LSP` tool** — Language server integration
13. **Path-scoped permission rules** — `Read(~/secrets/**)`, `Edit(/src/**)`
14. **Domain-scoped rules** — `WebFetch(domain:example.com)`

### Phase 3: CLI & UX (P2)

15. **Pipe input** — `cat file | mimo-harness -p "query"`
16. **Session resume** — `mimo-harness --resume`, `mimo-harness -c`
17. **Named sessions** — `--name` flag
18. **Output formats** — text, json, stream-json
19. **Shell completions** — bash/zsh/fish/PowerShell
20. **`--append-system-prompt`** — Append to default prompt
21. **`--fallback-model`** — Auto-fallback on overload
22. **Task management** — TaskCreate/TaskGet/TaskList/TaskUpdate

### Phase 4: Advanced Features (P2-P3)

23. **Sub-agent delegation** — `Agent` tool for spawning sub-agents
24. **MCP support** — Model Context Protocol server integration
25. **Skill system** — Reusable prompt-based workflows
26. **Path-scoped memory rules** — `.mimo/rules/*.md` with path frontmatter
27. **CLAUDE.md survival after compact** — Re-read from disk
28. **Hook `if` conditions** — Filter by tool name + arguments
29. **Hook priority ordering** — Implement documented priority system
30. **Cost tracking** — Token usage per session, budget limits

### Phase 5: Testing & Quality

31. **CLI tests** — REPL commands, arg parsing, config loading
32. **Logging tests** — TraceLogger methods
33. **Integration tests** — Agent run() with real tool dispatch
34. **Hook command tests** — Subprocess execution
35. **Session persistence tests** — Corrupt JSON, missing fields

---

## 6. IMPLEMENTATION PRIORITY MATRIX

```
Impact ↑
       │  [1] Parallel dispatch    [3] AskUser    [6] Monitor
  High │  [2] Streaming            [4] Edit+       [5] PlanMode
       │  [7] Grep+                [8] Glob+       [13] Path rules
       │  [9] Bash+                [10] Read+      [11] NotebookEdit
  Med  │  [14] Domain rules        [15] Pipe input [16] Session resume
       │  [17] Named sessions      [18] Output fmt [22] Task mgmt
       │  [23] Sub-agents          [24] MCP        [25] Skills
  Low  │  [26] Path-scoped memory  [27] Compact    [28] Hook conditions
       │  [29] Hook priority       [30] Cost track [31-35] Tests
       └──────────────────────────────────────────────────────────→
          Low                        Medium                    High
                              Effort →
```

---

## 7. QUICK WINS (Can implement now)

1. **Parallel tool dispatch** — ~50 lines in `agent.py`, uses existing `is_concurrency_safe` markers
2. **Streaming responses** — ~30 lines in `agent.py`, `stream=True` + token yield
3. **Enhanced Edit** — Add read-before-edit check, uniqueness check, `replace_all` flag
4. **Enhanced Bash** — Increase timeout to 10-min, output to 30K, add `run_in_background`
5. **Enhanced Grep** — Add `-A`/`-B`/`-C` context lines, multiline support
6. **Path-scoped permissions** — Extend `PermissionRule` with glob path matching
7. **CLAUDE.md survival** — Re-read from disk after compression in agent.py

---

## Files to Modify

| File | Changes |
|------|---------|
| `mimo_harness/agent.py` | Parallel dispatch, streaming, plan mode toggle, cost tracking |
| `mimo_harness/tools/file_ops.py` | Enhanced Edit (read-before-edit, uniqueness), enhanced Read (images), enhanced Glob/Grep |
| `mimo_harness/tools/shell.py` | `run_in_background`, increased timeouts/output |
| `mimo_harness/tools/registry.py` | Streaming support, parallel dispatch markers |
| `mimo_harness/permissions.py` | Path-scoped rules, domain rules, disallowed tools |
| `mimo_harness/context.py` | CLAUDE.md survival after compact |
| `mimo_harness/hooks.py` | `if` conditions, priority ordering |
| `mimo_harness/cli.py` | Pipe input, session resume, named sessions, output formats |
| `mimo_harness/memory.py` | Path-scoped rules, `@import` syntax |
| `tests/` | CLI tests, logging tests, integration tests, hook command tests |
