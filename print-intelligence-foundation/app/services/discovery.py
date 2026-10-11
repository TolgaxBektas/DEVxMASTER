from collections import deque
from datetime import datetime, timezone
import logging
from time import monotonic, sleep
from urllib.parse import urljoin, urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser
import xml.etree.ElementTree as ET

from bs4 import BeautifulSoup
import httpx
from redis import RedisError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import DiscoveredCandidate, Document, Job, Source
from app.core.config import get_settings
from app.services.downloader import download, fetch_url, validate_public_url
from app.services.factory import make_pipeline, make_search_provider
from app.services.queue import RedisQueue
from app.services.search import SearchProvider
from app.services.storage import sha256

logger = logging.getLogger(__name__)


def discover_pdf_links(html: str, base_url: str = "") -> list[str]:
    soup = BeautifulSoup(html, "html.parser")
    return list(
        dict.fromkeys(
            urljoin(base_url, a.get("href"))
            for a in soup.find_all("a", href=True)
            if a["href"].lower().split("?")[0].endswith(".pdf")
        )
    )


def normalize_url(url: str) -> str:
    parsed = urlsplit(url)
    host = (parsed.hostname or "").lower()
    netloc = host
    if parsed.port and parsed.port not in (80, 443):
        netloc = f"{host}:{parsed.port}"
    return urlunsplit(
        (parsed.scheme.lower(), netloc, parsed.path or "/", parsed.query, "")
    )


class DiscoveryCrawler:
    def __init__(
        self,
        session: Session | None,
        max_bytes: int = 50_000_000,
        max_depth: int = 2,
        max_pages: int = 50,
        max_entries: int = 100,
        timeout_seconds: float = 60,
        request_delay: float = 0,
        user_agent: str = "print-intelligence-foundation/1.0",
        queue: RedisQueue | None = None,
        search_provider: SearchProvider | None = None,
    ):
        self.session = session
        self.max_bytes = max_bytes
        self.max_depth = max_depth
        self.max_pages = max_pages
        self.max_entries = max_entries
        self.timeout_seconds = timeout_seconds
        self.request_delay = request_delay
        self.user_agent = user_agent
        self.queue = queue
        if search_provider is None:
            search_provider = make_search_provider(get_settings())
        self.search_provider = search_provider
        self._last_request: dict[str, float] = {}

    @classmethod
    def for_proposals(cls, **kwargs):
        return cls(session=None, **kwargs)

    def _require_session(self) -> Session:
        if self.session is None:
            raise RuntimeError(
                "stateful discovery operation requires a database session"
            )
        return self.session

    def crawl(self, source: Source) -> dict[str, int]:
        session = self._require_session()
        deadline = monotonic() + self.timeout_seconds
        robots = self._robots(source.base_url, deadline)
        links = (
            self._sitemap(source.base_url, robots, deadline)
            if source.crawl_strategy == "sitemap"
            else self._html(source.base_url, robots, deadline)
        )
        discovered = skipped = 0
        for url in links[: self.max_entries]:
            if monotonic() >= deadline:
                break
            candidate, created = self._candidate(source, url)
            if created:
                discovered += 1
                if self.queue:
                    try:
                        if self.queue.enqueue_candidate(candidate.id):
                            candidate.state = "queued"
                    except RedisError as exc:
                        candidate.error = str(exc)
            else:
                skipped += 1
        source.last_crawled_at = datetime.now(timezone.utc)
        session.commit()
        return {"discovered": discovered, "skipped": skipped}

    def propose(
        self,
        seed_pages: list[str],
        search_terms: list[str],
        max_results: int,
    ) -> list[dict]:
        proposals = []
        seen = set()
        candidate_pages = [
            (page, {"type": "seed", "page": page}) for page in seed_pages
        ]
        if self.search_provider:
            for term in search_terms:
                candidate_pages.extend(
                    (result.url, {"type": "search", "query": term})
                    for result in self.search_provider.search(
                        term, min(max_results, self.max_entries)
                    )
                    if result.url
                )
        unique_pages = []
        page_seen = set()
        for page, origin in candidate_pages:
            if page not in page_seen:
                page_seen.add(page)
                unique_pages.append((page, origin))
        for page_url, origin in unique_pages[: self.max_pages]:
            if len(proposals) >= max_results:
                break
            try:
                validate_public_url(page_url)
            except (ValueError, TimeoutError, httpx.HTTPError):
                continue
            if urlsplit(page_url).path.lower().endswith(".pdf"):
                try:
                    validate_public_url(page_url)
                except (ValueError, TimeoutError, httpx.HTTPError):
                    continue
                links = [page_url]
            else:
                deadline = monotonic() + self.timeout_seconds
                robots = self._robots(page_url, deadline)
                links = self._html(page_url, robots, deadline)
                links.extend(self._sitemap(page_url, robots, deadline))
            for url in links:
                try:
                    validate_public_url(url)
                except ValueError:
                    continue
                normalized = normalize_url(url)
                if normalized in seen:
                    continue
                seen.add(normalized)
                term_hits = sum(
                    term.lower() in url.lower()
                    for term in search_terms
                    if term.strip()
                )
                proposals.append(
                    {
                        "url": url,
                        "score": float(1 + term_hits),
                        "found_on": origin.get("page"),
                        "origin": origin,
                        "discovery": origin["type"],
                    }
                )
                if len(proposals) >= max_results:
                    break
        return proposals

    def process_candidate(self, candidate: DiscoveredCandidate) -> Document:
        session = self._require_session()
        try:
            data = download(candidate.url, self.max_bytes)
            digest = sha256(data)
            existing = session.scalar(
                select(Document).where(Document.content_sha256 == digest)
            )
            if existing:
                candidate.content_sha256 = digest
                candidate.document_id = existing.id
                if self._document_complete(existing.id):
                    candidate.state = "skipped"
                    session.commit()
                    return existing
            settings = get_settings()
            document = make_pipeline(session, settings).ingest(
                data, source_url=candidate.url
            )
            candidate.content_sha256 = digest
            candidate.document_id = document.id
            candidate.state = "ingested"
            session.commit()
            return document
        except Exception as exc:
            candidate.state, candidate.error = "failed", str(exc)
            session.commit()
            raise

    def _document_complete(self, document_id: int) -> bool:
        session = self._require_session()
        jobs = session.scalars(
            select(Job).where(Job.document_id == document_id)
        ).all()
        states = {job.stage: job.state for job in jobs}
        required = {"download", "render", "classify", "detect", "extract", "store"}
        return required.issubset(states) and all(
            states[stage] == "succeeded" for stage in required
        )

    def _candidate(self, source: Source, url: str):
        session = self._require_session()
        normalized = normalize_url(url)
        candidate = session.scalar(
            select(DiscoveredCandidate).where(
                DiscoveredCandidate.normalized_url == normalized
            )
        )
        if candidate:
            return candidate, False
        candidate = DiscoveredCandidate(
            source_id=source.id, url=url, normalized_url=normalized
        )
        session.add(candidate)
        session.flush()
        return candidate, True

    def _request(self, url: str, deadline: float):
        if monotonic() >= deadline:
            raise TimeoutError("crawl deadline exceeded")
        host = urlsplit(url).netloc.lower()
        elapsed = monotonic() - self._last_request.get(host, 0)
        if elapsed < self.request_delay:
            sleep(self.request_delay - elapsed)
        self._last_request[host] = monotonic()
        return fetch_url(url, self.max_bytes)

    def _robots(self, base_url: str, deadline: float):
        robots_url = urljoin(base_url, "/robots.txt")
        try:
            status, _, body = self._request(robots_url, deadline)
            if status >= 400:
                return None
            parser = RobotFileParser()
            parser.parse(body.decode("utf-8", errors="replace").splitlines())
            return parser
        except (ValueError, TimeoutError, httpx.HTTPError) as exc:
            logger.warning("robots fetch failed url=%s error=%s", robots_url, exc)
            return None

    def _allowed(self, robots, url: str) -> bool:
        return robots is None or robots.can_fetch(self.user_agent, url)

    def _sitemap(self, base_url: str, robots, deadline: float):
        pending = deque([(urljoin(base_url, "/sitemap.xml"), 0)])
        links = []
        while pending and len(links) < self.max_entries:
            url, depth = pending.popleft()
            if depth > self.max_depth or not self._allowed(robots, url):
                continue
            try:
                status, _, body = self._request(url, deadline)
                if status >= 400:
                    continue
                root = ET.fromstring(body)
                tag = root.tag.rsplit("}", 1)[-1]
                values = [
                    node.text.strip()
                    for node in root.iter()
                    if node.tag.rsplit("}", 1)[-1] == "loc" and node.text
                ]
                if tag == "sitemapindex":
                    pending.extend((value, depth + 1) for value in values)
                else:
                    links.extend(
                        value
                        for value in values
                        if urlsplit(value).path.lower().endswith(".pdf")
                    )
            except (ET.ParseError, ValueError, TimeoutError, httpx.HTTPError) as exc:
                logger.warning("sitemap fetch failed url=%s error=%s", url, exc)
                continue
        return list(dict.fromkeys(links))

    def _html(self, base_url: str, robots, deadline: float):
        host = urlsplit(base_url).netloc.lower()
        pending = deque([(base_url, 0)])
        visited = set()
        links = []
        while pending and len(visited) < self.max_pages:
            url, depth = pending.popleft()
            normalized = normalize_url(url)
            if normalized in visited or depth > self.max_depth:
                continue
            visited.add(normalized)
            if urlsplit(url).netloc.lower() != host or not self._allowed(robots, url):
                continue
            try:
                status, headers, body = self._request(url, deadline)
                if status >= 400:
                    continue
                content_type = headers.get("content-type", "").lower()
                if content_type and "html" not in content_type:
                    continue
                soup = BeautifulSoup(body, "html.parser")
                for anchor in soup.find_all("a", href=True):
                    child = urljoin(url, anchor["href"])
                    if (
                        urlsplit(child).path.lower().endswith(".pdf")
                        and urlsplit(child).netloc.lower() == host
                        and self._allowed(robots, child)
                    ):
                        links.append(child)
                    elif (
                        urlsplit(child).netloc.lower() == host
                        and depth < self.max_depth
                    ):
                        pending.append((child, depth + 1))
            except (ValueError, TimeoutError, httpx.HTTPError) as exc:
                logger.warning("html fetch failed url=%s error=%s", url, exc)
                continue
        return list(dict.fromkeys(links))
