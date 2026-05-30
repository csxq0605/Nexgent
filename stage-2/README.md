# Stage 2: Research Assistant with RAG, Memory, and Citations

## Deliverable
A research assistant agent that searches, filters, summarizes, and outputs with citations.

## Architecture

```
User Query
    |
    v
[Agent Loop] <--> [Memory System]
    |                  |
    v                  v
[Tool Router]    [3-tier Memory]
    |              - Short-term (in-context)
    v              - Session (conversation)
[Tools]            - Long-term (vector store)
    |
    v
[Answer with Citations]
```

## Features

### RAG Pipeline
- **Chunk**: Text split into 500-char overlapping chunks (configurable chunk_size and overlap)
- **Store**: Chunks saved to memory store with source metadata (MD5 hash IDs)
- **Retrieve**: Keyword overlap scoring for long-term memory search
- **Answer**: LLM generates answers citing retrieved sources

### Memory System (3 tiers)
| Tier | Implementation | Lifetime | Use Case |
|------|---------------|----------|----------|
| Short-term | In-context messages | Single LLM call | Current reasoning |
| Session | `session_history` list | Conversation | Track what was discussed |
| Long-term | `long_term_store` list with keyword search | Persistent | Recall prior research |

### Error Handling
- **Tool failures**: try/except around every tool, error returned to LLM
- **Empty results**: explicit "no results" message so LLM knows to try alternatives
- **Duplicate calls**: `seen_tool_calls` set prevents repeating identical calls
- **Path traversal**: file reads are restricted to current working directory
- **Code execution**: 5-second timeout, output truncated to 2000 chars

## Tools
| Tool | Purpose |
|------|---------|
| `web_search` | Search for current information (simulated, connect real API) |
| `read_file` | Read local files, auto-chunks into long-term memory (max 5 chunks) |
| `save_to_memory` | Persist findings to long-term memory with source |
| `recall_memory` | Search long-term memory for prior research (top 3 results) |
| `execute_code` | Run Python for data analysis (5s timeout) |

## How to Run
```bash
# 使用 MiMo 模型（通过 OpenAI 兼容接口）
# 在 .env 中配置 MIMO_BASE_URL, MIMO_API_KEY, MIMO_MODEL
pip install openai python-dotenv
python research_assistant.py
```

## References
- [LlamaIndex Agents](https://docs.llamaindex.ai/en/stable/use_cases/agents/)
- [LangChain Docs](https://docs.langchain.com/)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [mem0](https://github.com/mem0ai/mem0)
