"""Web tools - search and fetch web content."""

import json
import re
from urllib.parse import urlparse
import ipaddress
from .registry import ToolDef
from ..permissions import Permission


def _validate_url(url: str) -> str | None:
    """Return error message if URL is unsafe, else None."""
    try:
        parsed = urlparse(url)
    except Exception:
        return "Invalid URL"
    if parsed.scheme not in ("http", "https"):
        return f"URL scheme '{parsed.scheme}' not allowed (must be http or https)"
    hostname = parsed.hostname or ""
    # Block private/internal IPs
    try:
        ip = ipaddress.ip_address(hostname)
        if ip.is_private or ip.is_loopback or ip.is_link_local:
            return f"Access to private IP '{hostname}' is not allowed"
    except ValueError:
        # hostname is a domain name - block obvious internal names
        if hostname in ("localhost", "metadata.google.internal"):
            return f"Access to '{hostname}' is not allowed"
    return None


def web_search(params: dict) -> str:
    query = params.get("query", "")
    try:
        import requests
        # Use DuckDuckGo HTML (no API key needed)
        resp = requests.get(
            "https://html.duckduckgo.com/html/",
            params={"q": query},
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=10,
        )
        resp.raise_for_status()
        # Extract result snippets from HTML
        results = []
        # Simple regex extraction
        for match in re.finditer(
            r'<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)</a>.*?'
            r'<a[^>]+class="result__snippet"[^>]*>(.*?)</a>',
            resp.text, re.DOTALL
        ):
            url = match.group(1)
            title = re.sub(r'<[^>]+>', '', match.group(2)).strip()
            snippet = re.sub(r'<[^>]+>', '', match.group(3)).strip()
            if title and snippet:
                results.append({"title": title, "url": url, "snippet": snippet})
            if len(results) >= 5:
                break
        if not results:
            # Fallback: extract any links
            for match in re.finditer(r'<a[^>]+href="(https?://[^"]+)"[^>]*>(.*?)</a>', resp.text, re.DOTALL):
                title = re.sub(r'<[^>]+>', '', match.group(2)).strip()
                if title and len(title) > 5:
                    results.append({"title": title, "url": match.group(1), "snippet": ""})
                if len(results) >= 5:
                    break
        return json.dumps({"query": query, "results": results, "count": len(results)})
    except ImportError:
        return json.dumps({"error": "requests library not installed. Run: pip install requests"})
    except Exception as e:
        return json.dumps({"error": str(e)})


def web_fetch(params: dict) -> str:
    url = params.get("url", "")
    max_chars = params.get("max_chars", 5000)
    err = _validate_url(url)
    if err:
        return json.dumps({"error": err})
    try:
        import requests
        resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=15)
        resp.raise_for_status()
        content = resp.text
        # Strip HTML tags for readability
        text = re.sub(r'<script[^>]*>.*?</script>', '', content, flags=re.DOTALL)
        text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL)
        text = re.sub(r'<[^>]+>', ' ', text)
        text = re.sub(r'\s+', ' ', text).strip()
        if len(text) > max_chars:
            text = text[:max_chars] + "\n... [truncated]"
        return json.dumps({"url": url, "status": resp.status_code, "content": text})
    except ImportError:
        return json.dumps({"error": "requests library not installed. Run: pip install requests"})
    except Exception as e:
        return json.dumps({"error": str(e)})


def get_tools() -> list[ToolDef]:
    return [
        ToolDef(
            name="web_search",
            description="Search the web using DuckDuckGo. Returns top results with titles, URLs, and snippets.",
            parameters={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"},
                },
                "required": ["query"]
            },
            handler=web_search,
            permission=Permission.READ,
        ),
        ToolDef(
            name="web_fetch",
            description="Fetch and extract text content from a URL.",
            parameters={
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "URL to fetch"},
                    "max_chars": {"type": "integer", "description": "Max characters to return (default 5000)"},
                },
                "required": ["url"]
            },
            handler=web_fetch,
            permission=Permission.READ,
        ),
    ]
