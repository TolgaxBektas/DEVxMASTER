from app.core.config import get_settings
from app.db.session import SessionLocal
from app.models import Document
from app.services.factory import make_provider, make_storage
from app.services.pipeline import Pipeline
from app.services.queue import RedisQueue


def run() -> None:
    settings = get_settings()
    queue = RedisQueue(settings.redis_url, settings.redis_queue)
    while True:
        item = queue.consume()
        if not item:
            continue
        with SessionLocal() as session:
            document = session.get(Document, item["document_id"])
            if document is None:
                continue
            storage = make_storage(settings)
            try:
                data = storage.get(f"{document.content_sha256}/source.pdf")
            except Exception:
                continue
            Pipeline(
                session,
                make_provider(settings),
                storage,
                settings.render_dpi,
                settings.confidence_threshold,
                settings.max_job_attempts,
                settings.stage_timeout_seconds,
                settings.local_work_dir,
                settings.bbox_iou_threshold,
            ).ingest(data, document.filename or "document.pdf")


if __name__ == "__main__":
    run()
