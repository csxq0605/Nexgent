# Stage 2: RAG 研究助手

## 交付物
一个研究助手 agent，具备搜索、过滤、摘要和引用功能。

## 架构

```
用户查询
    |
    v
[Agent Loop] <--> [记忆系统]
    |                  |
    v                  v
[工具路由]      [三级记忆]
    |              - 短期（上下文内）
    v              - 会话（对话）
[工具]            - 长期（向量存储）
    |
    v
[带引用的答案]
```

## 功能特性

### RAG 管线
- **分块**：文本按 500 字符重叠分块（可配置 chunk_size 和 overlap）
- **存储**：分块保存到记忆存储，带源元数据（MD5 哈希 ID）
- **检索**：关键词重叠评分用于长期记忆搜索
- **回答**：LLM 生成引用检索源的答案

### 记忆系统（三级）
| 层级 | 实现方式 | 生命周期 | 用途 |
|------|---------|----------|------|
| 短期 | 上下文内消息 | 单次 LLM 调用 | 当前推理 |
| 会话 | `session_history` 列表 | 对话期间 | 跟踪讨论内容 |
| 长期 | `long_term_store` 列表 + 关键词搜索 | 持久化 | 回忆先前研究 |

### 错误处理
- **工具失败**：每个工具都有 try/except，错误返回给 LLM
- **空结果**：明确的"无结果"消息，让 LLM 知道尝试替代方案
- **重复调用**：`seen_tool_calls` 集合防止重复相同调用
- **路径遍历**：文件读取限制在当前工作目录内
- **代码执行**：5 秒超时，输出截断到 2000 字符

## 工具
| 工具 | 用途 |
|------|------|
| `web_search` | 搜索当前信息（模拟，可连接真实 API） |
| `read_file` | 读取本地文件，自动分块存入长期记忆（最多 5 块） |
| `save_to_memory` | 将发现持久化到长期记忆（带来源） |
| `recall_memory` | 搜索长期记忆中的先前研究（前 3 个结果） |
| `execute_code` | 运行 Python 进行数据分析（5 秒超时） |

## 运行方式
```bash
# 使用 MiMo 模型（通过 OpenAI 兼容接口）
# 在 .env 中配置 MIMO_BASE_URL, MIMO_API_KEY, MIMO_MODEL
pip install openai python-dotenv
python research_assistant.py
```

## 参考资料
- [LlamaIndex Agents](https://docs.llamaindex.ai/en/stable/use_cases/agents/)
- [LangChain Docs](https://docs.langchain.com/)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [mem0](https://github.com/mem0ai/mem0)
