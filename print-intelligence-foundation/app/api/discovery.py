from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select

from app.api.auth import require_auth
from app.api.dependencies import session_dependency
from app.core.config import get_settings
from app.models import DiscoveredCandidate, Source
from app.services.discovery import DiscoveryCrawler
from app.services.queue import RedisQueue

router = APIRouter(
    prefix="/discovery", tags=["discovery"], dependencies=[Depends(require_auth)]
)


class SourceCreate(BaseModel):
    base_url: str
    label: str
    crawl_strategy: str = "html"


@router.post("/sources")
def register_source(payload: SourceCreate, session=Depends(session_dependency)):
    if payload.crawl_strategy not in {"html", "sitemap"}:
        raise HTTPException(400, "crawl_strategy must be html or sitemap")
    source = Source(
        base_url=payload.base_url,
        label=payload.label,
        crawl_strategy=payload.crawl_strategy,
    )
    session.add(source)
    try:
        session.commit()
    except Exception as exc:
        session.rollback()
        raise HTTPException(409, "source already exists") from exc
    return _source(source)


@router.get("/sources")
def list_sources(session=Depends(session_dependency)):
    return [_source(source) for source in session.scalars(select(Source)).all()]


@router.post("/sources/{source_id}/crawl")
def crawl_source(source_id: int, session=Depends(session_dependency)):
    source = session.get(Source, source_id)
    if not source:
        raise HTTPException(404)
    if not source.enabled:
        raise HTTPException(409, "source is disabled")
    settings = get_settings()
    queue = RedisQueue(
        settings.redis_url,
        settings.redis_queue,
        settings.redis_visibility_timeout,
        settings.redis_max_attempts,
        settings.redis_backoff_seconds,
    )
    if not queue.health():
        queue = None
    result = DiscoveryCrawler(
        session,
        settings.max_download_bytes,
        settings.discovery_max_depth,
        settings.discovery_max_pages,
        settings.discovery_max_entries,
        settings.discovery_timeout_seconds,
        settings.discovery_request_delay,
        settings.discovery_user_agent,
        queue,
    ).crawl(source)
    return result


@router.post("/sources/{source_id}/{action}")
def set_source_enabled(source_id: int, action: str, session=Depends(session_dependency)):
    if action not in {"enable", "disable"}:
        raise HTTPException(400, "action must be enable or disable")
    source = session.get(Source, source_id)
    if not source:
        raise HTTPException(404)
    source.enabled = action == "enable"
    session.commit()
    return _source(source)


@router.post("/crawl")
def crawl_all_sources(session=Depends(session_dependency)):
    sources = session.scalars(select(Source).where(Source.enabled.is_(True))).all()
    results = {}
    for source in sources:
        settings = get_settings()
        queue = RedisQueue(
            settings.redis_url,
            settings.redis_queue,
            settings.redis_visibility_timeout,
            settings.redis_max_attempts,
            settings.redis_backoff_seconds,
        )
        if not queue.health():
            queue = None
        results[str(source.id)] = DiscoveryCrawler(
            session,
            settings.max_download_bytes,
            settings.discovery_max_depth,
            settings.discovery_max_pages,
            settings.discovery_max_entries,
            settings.discovery_timeout_seconds,
            settings.discovery_request_delay,
            settings.discovery_user_agent,
            queue,
        ).crawl(source)
    return results


@router.get("/candidates")
def list_candidates(session=Depends(session_dependency)):
    return [
        {
            "id": candidate.id,
            "source_id": candidate.source_id,
            "url": candidate.url,
            "state": candidate.state,
            "error": candidate.error,
            "content_sha256": candidate.content_sha256,
            "document_id": candidate.document_id,
        }
        for candidate in session.scalars(
            select(DiscoveredCandidate).order_by(DiscoveredCandidate.id)
        )
    ]


def _source(source):
    return {
        "id": source.id,
        "base_url": source.base_url,
        "label": source.label,
        "enabled": source.enabled,
        "crawl_strategy": source.crawl_strategy,
        "last_crawled_at": source.last_crawled_at,
    }
