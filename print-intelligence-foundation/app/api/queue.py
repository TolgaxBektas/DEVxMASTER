from fastapi import APIRouter, Depends, HTTPException

from app.api.auth import require_auth
from app.api.dependencies import session_dependency
from app.core.config import get_settings
from app.models import Document
from app.services.queue import RedisQueue

router = APIRouter(
    prefix="/queue", tags=["queue"], dependencies=[Depends(require_auth)]
)


def queue_dependency():
    settings = get_settings()
    return RedisQueue(
        settings.redis_url,
        settings.redis_queue,
        settings.redis_visibility_timeout,
        settings.redis_max_attempts,
        settings.redis_backoff_seconds,
    )


@router.post("/documents/{document_id}")
def enqueue_document(document_id: int, session=Depends(session_dependency)):
    if not session.get(Document, document_id):
        raise HTTPException(404)
    queue = queue_dependency()
    if not queue.enqueue(document_id):
        return {"document_id": document_id, "enqueued": False}
    return {"document_id": document_id, "enqueued": True}


@router.get("")
def queue_stats():
    return queue_dependency().stats()
