# Stage 6: 浏览器 Agent

## 交付物
一个浏览器 agent，能够导航网页、提取信息并生成摘要。

## 架构

```
用户查询
    |
    v
[Browser Agent]
    |
    ├── navigate(url) ──> 页面元数据（title, status, ok）
    ├── extract_text(selector) ──> 页面内容（截断到 5000 字符）
    ├── extract_links() ──> 链接列表（最多 50 个，仅 http）
    ├── click(selector) ──> 交互（带表单安全检查）
    └── screenshot(path) ──> 审计追踪
    |
    v
[研究摘要]
```

## 安全守卫

| 守卫 | 实现方式 |
|------|---------|
| **URL 验证** | 仅允许 http/https（在 `navigate()` 中检查） |
| **禁止表单提交** | `click()` 拒绝提交 `<form>` 元素和提交按钮 |
| **文本截断** | 提取文本上限 5000 字符 |
| **链接限制** | 每次提取最多 50 个链接，仅 http |
| **超时** | 30 秒页面加载超时（可配置） |
| **审计追踪** | 每个操作通过 `_log()` 方法记录 |
| **无头模式** | 默认无头，不显示浏览器 |
| **用户代理** | 自定义用户代理：`"Mozilla/5.0 (compatible; ResearchBot/1.0)"` |

## 运行方式
```bash
pip install playwright
playwright install chromium
python browser_agent.py
```

## 关键方法

| 方法 | 描述 | 返回值 |
|------|------|--------|
| `navigate(url)` | 导航到 URL，等待 domcontentloaded | `{url, title, status, ok}` |
| `extract_text(selector)` | 从元素提取文本（默认：body） | `{text, length}` |
| `extract_links()` | 提取页面所有 http 链接 | `{links, count}` |
| `click(selector)` | 点击元素（阻止表单提交） | `{status, selector}` |
| `screenshot(path)` | 截取视口截图 | `{path, status}` |

## 限制
- 使用 Google 搜索（可能被阻止，需要合适的 headers）
- 不支持 JavaScript 重度 SPA（仅基础 domcontentloaded）
- 不支持认证或登录（出于安全设计）
- 截图仅限视口，非全页
- 不支持 cookie 或会话管理

## 参考资料
- [browser-use](https://github.com/browser-use/browser-use)
- [Playwright Docs](https://playwright.dev/python/)
- [Claude Computer Use](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/computer-use-tool)
