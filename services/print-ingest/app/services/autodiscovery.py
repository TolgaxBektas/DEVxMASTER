from urllib.parse import urlparse
from sqlalchemy.orm import Session
from sqlalchemy import select
from app.models.entities import Source
from app.services.discovery import discover_pdf_links, score_candidate
from app.services.sitemap import discover_sitemaps, extract_pdf_urls_from_sitemap
from app.services.search_provider import web_search


def upsert_source(db: Session, url: str, score: float, meta: dict):
    src=db.scalar(select(Source).where(Source.url==url))
    if not src:
        src=Source(url=url,domain=urlparse(url).hostname or '',status='DISCOVERED',score=score,metadata_json=meta)
        db.add(src); db.flush()
    elif score > src.score:
        src.score=score
    return src


def run_discovery(db: Session, seed_pages: list[str], search_terms: list[str], max_results: int=100):
    collected=[]
    visited=set()
    candidate_pages=list(seed_pages)
    for term in search_terms:
        for hit in web_search(term, limit=10):
            if hit['url'] and hit['url'] not in visited:
                candidate_pages.append(hit['url'])
    for page in candidate_pages[:max_results]:
        if page in visited: continue
        visited.add(page)
        if '.pdf' in page.lower():
            src=upsert_source(db,page,score_candidate(page),{'discovery':'search_or_seed_direct'})
            collected.append(src.url); continue
        try:
            for item in discover_pdf_links(page):
                src=upsert_source(db,item['url'],item['score'],{'found_on':page,'anchor_text':item.get('anchor_text','')})
                collected.append(src.url)
        except Exception:
            pass
        try:
            for sm in discover_sitemaps(page):
                for pdf_url in extract_pdf_urls_from_sitemap(sm):
                    src=upsert_source(db,pdf_url,score_candidate(pdf_url),{'found_in_sitemap':sm})
                    collected.append(src.url)
        except Exception:
            pass
    db.commit()
    return {'candidate_pages':len(visited),'pdf_sources':len(set(collected)),'urls':list(dict.fromkeys(collected))[:max_results]}
