from urllib.parse import urlparse
from sqlalchemy.orm import Session
from sqlalchemy import select
from app.models.entities import Source
from app.services.discovery import candidate_rejection_reason, discover_pdf_links, score_candidate
from app.services.policy import DiscoveryBudget, check_url_policy
from app.services.sitemap import discover_sitemaps, extract_pdf_urls_from_sitemap
from app.services.search_provider import web_search


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
):
    rejected: list[dict] = []
    proposals = discover_proposals(
        seed_pages, search_terms, max_results, area_name, rejected,
    )
    for item in proposals:
        upsert_source(db, item["url"], item["score"], item)
    db.commit()
    return {
        'candidate_pages': len({item.get('found_on') or item['url'] for item in proposals}),
        'pdf_sources': len(proposals),
        'urls': [item['url'] for item in proposals],
        'rejected': rejected,
    }

def discover_proposals(
    seed_pages: list[str],
    search_terms: list[str],
    max_results: int = 100,
    area_name: str | None = None,
    rejected: list[dict] | None = None,
):
    collected=[]
    visited=set()
    candidate_pages=list(seed_pages)
    budget = DiscoveryBudget()
    for term in search_terms:
        for hit in web_search(term, limit=10):
            if hit['url'] and hit['url'] not in visited:
                candidate_pages.append(hit['url'])
    for page in candidate_pages[:max_results]:
        if page in visited: continue
        if '.pdf' in page.lower():
            visited.add(page)
            if _policy(page, budget)['status'] == 'APPROVED':
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
        except Exception:
            pass
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
        except Exception:
            pass
    unique = {}
    for item in collected:
        unique.setdefault(item['url'], item)
    return list(unique.values())[:max_results]
