"""Bounded arXiv search. Abstract evidence is never called full-text review."""

from copy import deepcopy
from datetime import datetime, timezone
from html.parser import HTMLParser
import re
from threading import RLock
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET


class LiteratureSearch:
    def __init__(self, *, fetch=None, timeout=8, max_results=4):
        if not 0 < timeout <= 15 or type(max_results) is not int or not 1 <= max_results <= 8:
            raise ValueError("Literature search requires bounded time and result count")
        self.fetch = fetch or self._fetch
        self.timeout, self.max_results = timeout, max_results
        self._cache, self._lock = {}, RLock()

    def _fetch(self, url):
        request = Request(url, headers={"User-Agent": "NExgent-Scientific-Research/1.0"})
        with urlopen(request, timeout=self.timeout) as response:
            data = response.read(2_000_001)
        if len(data) > 2_000_000:
            raise ValueError("Literature response exceeded bound")
        return data

    def search(self, query):
        if not isinstance(query, str) or not query.strip() or len(query) > 400:
            raise ValueError("Literature query must be nonempty text up to 400 characters")
        query = query.strip()
        with self._lock:
            if query in self._cache:
                return {**deepcopy(self._cache[query]), "cache_hit": True}
        # User text is encoded as data, never used as a URL or shell command.
        terms = re.findall(r"[\w-]+", query, flags=re.UNICODE)[:24]
        expression = " AND ".join('all:"' + term + '"' for term in terms)
        url = "https://export.arxiv.org/api/query?" + urlencode({
            "search_query": expression, "start": 0, "max_results": self.max_results,
            "sortBy": "relevance", "sortOrder": "descending",
        })
        result = {"query": query, "source": "arxiv", "request_url": url,
                  "retrieved_at": datetime.now(timezone.utc).isoformat(), "cache_hit": False,
                  "evidence_level": "metadata_and_abstract", "papers": []}
        try:
            root = ET.fromstring(self.fetch(url))
            ns = {"a": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}
            for entry in root.findall("a:entry", ns)[:self.max_results]:
                identity = entry.findtext("a:id", default="", namespaces=ns).rsplit("/abs/", 1)[-1]
                if not re.fullmatch(r"(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7})(?:v\d+)?", identity):
                    continue
                text = lambda tag: " ".join(entry.findtext(tag, default="", namespaces=ns).split())
                result["papers"].append({"id": identity, "title": text("a:title")[:1000],
                    "abstract": text("a:summary")[:10000], "published": text("a:published"),
                    "authors": [" ".join(a.findtext("a:name", default="", namespaces=ns).split())[:200]
                                for a in entry.findall("a:author", ns)[:30]],
                    "url": "https://arxiv.org/abs/" + identity, "pdf_url": "https://arxiv.org/pdf/" + identity,
                    "doi": text("arxiv:doi")[:300], "journal_ref": text("arxiv:journal_ref")[:1000],
                    "evidence_level": "metadata_and_abstract", "full_text_read": False})
            for paper in result["papers"][:2]:
                # Fetch primary text for the highest-ranked records. Give the
                # caller an explicit excerpt, never claim a whole-paper review.
                try:
                    html_url = "https://arxiv.org/html/" + paper["id"]
                    reader = _PaperText()
                    body = self.fetch(html_url)
                    reader.feed(body.decode("utf-8", errors="replace") if isinstance(body, bytes) else body)
                    excerpt = " ".join(reader.parts).strip()[:18000]
                    if not excerpt:
                        raise ValueError("No readable primary text")
                    paper.update(full_text_excerpt=excerpt, full_text_url=html_url,
                                 evidence_level="primary_full_text_excerpt")
                except Exception as exc:
                    paper["full_text_error"] = type(exc).__name__
            result["status"] = "retrieved" if result["papers"] else "no_results"
        except Exception as exc:
            result.update(status="failed", error_type=type(exc).__name__,
                          limitation="Primary-source retrieval failed; no substitute or invented citation was supplied.")
            return result
        with self._lock:
            self._cache[query] = deepcopy(result)
        return result

    __call__ = search


class _PaperText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.skip, self.parts = 0, []

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "nav"}:
            self.skip += 1

    def handle_endtag(self, tag):
        if tag in {"script", "style", "nav"} and self.skip:
            self.skip -= 1

    def handle_data(self, data):
        if not self.skip:
            cleaned = " ".join(data.split())
            if cleaned:
                self.parts.append(cleaned)
