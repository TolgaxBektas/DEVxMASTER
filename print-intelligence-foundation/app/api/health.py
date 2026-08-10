from fastapi import APIRouter
from app.core.config import get_settings
from app.db.session import engine
from app.services.factory import make_provider, make_storage
from app.services.queue import RedisQueue

router = APIRouter()


@router.get("/health")
def health():
    settings = get_settings()
    try:
        with engine.connect():
            db_ok = True
    except Exception:
        db_ok = False
    storage_ok = make_storage(settings).health()
    redis_ok = RedisQueue(settings.redis_url, settings.redis_queue).health()
    vision_ok = make_provider(settings).available()
    return {
        "status": "ok" if all((db_ok, storage_ok, redis_ok, vision_ok)) else "degraded",
        "db": db_ok,
        "storage": storage_ok,
        "redis": redis_ok,
        "vision": vision_ok,
    }
