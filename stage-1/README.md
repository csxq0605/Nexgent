# Stage 1: Minimal Agent Loop

## Deliverable
A ~220-line Python agent that can select tools, execute them, and return final answers.

## What It Does
1. Sends user message + tool definitions to LLM API (MiMo via OpenAI-compatible interface)
2. LLM decides which tool(s) to call (or returns a final answer)
3. If tool_use: executes the tool, feeds results back, loops
4. If end_turn: returns the final text answer
5. Has max_steps (10) and timeout (60s) safety guards
6. Uses safe math evaluator (AST-based) instead of `eval()` for security

## Tools Available
- `calculator` -- evaluates math expressions using safe AST-based evaluator
- `search` -- placeholder for search API (simulated results)
- `read_file` -- reads local files with path traversal protection

## How to Run
```bash
# 使用 MiMo 模型（通过 OpenAI 兼容接口）
# 在 .env 中配置 MIMO_BASE_URL, MIMO_API_KEY, MIMO_MODEL
pip install openai python-dotenv
python minimal_agent.py
```

## Key Concepts Learned
- **Structured JSON output**: LLM tool_use response is already structured JSON
- **Tool call parsing**: The API returns tool call blocks with `name`, `arguments`, and `id`
- **Agent loop**: observe (user input) -> think (LLM decides) -> act (tool execution) -> observe (tool result)
- **Safety**: max_steps prevents infinite loops, timeout prevents hangs, error handling catches tool failures

## References
- [Claude Tool Use](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview)
- [OpenAI Function Calling](https://platform.openai.com/docs/guides/function-calling)
