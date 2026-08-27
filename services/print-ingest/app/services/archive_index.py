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
    attempts: int = 0
    outcome: str = "unknown"


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


def _deduplication_keys(entry: ArchivePdf) -> tuple[tuple[object, ...], ...]:
    filename = normalized_filename(entry.original)
    keys: list[tuple[object, ...]] = [
        ("host_filename", normalize_host(entry.original), filename),
    ]
    if entry.length is not None:
        keys.append(("filename_length", filename, entry.length))
    return tuple(keys)


def deduplicate_archive_entries(
    entries: tuple[ArchivePdf, ...] | list[ArchivePdf],
) -> tuple[list[ArchivePdf], list[dict[str, object]]]:
    entries_list = list(entries)
    parent = list(range(len(entries_list)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(first: int, second: int) -> None:
        first_root, second_root = find(first), find(second)
        if first_root != second_root:
            parent[second_root] = first_root

    first_by_key: dict[tuple[object, ...], int] = {}
    for index, entry in enumerate(entries_list):
        for key in _deduplication_keys(entry):
            previous = first_by_key.setdefault(key, index)
            union(previous, index)

    groups: dict[int, list[int]] = {}
    for index in range(len(entries_list)):
        groups.setdefault(find(index), []).append(index)
    winners = {
        root: max(indices, key=lambda index: entries_list[index].timestamp)
        for root, indices in groups.items()
    }
    result: list[ArchivePdf] = []
    duplicates: list[dict[str, object]] = []
    for index, entry in enumerate(entries_list):
        winner_index = winners[find(index)]
        if index == winner_index:
            result.append(entry)
            continue
        winner = entries_list[winner_index]
        same_host_filename = (
            normalize_host(entry.original) == normalize_host(winner.original)
            and normalized_filename(entry.original) == normalized_filename(winner.original)
        )
        reason = (
            "Dublette: gleicher Host und normalisierter Dateiname"
            if same_host_filename
            else "Dublette: gleicher Dateiname und gleiche CDX-Länge"
        )
        duplicates.append({
            "url": entry.original,
            "reason": reason,
            "discovery": "archive_index",
            "duplicateOf": winner.original,
            "archiveTimestamp": entry.timestamp,
            "archiveLength": entry.length,
            "normalizedFilename": normalized_filename(entry.original),
            "normalizedHost": normalize_host(entry.original),
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
        last_outcome = "empty"
        for attempt in range(len(ARCHIVE_RETRY_DELAYS_SECONDS) + 1):
            try:
                policy = check_url_policy(
                    CDX_ENDPOINT,
                    robots_cache=budget.robots_cache,
                    budget=budget,
                )
                if policy["status"] != "APPROVED":
                    last_error = f"Policy blockiert: {policy.get('reason', 'unbekannt')}"
                    last_outcome = "policy_blocked"
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
                            last_outcome = "error"
                        else:
                            entries = tuple(parse_cdx_text(
                                response_body := read_limited_response(
                                    response,
                                    settings.max_response_mb * 1024 * 1024,
                                ).decode("utf-8", errors="replace"),
                            ))
                            if entries:
                                result = ArchiveIndexResult(
                                    entries=entries,
                                    attempts=attempt + 1,
                                    outcome="ok",
                                )
                                self._cache[normalized_host] = result
                                return result
                            if response_body.strip():
                                last_error = "CDX-Parsefehler: keine gültigen Zeilen"
                                last_outcome = "parse_error"
                    finally:
                        close_checked_response(response)
            except (requests.RequestException, RuntimeError, UnicodeError) as error:
                last_error = str(error)
                last_outcome = "error"
            if attempt < len(ARCHIVE_RETRY_DELAYS_SECONDS):
                self._sleep(ARCHIVE_RETRY_DELAYS_SECONDS[attempt])
        result = ArchiveIndexResult(
            error=last_error,
            attempts=len(ARCHIVE_RETRY_DELAYS_SECONDS) + 1,
            outcome=last_outcome,
        )
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
                # A slow or unavailable host must not consume the shared
                # discovery deadline and make later domains disappear.
                host_budget = DiscoveryBudget(
                    max_requests=10,
                    max_depth=0,
                    max_seconds=max(
                        settings.max_discovery_seconds,
                        CDX_TIMEOUT_SECONDS * (len(ARCHIVE_RETRY_DELAYS_SECONDS) + 1) + 10,
                    ),
                )
                host_budget.robots_cache = budget.robots_cache
                results[normalized] = self.fetch(normalized, budget=host_budget)
            except Exception as error:
                results[normalized] = ArchiveIndexResult(
                    error=f"{type(error).__name__}: {error}",
                    attempts=0,
                    outcome="error",
                )
        return results
