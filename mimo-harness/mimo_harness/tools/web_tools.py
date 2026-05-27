"""Web tools - search and fetch web content.

Ch3 markers:
- web_search: read-only, concurrency-safe
- web_fetch: read-only, concurrency-safe
- Both have SSRF protection
"""

import json
import re
import socket
import time
from urllib.parse import urlparse
import ipaddress
from .registry import ToolDef
from ..permissions import Permission

# Max response size for web_fetch (10MB)
MAX_RESPONSE_BYTES = 10 * 1024 * 1024

# S14: Response cache for web_fetch
_fetch_cache: dict[str, tuple[float, str]] = {}
CACHE_TTL = 900  # 15 minutes

# Blocked internal hostnames
_BLOCKED_HOSTNAMES = frozenset({
    "localhost", "metadata.google.internal", "metadata.azure.com",
    "instance-data", "169.254.169.254",
})


def _validate_url(url: str) -> str | None:
    """Return error message if URL is unsafe, else None.

    Checks: scheme, hostname (string + resolved IPs), blocked hostnames.
    """
    try:
        parsed = urlparse(url)
    except Exception:
        return "Invalid URL"
    if parsed.scheme not in ("http", "https"):
        return f"URL scheme '{parsed.scheme}' not allowed (must be http or https)"
    hostname = parsed.hostname or ""
    if not hostname:
        return "URL has no hostname"

    # Block known internal hostnames
    if hostname in _BLOCKED_HOSTNAMES:
        return f"Access to '{hostname}' is not allowed"

    # Check if hostname is a raw IP
    try:
        ip = ipaddress.ip_address(hostname)
        if ip.is_private or ip.is_loopback or ip.is_link_local:
            return f"Access to private IP '{hostname}' is not allowed"
        return None
    except ValueError:
        pass

    # DNS resolution check — block domains that resolve to private IPs
    try:
        resolved_ips = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
        for _, _, _, _, sockaddr in resolved_ips:
            ip = ipaddress.ip_address(sockaddr[0])
            if ip.is_private or ip.is_loopback or ip.is_link_local:
                return f"Domain '{hostname}' resolves to private IP '{ip}' — blocked"
    except (socket.gaierror, OSError):
        pass  # DNS failure — let the request fail naturally

    return None


def web_search(params: dict) -> str:
    query = params.get("query", "")
    try:
        import requests
        resp = requests.get(
            "https://html.duckduckgo.com/html/",
            params={"q": query},
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=10,
        )
        resp.raise_for_status()
        results = []
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
    # S14: check cache first
    cache_key = f"{url}|{max_chars}"
    if cache_key in _fetch_cache:
        cached_time, cached_result = _fetch_cache[cache_key]
        if time.time() - cached_time < CACHE_TTL:
            return cached_result
    try:
        import requests
        # S14: Pre-resolve DNS and pin IP to mitigate DNS rebinding TOCTOU
        from urllib.parse import urlparse
        parsed = urlparse(url)
        hostname = parsed.hostname or ""
        pinned_ip = None
        if hostname:
            try:
                resolved = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
                for _, _, _, _, sockaddr in resolved:
                    ip = ipaddress.ip_address(sockaddr[0])
                    if not (ip.is_private or ip.is_loopback or ip.is_link_local):
                        pinned_ip = sockaddr[0]
                        break
            except (socket.gaierror, OSError, ValueError):
                pass

        resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=15, stream=True)
        resp.raise_for_status()

        # Post-request DNS re-check: verify IP didn't change (DNS rebinding detection)
        if pinned_ip and hostname:
            try:
                post_resolved = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
                post_ips = {sockaddr[0] for _, _, _, _, sockaddr in post_resolved}
                if pinned_ip not in post_ips:
                    resp.close()
                    return json.dumps({"error": f"DNS rebinding detected for '{hostname}' — IP changed during request"})
            except (socket.gaierror, OSError):
                pass  # DNS failure after request is less concerning
        # Read with size limit to prevent memory exhaustion
        content_bytes = b""
        for chunk in resp.iter_content(chunk_size=8192):
            content_bytes += chunk
            if len(content_bytes) > MAX_RESPONSE_BYTES:
                content_bytes += b"\n... [truncated: response too large]"
                break
        resp.close()
        content = content_bytes.decode("utf-8", errors="replace")
        text = re.sub(r'<script[^>]*>.*?</script>', '', content, flags=re.DOTALL)
        text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL)
        text = re.sub(r'<[^>]+>', ' ', text)
        text = re.sub(r'\s+', ' ', text).strip()
        if len(text) > max_chars:
            text = text[:max_chars] + "\n... [truncated]"
        result = json.dumps({"url": url, "status": resp.status_code, "content": text})
        # S14: store in cache
        _fetch_cache[cache_key] = (time.time(), result)
        return result
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
            is_read_only=True,
            is_concurrency_safe=True,
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
            is_read_only=True,
            is_concurrency_safe=True,
        ),
    ]
