from dataclasses import dataclass
import logging
from typing import Protocol

import httpx

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SearchResult:
    url: str
    title: str = ""
    content: str = ""


class SearchProvider(Protocol):
    def search(self, query: str, limit: int) -> list[SearchResult]: ...


class SearXNGSearchProvider:
    def __init__(
        self,
        base_url: str,
        timeout_seconds: float = 30,
        user_agent: str = "print-intelligence-foundation/1.0",
    ):
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds
        self.user_agent = user_agent

    def search(self, query: str, limit: int) -> list[SearchResult]:
        results, _error = self.search_with_status(query, limit)
        return results

    def search_with_status(
        self, query: str, limit: int
    ) -> tuple[list[SearchResult], str | None]:
        try:
            response = httpx.get(
                f"{self.base_url}/search",
                params={"q": query, "format": "json"},
                headers={"User-Agent": self.user_agent},
                timeout=self.timeout_seconds,
            )
            response.raise_for_status()
            return (
                [
                    SearchResult(
                        url=item.get("url", ""),
                        title=item.get("title", ""),
                        content=item.get("content", ""),
                    )
                    for item in response.json().get("results", [])[:limit]
                    if item.get("url")
                ],
                None,
            )
        except (httpx.HTTPError, ValueError, TypeError) as exc:
            logger.warning("search provider failed query=%s error=%s", query, exc)
            return [], str(exc)


class RecordedSearchProvider:
    def __init__(self, results: dict[str, list[SearchResult]]):
        self.results = results

    def search(self, query: str, limit: int) -> list[SearchResult]:
        return self.results.get(query, [])[:limit]
