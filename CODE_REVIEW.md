# Agent Learning Hub - 全仓库代码审查报告

> 对仓库全部代码（config.py + Stage 1-8 + mimo-harness）的逐文件审查，按严重级别分类。

---

## P0 - Critical (安全漏洞 / 必然出错)

### 1. config.py:9-11 — KeyError 无提示

```python
MIMO_BASE_URL = os.environ["MIMO_BASE_URL"]
MIMO_API_KEY = os.environ["MIMO_API_KEY"]
MIMO_MODEL = os.environ["MIMO_MODEL"]
```

**问题:** `.env` 缺失时抛出原始 `KeyError`，用户无法理解原因。所有 Stage 入口依赖此文件。
**修复:** 使用 `os.environ.get()` + 有意义的错误提示。

---

### 2. stage-1:130 / stage-2:142 — read_file 无路径沙箱

```python
# stage-1
with open(params["path"], "r", encoding="utf-8") as f:
    return json.dumps({"content": f.read()[:2000]})

# stage-2
with open(params["path"], "r", encoding="utf-8") as f:
    content = f.read()
```

**问题:** LLM 可指示读取 `/etc/passwd`、`~/.ssh/id_rsa` 等敏感文件。Stage 3 的 `_write_file` 有路径校验，但 `read_file` 没有；Stage 1/2 完全没有。
**修复:** 读操作也应限制在 cwd 及其子目录。

---

### 3. stage-1/2/3/4 — API Key 打印到 stdout

```python
print(f"API Key: {MIMO_API_KEY[:12]}...")  # 4 处
```

**问题:** 日志/屏幕录制/CI 输出中泄露部分 key。
**修复:** 打印 `***` 或完全不打印。

---

### 4. stage-7:120,144 — 裸 except 吞掉所有异常

```python
except:
    pass  # line 120 (JSON array parse)

except:
    return False  # line 144 (LLM judge)
```

**问题:** 吞掉 `KeyboardInterrupt`、`SystemExit`、`MemoryError` 等不应被捕获的异常。
**修复:** 改为 `except Exception:`。

---

### 5. stage-3:289 — message.model_dump() 嵌套错误

```python
session.add_message("assistant", message.model_dump())
```

**问题:** `add_message` 创建 `{"role": "assistant", "content": {"role": "assistant", "content": "...", "tool_calls": [...]}}`，整个 message dict 被嵌套在 content 里。MiMo API 要求 content 是 string。
**修复:** 直接 `session.messages.append(msg_dict)` 或修改 `add_message` 接受 dict。

---

### 6. stage-8:227 — 同样的 model_dump() 问题

```python
messages.append(message.model_dump())
```

**问题:** tool_calls 时 `content` 为 `None`，MiMo API 不接受 `content: null`。
**修复:** `msg_dict["content"] = msg_dict.get("content") or ""`

---

## P1 - Warning (可靠性问题)

### 7. stage-3:160 — compact_context 假设首条是 system

```python
result = [messages[0]]  # "keep system prompt"
```

**问题:** 传入的 messages 首条是 user 消息（system 消息在 agent.py 中单独 prepend）。
**修复:** 不假设首条消息类型。

---

### 8. stage-4:7 — os, time 未使用

```python
import os, sys, json, time, re
```

`os` 和 `time` 在文件中从未使用。
**修复:** 移除。

---

### 9. stage-8:14 — hashlib 未使用

```python
import os, sys, json, time, logging, hashlib
```

`hashlib` 在文件中从未使用（session_id 由 TraceLogger 生成）。
**修复:** 移除。

---

### 10. stage-7:95 — re 在函数内导入

```python
def judge_response(...):
    import re
```

**问题:** 每次调用都重新 import re，违反 PEP8。
**修复:** 移到文件顶部。

---

### 11. stage-2:243 — message.model_dump() 潜在 None content

```python
messages.append(message.model_dump())
```

**问题:** tool_calls 时 content 可能为 None。
**修复:** 添加 `content = ""` fallback。

---

### 12. stage-3:244 — import os 在方法内部重复

```python
def _list_files(self, path: str) -> str:
    import os
```

**问题:** `os` 已在文件顶部导入，内部重复导入无意义。
**修复:** 移除。

---

## P2 - Info (代码质量 / 重复)

### 13. safe_eval 重复 3 次

`safe_eval` + `_safe_eval_node` + `_SAFE_OPERATORS` + `_SAFE_FUNCTIONS` 在 stage-1、stage-3、mimo-harness 中完全重复。
**建议:** 提取到共享模块。

---

### 14. extract_json 重复 2 次

`extract_json()` 在 stage-4 和 stage-5 中完全重复。
**建议:** 提取到共享模块。

---

### 15. agent loop 模式重复 8 次

每个 Stage 都重新实现 OpenAI client → messages → tool dispatch → 循环。
**建议:** Stage 3 的 `AgentHarness` 已是通用框架，其他 Stage 应基于它构建。

---

### 16. stage-2:37 — Memory.search_long_term 命名不准确

```python
def search_long_term(self, query, top_k=3):
    overlap = sum(1 for w in query_lower.split() if w in entry["text"].lower())
```

**问题:** 方法名暗示"vector"搜索，实际是关键词重叠计数。
**建议:** 重命名为 `search_by_keywords`。

---

### 17. stage-8:27 — os.makedirs 在模块加载时执行

```python
class TraceLogger:
    def __init__(self, log_file="logs/agent.log"):
        os.makedirs(os.path.dirname(log_file), exist_ok=True)
```

**问题:** 模块导入时就创建 `logs/` 目录。
**建议:** 延迟到实际写入时创建。

---

### 18. stage-6:146 — Google 搜索不可用

```python
search_url = f"https://www.google.com/search?q={topic.replace(' ', '+')}"
```

**问题:** Google 会 CAPTCHA 拦截，实际不可用。
**建议:** 使用 DuckDuckGo 或标记为 placeholder。

---

## 修复清单

| # | 级别 | 文件 | 问题 |
|---|------|------|------|
| 1 | P0 | config.py | KeyError 无提示 |
| 2 | P0 | stage-1/2 | read_file 无路径沙箱 |
| 3 | P0 | stage-1/2/3/4 | API Key 打印 |
| 4 | P0 | stage-7 | 裸 except |
| 5 | P0 | stage-3 | model_dump() 嵌套 |
| 6 | P0 | stage-8 | model_dump() None content |
| 7 | P1 | stage-3 | compact_context 假设 |
| 8 | P1 | stage-4 | os/time 未使用 |
| 9 | P1 | stage-8 | hashlib 未使用 |
| 10 | P1 | stage-7 | re 函数内导入 |
| 11 | P1 | stage-2 | model_dump() None |
| 12 | P1 | stage-3 | import os 重复 |
| 13 | P2 | 全局 | safe_eval 重复 3 次 |
| 14 | P2 | 全局 | extract_json 重复 2 次 |
| 15 | P2 | 全局 | agent loop 重复 8 次 |
| 16 | P2 | stage-2 | 命名不准确 |
| 17 | P2 | stage-8 | 模块加载时 mkdir |
| 18 | P2 | stage-6 | Google 搜索不可用 |
