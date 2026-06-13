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


def _evict_expired_cache():
    """Remove expired entries from the fetch cache to prevent unbounded growth."""
    now = time.time()
    expired = [k for k, (ts, _) in _fetch_cache.items() if now - ts >= CACHE_TTL]
    for k in expired:
        del _fetch_cache[k]

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
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            return f"Access to private/reserved IP '{hostname}' is not allowed"
        return None
    except ValueError:
        pass

    # DNS resolution check — block domains that resolve to private IPs
    try:
        resolved_ips = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
        for _, _, _, _, sockaddr in resolved_ips:
            ip = ipaddress.ip_address(sockaddr[0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
                return f"Domain '{hostname}' resolves to restricted IP '{ip}' — blocked"
    except (socket.gaierror, OSError):
        pass  # DNS failure — let the request fail naturally

    return None


_SEARCH_BACKENDS = [
    ("https://www.bing.com/search", "bing"),
    ("https://html.duckduckgo.com/html/", "duckduckgo"),
]


def _parse_ddg_html(html: str, max_results: int = 10) -> list[dict]:
    """Parse DuckDuckGo HTML search results."""
    results = []
    for match in re.finditer(
        r'<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)</a>.*?'
        r'<a[^>]+class="result__snippet"[^>]*>(.*?)</a>',
        html, re.DOTALL
    ):
        url = match.group(1)
        title = re.sub(r'<[^>]+>', '', match.group(2)).strip()
        snippet = re.sub(r'<[^>]+>', '', match.group(3)).strip()
        if title and snippet:
            results.append({"title": title, "url": url, "snippet": snippet})
        if len(results) >= max_results:
            break
    if not results:
        for match in re.finditer(r'<a[^>]+href="(https?://[^"]+)"[^>]*>(.*?)</a>', html, re.DOTALL):
            title = re.sub(r'<[^>]+>', '', match.group(2)).strip()
            if title and len(title) > 5:
                results.append({"title": title, "url": match.group(1), "snippet": ""})
            if len(results) >= max_results:
                break
    return results


def _parse_bing_html(html: str, max_results: int = 10) -> list[dict]:
    """Parse Bing search results (HTML or RSS format)."""
    results = []
    # Try RSS format first (requested with format=rss)
    items = re.findall(r'<item>(.*?)</item>', html, re.DOTALL)
    if items:
        for item in items:
            title_m = re.search(r'<title>(.*?)</title>', item)
            link_m = re.search(r'<link/>(.*?)</link>', item) or re.search(r'<link>(.*?)</link>', item)
            desc_m = re.search(r'<description>(.*?)</description>', item, re.DOTALL)
            title = re.sub(r'<[^>]+>', '', title_m.group(1)).strip() if title_m else ""
            url = link_m.group(1).strip() if link_m else ""
            snippet = re.sub(r'<[^>]+>', '', desc_m.group(1)).strip() if desc_m else ""
            if title and url:
                results.append({"title": title, "url": url, "snippet": snippet})
            if len(results) >= max_results:
                break
        return results
    # Fallback: HTML format
    for match in re.finditer(
        r'<li class="b_algo"[^>]*>.*?<a[^>]+href="(https?://[^"]+)"[^>]*>(.*?)</a>.*?<p[^>]*>(.*?)</p>',
        html, re.DOTALL
    ):
        url = match.group(1)
        title = re.sub(r'<[^>]+>', '', match.group(2)).strip()
        snippet = re.sub(r'<[^>]+>', '', match.group(3)).strip()
        if title:
            results.append({"title": title, "url": url, "snippet": snippet})
        if len(results) >= max_results:
            break
    return results


def web_search(params: dict) -> str:
    query = params.get("query", "")
    max_results = params.get("max_results", 10)
    try:
        import requests
        last_error = None
        for backend_url, backend_name in _SEARCH_BACKENDS:
            try:
                search_params = {"q": query}
                if backend_name == "bing":
                    search_params["format"] = "rss"
                resp = requests.get(
                    backend_url,
                    params=search_params,
                    headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},
                    timeout=15,
                )
                resp.raise_for_status()
                if backend_name == "duckduckgo":
                    results = _parse_ddg_html(resp.text, max_results)
                else:
                    results = _parse_bing_html(resp.text, max_results)
                return json.dumps({"query": query, "results": results, "count": len(results)})
            except Exception as e:
                last_error = e
                continue
        return json.dumps({"error": f"All search backends failed: {last_error}"})
    except ImportError:
        return json.dumps({"error": "requests library not installed. Run: pip install requests"})
    except Exception as e:
        return json.dumps({"error": str(e)})


def web_fetch(params: dict) -> str:
    url = params.get("url", "")
    max_chars = params.get("max_chars", 200000)
    err = _validate_url(url)
    if err:
        return json.dumps({"error": err})
    # S14: evict expired cache entries to prevent unbounded growth
    _evict_expired_cache()
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
        pre_ips = set()
        if hostname:
            try:
                resolved = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
                for _, _, _, _, sockaddr in resolved:
                    ip = ipaddress.ip_address(sockaddr[0])
                    if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
                        return json.dumps({"error": f"Domain '{hostname}' resolves to restricted IP '{ip}' — blocked"})
                    pre_ips.add(sockaddr[0])
            except (socket.gaierror, OSError, ValueError):
                pass

        # DNS rebinding defense: pre-resolve rejects restricted IPs (above),
        # post-request re-check detects IP change (below).
        resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=15, stream=True)
        resp.raise_for_status()

        # Post-request DNS re-check: verify IPs didn't change (DNS rebinding detection)
        if pre_ips and hostname:
            try:
                post_resolved = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
                post_ips = {sockaddr[0] for _, _, _, _, sockaddr in post_resolved}
                if not post_ips.intersection(pre_ips):
                    resp.close()
                    return json.dumps({"error": f"DNS rebinding detected for '{hostname}' — IP changed during request"})
                # Also check post-resolve IPs are still safe
                for post_ip_str in post_ips:
                    post_ip = ipaddress.ip_address(post_ip_str)
                    if post_ip.is_private or post_ip.is_loopback or post_ip.is_link_local or post_ip.is_reserved:
                        resp.close()
                        return json.dumps({"error": f"DNS rebinding detected: '{hostname}' now resolves to restricted IP '{post_ip}'"})
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
                    "max_results": {"type": "integer", "description": "Max results to return (default 10)"},
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
                    "max_chars": {"type": "integer", "description": "Max characters to return (default 200000)"},
                },
                "required": ["url"]
            },
            handler=web_fetch,
            permission=Permission.READ,
            is_read_only=True,
            is_concurrency_safe=True,
        ),
    ]
