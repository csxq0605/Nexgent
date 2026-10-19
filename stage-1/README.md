# Stage 1: 最小 Agent Loop

## 交付物
一个 ~220 行的 Python agent，能够选择工具、执行工具并返回最终答案。

## 功能说明
1. 将用户消息 + 工具定义发送到 LLM API（MiMo，通过 OpenAI 兼容接口）
2. LLM 决定调用哪个工具（或返回最终答案）
3. 如果是 tool_use：执行工具，将结果反馈，循环
4. 如果是 end_turn：返回最终文本答案
5. 具有 max_steps（10）和 timeout（60s）安全守卫
6. 使用安全数学求值器（基于 AST）替代 `eval()` 以确保安全

## 可用工具
- `calculator` — 使用安全 AST 求值器计算数学表达式
- `search` — 搜索 API 占位符（模拟结果）
- `read_file` — 读取本地文件，具有路径遍历保护

## 运行方式
```bash
# 使用 MiMo 模型（通过 OpenAI 兼容接口）
# 在 .env 中配置 MIMO_BASE_URL, MIMO_API_KEY, MIMO_MODEL
pip install openai python-dotenv
python minimal_agent.py
```

## 关键概念
- **结构化 JSON 输出**：LLM tool_use 响应已经是结构化 JSON
- **工具调用解析**：API 返回包含 `name`、`arguments` 和 `id` 的工具调用块
- **Agent Loop**：observe（用户输入）→ think（LLM 决策）→ act（工具执行）→ observe（工具结果）
- **安全性**：max_steps 防止无限循环，timeout 防止挂起，错误处理捕获工具失败

## 参考资料
- [Claude Tool Use](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview)
- [OpenAI Function Calling](https://platform.openai.com/docs/guides/function-calling)
