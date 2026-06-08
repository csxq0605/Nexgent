# Stage 3: Agent Harness Analysis

## System Studied: Claude Code

### Architecture Overview

```
┌─────────────────────────────────────────────────┐
│                   Agent Harness                  │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │   Tool   │  │Permission│  │   Session    │  │
│  │ Registry │  │   Gate   │  │   Store      │  │
│  └────┬─────┘  └────┬─────┘  └──────┬───────┘  │
│       │              │               │           │
│       v              v               v           │
│  ┌──────────────────────────────────────────┐   │
│  │            Agent Loop (LLM)              │   │
│  │  observe -> think -> act -> observe      │   │
│  └──────────────────────────────────────────┘   │
│       │                                          │
│       v                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │ Context  │  │  Hooks   │  │  Sub-agents  │  │
│  │Compaction│  │(pre/post)│  │  (parallel)  │  │
│  └──────────┘  └──────────┘  └──────────────┘  │
└─────────────────────────────────────────────────┘
```

### Key Components

| Component | Claude Code | Stage 3 Demo | MiMo Harness (v0.3.0) |
|-----------|------------|-------------|----------------------|
| **Tool Registry** | 20+ tools | 4 tools | 14 tool modules with fail-closed defaults |
| **Permission Gate** | Auto/Ask/Deny per tool per mode | 5-level Permission enum | 6 modes, 4-stage pipeline, protected paths |
| **Session Store** | JSONL transcripts | In-memory session | JSONL auto-save, checkpoints, fork, resume |
| **Context Compaction** | Auto-summarize when approaching limits | Keep last N messages | 4-level progressive compression (snip → microcompact → LLM → truncation) |
| **Hooks** | Shell commands pre/post tool execution | Not implemented | 18 events, command/HTTP/prompt hooks |
| **Sub-agents** | Independent context windows, parallel execution | Not implemented | Parallel/Pipeline execution, resource limits |
| **MCP** | External tool servers via protocol | Not implemented | Not implemented (future enhancement) |

> **Note**: The Stage 3 demo was a learning exercise. The full MiMo Harness (v0.3.0) implements all components listed above, with 760 unit tests + 46 E2E tests passing.

### What I Learned

1. **The harness is the product, not the model.** Agent harness power comes from tool design, permission system, and context management -- not just from the LLM's capabilities.

2. **Tool design is critical.** The Agent-Computer Interface (ACI) matters as much as the model. Tool descriptions, parameter schemas, and error messages directly affect LLM decision quality.

3. **Context compaction is essential.** Without it, long conversations hit context limits. Auto-summarization of older messages keeps the conversation going.

4. **Permission gates prevent disasters.** Destructive operations (delete, force push) should be blocked by default. Write operations should prompt for confirmation.

5. **Sub-agents save context.** By delegating research to a sub-agent, the main conversation stays focused. Each sub-agent has its own context window.

6. **Hooks enable automation.** Auto-format on save, lint before commit -- hooks turn the agent into a proper development workflow.

## Deliverable

A working harness demo (`harness_demo.py`) with:
- Pluggable tool registry
- Permission gate with 5 levels
- Session store
- Context compaction
- Agent loop with max steps

## How to Run
```bash
# 使用 MiMo 模型（通过 OpenAI 兼容接口）
# 在 .env 中配置 MIMO_BASE_URL, MIMO_API_KEY, MIMO_MODEL
pip install openai python-dotenv
python harness_demo.py
```

## References
- [Claude Code Overview](https://code.claude.com/docs/en/overview)
- [Claude Code Sub-agents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code Hooks](https://code.claude.com/docs/en/hooks)
- [learn-claude-code](https://github.com/shareAI-lab/learn-claude-code)
- [Dive into Claude Code](https://arxiv.org/abs/2604.14228)
