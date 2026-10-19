"""
Browser Agent - Stage 6 deliverable
A browser agent that navigates web pages, extracts information, and generates summaries.
Uses Playwright for browser automation with safety guards.
"""

import asyncio
import json
import sys
from urllib.parse import quote_plus

try:
    from playwright.async_api import async_playwright
except ImportError:
    print("Install playwright: pip install playwright && playwright install chromium")
    sys.exit(1)


class BrowserAgent:
    """
    A safe browser agent that:
    - Navigates to pages and extracts content
    - Handles page load failures gracefully
    - Takes screenshots for audit trail
    - Respects safety limits (no login, no form submission)
    """

    def __init__(self, headless: bool = True, timeout: int = 30000):
        self.headless = headless
        self.timeout = timeout
        self.action_log: list[dict] = []
        self.pw = None
        self._browser = None
        self._context = None
        self._page = None

    async def start(self):
        """Launch browser."""
        self.pw = await async_playwright().start()
        self._browser = await self.pw.chromium.launch(headless=self.headless)
        self._context = await self._browser.new_context(
            viewport={"width": 1280, "height": 720},
            user_agent="Mozilla/5.0 (compatible; ResearchBot/1.0)"
        )
        self._page = await self._context.new_page()
        self._log("browser_started", {"headless": self.headless})

    async def stop(self):
        """Close browser."""
        if self._browser:
            await self._browser.close()
        if self.pw:
            await self.pw.stop()
        self._log("browser_stopped", {})

    def _log(self, action: str, details: dict):
        """Log every action for audit trail."""
        self.action_log.append({"action": action, "details": details})

    async def navigate(self, url: str) -> dict:
        """Navigate to a URL and return page metadata."""
        if not url.startswith(("http://", "https://")):
            return {"error": "Only http/https URLs allowed"}

        try:
            response = await self._page.goto(url, timeout=self.timeout, wait_until="domcontentloaded")
            title = await self._page.title()
            self._log("navigate", {"url": url, "status": response.status if response else None})
            return {
                "url": url,
                "title": title,
                "status": response.status if response else None,
                "ok": response.ok if response else False
            }
        except Exception as e:
            self._log("navigate_error", {"url": url, "error": str(e)})
            return {"error": str(e)}

    async def extract_text(self, selector: str = "body") -> dict:
        """Extract text content from the page."""
        try:
            element = await self._page.query_selector(selector)
            if not element:
                return {"error": f"Element not found: {selector}"}
            text = await element.inner_text()
            # Truncate for safety
            text = text[:5000]
            self._log("extract_text", {"selector": selector, "length": len(text)})
            return {"text": text, "length": len(text)}
        except Exception as e:
            return {"error": str(e)}

    async def extract_links(self) -> dict:
        """Extract all links from the page."""
        try:
            links = await self._page.eval_on_selector_all(
                "a[href]",
                """elements => elements.map(el => ({
                    text: el.innerText.trim().slice(0, 100),
                    href: el.href
                })).filter(l => l.text && l.href.startsWith('http'))"""
            )
            links = links[:50]  # Limit to 50 links
            self._log("extract_links", {"count": len(links)})
            return {"links": links, "count": len(links)}
        except Exception as e:
            return {"error": str(e)}

    async def screenshot(self, path: str = "screenshot.png") -> dict:
        """Take a screenshot for audit."""
        try:
            await self._page.screenshot(path=path, full_page=False)
            self._log("screenshot", {"path": path})
            return {"path": path, "status": "saved"}
        except Exception as e:
            return {"error": str(e)}

    async def click(self, selector: str) -> dict:
        """Click an element (with safety check)."""
        try:
            element = await self._page.query_selector(selector)
            if not element:
                return {"error": f"Element not found: {selector}"}
            # Safety: don't click submit buttons or forms
            tag = await element.evaluate("el => el.tagName.toLowerCase()")
            button_type = await element.evaluate("el => el.type || ''")
            if tag in ("form",) or (tag == "button" and button_type == "submit"):
                return {"error": "Refusing to submit forms for safety"}
            await element.click(timeout=5000)
            self._log("click", {"selector": selector})
            return {"status": "clicked", "selector": selector}
        except Exception as e:
            return {"error": str(e)}


# ============================================================
# Research workflow: navigate -> extract -> summarize
# ============================================================

async def research_topic(topic: str) -> dict:
    """Use the browser agent to research a topic."""
    agent = BrowserAgent(headless=True)

    try:
        await agent.start()

        # Navigate to a search page
        search_url = f"https://www.google.com/search?q={quote_plus(topic)}"
        nav_result = await agent.navigate(search_url)

        if "error" in nav_result:
            return {"error": f"Navigation failed: {nav_result['error']}"}

        # Extract search results
        links_result = await agent.extract_links()
        text = await agent.extract_text("body")

        # Take screenshot for audit
        await agent.screenshot("research_screenshot.png")

        links = links_result.get("links", []) if "error" not in links_result else []

        return {
            "topic": topic,
            "page_title": nav_result.get("title", ""),
            "links_found": len(links),
            "top_links": links[:10],
            "text_preview": text.get("text", "")[:500] if "error" not in text else text["error"],
            "actions_taken": len(agent.action_log)
        }

    finally:
        await agent.stop()


if __name__ == "__main__":
    print("=== Browser Agent ===")
    topic = input("Enter a topic to research (or press Enter for default): ").strip()
    if not topic:
        topic = "AI agent frameworks 2026"

    print(f"\nResearching: {topic}")
    result = asyncio.run(research_topic(topic))
    print(json.dumps(result, indent=2, ensure_ascii=False))
