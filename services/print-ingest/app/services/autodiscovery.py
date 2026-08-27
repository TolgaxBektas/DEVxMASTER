from urllib.parse import urlparse
from sqlalchemy.orm import Session
from sqlalchemy import select
from app.core.config import settings
from app.models.entities import Source
from app.services.archive_index import ArchiveIndex, deduplicate_archive_entries
from app.services.discovery import candidate_rejection_reason, discover_pdf_links, score_candidate
from app.services.policy import DiscoveryBudget, check_url_policy
from app.services.sitemap import discover_sitemaps, extract_pdf_urls_from_sitemap
from app.services.search_provider import web_search


def _record_error(rejected, page, error, discovery):
    if rejected is not None:
        rejected.append({
            "url": page,
            "reason": "crawl_error",
            "error_type": type(error).__name__,
            "message": str(error),
            "discovery": discovery,
        })


def _policy(url, budget):
    try:
        return check_url_policy(url, robots_cache=budget.robots_cache, budget=budget)
    except TypeError as error:
        if "unexpected keyword" not in str(error):
            raise
        return check_url_policy(url)


def upsert_source(db: Session, url: str, score: float, meta: dict):
    src=db.scalar(select(Source).where(Source.url==url))
    if not src:
        src=Source(url=url,domain=urlparse(url).hostname or '',status='DISCOVERED',score=score,metadata_json=meta)
        db.add(src); db.flush()
    elif score > src.score:
        src.score=score
    return src


def run_discovery(
    db: Session,
    seed_pages: list[str],
    search_terms: list[str],
    max_results: int = 100,
    area_name: str | None = None,
    archive_domains: list[str] | None = None,
):
    rejected: list[dict] = []
    archive_evidence: list[dict] = []
    proposals = discover_proposals(
        seed_pages, search_terms, max_results, area_name, rejected, archive_domains,
        archive_evidence,
    )
    for item in proposals:
        upsert_source(db, item["url"], item["score"], item)
    db.commit()
    return {
        'candidate_pages': len({item.get('found_on') or item['url'] for item in proposals}),
        'pdf_sources': len(proposals),
        'urls': [item['url'] for item in proposals],
        'rejected': rejected,
        'rejected_count': len(rejected),
        'error_count': sum(1 for item in rejected if item.get('reason') == 'crawl_error'),
        'archive_domains': archive_evidence,
    }

def discover_proposals(
    seed_pages: list[str],
    search_terms: list[str],
    max_results: int = 100,
    area_name: str | None = None,
    rejected: list[dict] | None = None,
    archive_domains: list[str] | None = None,
    archive_evidence: list[dict] | None = None,
):
    collected=[]
    visited=set()
    candidate_pages=list(seed_pages)
    budget = DiscoveryBudget()
    for term in search_terms:
        try:
            hits = web_search(term, limit=10)
        except Exception as error:
            _record_error(rejected, term, error, "search")
            continue
        for hit in hits:
            if hit['url'] and hit['url'] not in visited:
                candidate_pages.append(hit['url'])
    for page in candidate_pages[:max_results]:
        if page in visited: continue
        if '.pdf' in page.lower():
            visited.add(page)
            try:
                page_policy = _policy(page, budget)
            except Exception as error:
                _record_error(rejected, page, error, "html_crawl")
                continue
            if page_policy['status'] == 'APPROVED':
                reason = candidate_rejection_reason(page, area_name=area_name)
                if reason:
                    if rejected is not None:
                        rejected.append({"url": page, "reason": reason, "discovery": "search_or_seed_direct"})
                    continue
                collected.append({
                    'url': page,
                    'score': score_candidate(page, area_name=area_name),
                    'found_on': None,
                    'discovery': 'search_or_seed_direct',
                    'reason': 'Direkte PDF-Adresse aus Startseite oder Suchtreffer.',
                })
            continue
        try:
            collected.extend(discover_pdf_links(page, budget=budget, area_name=area_name, rejected=rejected, visited=visited))
        except Exception as error:
            _record_error(rejected, page, error, "html_crawl")
        try:
            for sm in discover_sitemaps(page, budget=budget):
                for pdf_url in extract_pdf_urls_from_sitemap(sm, budget=budget):
                    reason = candidate_rejection_reason(pdf_url, area_name=area_name)
                    if reason:
                        if rejected is not None:
                            rejected.append({
                                "url": pdf_url,
                                "reason": reason,
                                "found_on": page,
                                "found_in_sitemap": sm,
                            })
                        continue
                    collected.append({
                        'url': pdf_url,
                        'score': score_candidate(pdf_url, area_name=area_name),
                        'found_on': page,
                        'found_in_sitemap': sm,
                        'discovery': 'sitemap',
                        'reason': f'PDF-Adresse aus Sitemap {sm}.',
                    })
        except Exception as error:
            _record_error(rejected, page, error, "sitemap")
    domains = archive_domains or [
        urlparse(page).hostname
        for page in seed_pages
        if urlparse(page).hostname
    ]
    archive_budget = DiscoveryBudget(
        max_requests=max(100, len(set(domains)) * 8),
        max_depth=0,
        max_seconds=max(300, settings.max_discovery_seconds),
    )
    archive = ArchiveIndex()
    archive_results = archive.fetch_many(domains, budget=archive_budget)
    for host, result in archive_results.items():
        if archive_evidence is not None:
            archive_evidence.append({
                "host": host,
                "status": result.outcome
                if result.outcome != "unknown"
                else ("error" if result.error else ("empty" if not result.entries else "ok")),
                "entry_count": len(result.entries),
                "attempts": result.attempts,
                "error": result.error,
            })
        if result.error:
            _record_error(
                rejected,
                f"https://{host}",
                RuntimeError(result.error),
                "archive_index",
            )
            continue
        entries, duplicates = deduplicate_archive_entries(result.entries)
        if rejected is not None:
            rejected.extend(duplicates)
        for entry in entries:
            if entry.status_code >= 400 and not entry.archive_url:
                if rejected is not None:
                    rejected.append({
                        "url": entry.original,
                        "reason": "Archivkopie fehlt trotz Fehlerstatus",
                        "discovery": "archive_index",
                        "archive_timestamp": entry.timestamp,
                        "archive_status_code": entry.status_code,
                    })
                continue
            reason = candidate_rejection_reason(
                entry.original,
                area_name=area_name,
                archive_timestamp=entry.timestamp,
            )
            if reason:
                if rejected is not None:
                    rejected.append({
                        "url": entry.original,
                        "reason": reason,
                        "discovery": "archive_index",
                        "archive_timestamp": entry.timestamp,
                        "archive_status_code": entry.status_code,
                    })
                continue
            collected.append({
                "url": entry.original,
                "score": score_candidate(entry.original, area_name=area_name),
                "found_on": f"https://{host}",
                "discovery": "archive_index",
                "reason": f"PDF-Adresse aus Internet-Archive-CDX; zuletzt gesehen {entry.timestamp}.",
                "archiveUrl": entry.archive_url,
                "archiveTimestamp": entry.timestamp,
                "archiveStatusCode": entry.status_code,
                "archiveLength": entry.length,
            })
    unique = {}
    for item in collected:
        unique.setdefault(item['url'], item)
    return list(unique.values())[:max_results]
