# Stage 6: Browser Agent

## Deliverable
A browser agent that navigates web pages, extracts information, and generates summaries.

## Architecture

```
User Query
    |
    v
[Browser Agent]
    |
    ├── navigate(url) ──> page metadata (title, status, ok)
    ├── extract_text(selector) ──> page content (truncated to 5000 chars)
    ├── extract_links() ──> link list (max 50, http only)
    ├── click(selector) ──> interaction (with form safety check)
    └── screenshot(path) ──> audit trail
    |
    v
[Research Summary]
```

## Safety Guards

| Guard | Implementation |
|-------|---------------|
| **URL validation** | Only http/https allowed (checked in `navigate()`) |
| **No form submission** | `click()` refuses to submit `<form>` elements and submit buttons |
| **Text truncation** | Extracted text capped at 5000 chars |
| **Link limit** | Max 50 links per extraction, filtered to http only |
| **Timeout** | 30s page load timeout (configurable) |
| **Audit trail** | Every action logged with `_log()` method |
| **Headless mode** | Default headless, no visible browser |
| **User agent** | Custom user agent: "Mozilla/5.0 (compatible; ResearchBot/1.0)" |

## How to Run
```bash
pip install playwright
playwright install chromium
python browser_agent.py
```

## Key Methods

| Method | Description | Returns |
|--------|-------------|---------|
| `navigate(url)` | Navigate to URL, wait for domcontentloaded | `{url, title, status, ok}` |
| `extract_text(selector)` | Extract text from element (default: body) | `{text, length}` |
| `extract_links()` | Extract all http links from page | `{links, count}` |
| `click(selector)` | Click element (blocks form submits) | `{status, selector}` |
| `screenshot(path)` | Take viewport screenshot | `{path, status}` |

## Limitations
- Uses Google search (may be blocked without proper headers)
- No JavaScript-heavy SPA support (basic domcontentloaded)
- No authentication or login (by design - safety)
- Screenshots are viewport-only, not full-page
- No cookie or session management

## References
- [browser-use](https://github.com/browser-use/browser-use)
- [Playwright Docs](https://playwright.dev/python/)
- [Claude Computer Use](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/computer-use-tool)
