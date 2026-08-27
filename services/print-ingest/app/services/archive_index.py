import time
from dataclasses import dataclass
from urllib.parse import unquote, urlparse

import requests

from app.core.config import settings
from app.services.policy import (
    DiscoveryBudget,
    check_url_policy,
    close_checked_response,
    read_limited_response,
    request_checked,
)

CDX_ENDPOINT = "https://web.archive.org/cdx/search/cdx"
CDX_TIMEOUT_SECONDS = 120
ARCHIVE_REQUEST_DELAY_SECONDS = 1.0
ARCHIVE_RETRY_DELAYS_SECONDS = (1.0, 2.0)


@dataclass(frozen=True)
class ArchivePdf:
    original: str
    timestamp: str
    status_code: int
    length: int | None
    archive_url: str


@dataclass(frozen=True)
class ArchiveIndexResult:
    entries: tuple[ArchivePdf, ...] = ()
    error: str | None = None


def normalize_host(value: str) -> str:
    host = urlparse(value if "://" in value else f"https://{value}").hostname or value
    return host.lower().removeprefix("www.")


def archive_url(original: str, timestamp: str) -> str:
    return f"https://web.archive.org/web/{timestamp}id_/{original}"


def parse_cdx_text(text: str) -> list[ArchivePdf]:
    entries: list[ArchivePdf] = []
    for line in text.splitlines():
        fields = line.strip().split(maxsplit=3)
        if len(fields) != 4:
            continue
        original, timestamp, raw_status, raw_length = fields
        try:
            status_code = int(raw_status)
        except ValueError:
            continue
        try:
            length = int(raw_length)
        except ValueError:
            length = None
        entries.append(ArchivePdf(
            original=original,
            timestamp=timestamp,
            status_code=status_code,
            length=length,
            archive_url=archive_url(original, timestamp),
        ))
    return entries


def normalized_filename(original: str) -> str:
    path = unquote(urlparse(original).path)
    return path.rsplit("/", 1)[-1].casefold()


def deduplicate_archive_entries(
    entries: tuple[ArchivePdf, ...] | list[ArchivePdf],
) -> tuple[list[ArchivePdf], list[dict[str, object]]]:
    grouped: dict[tuple[str, int], list[ArchivePdf]] = {}
    for entry in entries:
        if entry.length is not None:
            grouped.setdefault((normalized_filename(entry.original), entry.length), []).append(entry)

    winners = {
        key: max(group, key=lambda item: item.timestamp)
        for key, group in grouped.items()
    }
    duplicate_ids = {
        id(entry)
        for key, group in grouped.items()
        if len(group) > 1
        for entry in group
        if entry is not winners[key]
    }
    result: list[ArchivePdf] = []
    duplicates: list[dict[str, object]] = []
    for entry in entries:
        if entry.length is None:
            result.append(entry)
            continue
        key = (normalized_filename(entry.original), entry.length)
        if id(entry) not in duplicate_ids:
            result.append(entry)
            continue
        winner = winners[key]
        duplicates.append({
            "url": entry.original,
            "reason": "Dublette: gleicher Dateiname und gleiche CDX-Länge",
            "discovery": "archive_index",
            "duplicateOf": winner.original,
            "archiveTimestamp": entry.timestamp,
            "archiveLength": entry.length,
            "normalizedFilename": key[0],
        })
    return result, duplicates


class ArchiveIndex:
    def __init__(
        self,
        *,
        sleep=time.sleep,
        request_delay: float = ARCHIVE_REQUEST_DELAY_SECONDS,
    ):
        self._sleep = sleep
        self._request_delay = request_delay
        self._last_request_at: float | None = None
        self._cache: dict[str, ArchiveIndexResult] = {}

    def _wait_for_slot(self) -> None:
        if self._last_request_at is None:
            return
        remaining = self._request_delay - (time.monotonic() - self._last_request_at)
        if remaining > 0:
            self._sleep(remaining)

    def fetch(self, host: str, *, budget: DiscoveryBudget) -> ArchiveIndexResult:
        normalized_host = normalize_host(host)
        cached = self._cache.get(normalized_host)
        if cached is not None:
            return cached
        self._wait_for_slot()
        self._last_request_at = time.monotonic()
        params = {
            "url": normalized_host,
            "matchType": "domain",
            "filter": "urlkey:.*\\.pdf.*",
            "fl": "original,timestamp,statuscode,length",
            "collapse": "urlkey",
            "limit": "20000",
            "output": "text",
        }
        last_error = "CDX-Antwort leer"
        for attempt in range(len(ARCHIVE_RETRY_DELAYS_SECONDS) + 1):
            try:
                policy = check_url_policy(
                    CDX_ENDPOINT,
                    robots_cache=budget.robots_cache,
                    budget=budget,
                )
                if policy["status"] != "APPROVED":
                    last_error = f"Policy blockiert: {policy.get('reason', 'unbekannt')}"
                else:
                    response = request_checked(
                        CDX_ENDPOINT,
                        policy=policy,
                        budget=budget,
                        params=params,
                        headers={"User-Agent": settings.crawl_user_agent},
                        timeout=CDX_TIMEOUT_SECONDS,
                    )
                    try:
                        if response.status_code >= 400:
                            last_error = f"HTTP {response.status_code}"
                        else:
                            entries = tuple(parse_cdx_text(
                                read_limited_response(
                                    response,
                                    settings.max_response_mb * 1024 * 1024,
                                ).decode("utf-8", errors="replace"),
                            ))
                            if entries:
                                result = ArchiveIndexResult(entries=entries)
                                self._cache[normalized_host] = result
                                return result
                    finally:
                        close_checked_response(response)
            except (requests.RequestException, RuntimeError, UnicodeError) as error:
                last_error = str(error)
            if attempt < len(ARCHIVE_RETRY_DELAYS_SECONDS):
                self._sleep(ARCHIVE_RETRY_DELAYS_SECONDS[attempt])
        result = ArchiveIndexResult(error=last_error)
        self._cache[normalized_host] = result
        return result

    def fetch_many(
        self,
        hosts: list[str],
        *,
        budget: DiscoveryBudget,
    ) -> dict[str, ArchiveIndexResult]:
        results: dict[str, ArchiveIndexResult] = {}
        for host in dict.fromkeys(hosts):
            normalized = normalize_host(host)
            try:
                results[normalized] = self.fetch(normalized, budget=budget)
            except Exception as error:
                results[normalized] = ArchiveIndexResult(
                    error=f"{type(error).__name__}: {error}",
                )
        return results
