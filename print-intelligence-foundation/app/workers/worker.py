import logging
import signal
from threading import Event

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.models import DiscoveredCandidate, Document, Job
from app.services.discovery import DiscoveryCrawler
from app.services.factory import make_provider, make_storage
from app.services.jobs import transition
from app.services.pipeline import Pipeline
from app.services.queue import RedisQueue

logger = logging.getLogger("print_intelligence.worker")


class Worker:
    def __init__(self, settings=None, queue=None):
        self.settings = settings or get_settings()
        self.queue = queue or RedisQueue(
            self.settings.redis_url,
            self.settings.redis_queue,
            self.settings.redis_visibility_timeout,
            self.settings.redis_max_attempts,
            self.settings.redis_backoff_seconds,
        )
        self.stop_event = Event()
        self.current = None

    def stop(self, *_):
        self.stop_event.set()
        if self.current:
            self.queue.release(self.current)
            self.current = None

    def run_once(self, timeout: int = 1):
        self.queue.recover_stale()
        item = self.queue.consume(timeout=timeout)
        if not item:
            return False
        self.current = item
        logger.info(
            "queue item received document_id=%s candidate_id=%s stage=process attempt=%s",
            item.get("document_id"),
            item.get("candidate_id"),
            item.get("attempt", 0) + 1,
        )
        try:
            with SessionLocal() as session:
                if item.get("candidate_id"):
                    candidate = session.get(
                        DiscoveredCandidate, item["candidate_id"]
                    )
                    if not candidate:
                        self.queue.ack(item)
                        return True
                    DiscoveryCrawler(
                        session, self.settings.max_download_bytes
                    ).process_candidate(candidate)
                else:
                    document = session.get(Document, item["document_id"])
                    if not document:
                        self.queue.ack(item)
                        return True
                    storage = make_storage(self.settings)
                    data = storage.get(f"{document.content_sha256}/source.pdf")
                    Pipeline(
                        session,
                        make_provider(self.settings),
                        storage,
                        self.settings.render_dpi,
                        self.settings.confidence_threshold,
                        self.settings.max_job_attempts,
                        self.settings.stage_timeout_seconds,
                        self.settings.local_work_dir,
                        self.settings.bbox_iou_threshold,
                    ).ingest(data, document.filename or "document.pdf")
            self.queue.ack(item)
            return True
        except Exception as exc:
            logger.exception(
                "queue item failed document_id=%s candidate_id=%s stage=process attempt=%s",
                item.get("document_id"),
                item.get("candidate_id"),
                item.get("attempt", 0) + 1,
            )
            if not self.queue.retry(item, str(exc)) and item.get("document_id"):
                self._mark_dead(item["document_id"], str(exc))
            return True
        finally:
            self.current = None

    def _mark_dead(self, document_id: int, error: str):
        with SessionLocal() as session:
            for job in session.query(Job).filter(
                Job.document_id == document_id, Job.state == "failed"
            ):
                transition(job, "dead", error)
            session.commit()

    def run(self):
        signal.signal(signal.SIGTERM, self.stop)
        signal.signal(signal.SIGINT, self.stop)
        while not self.stop_event.is_set():
            self.run_once()


def run() -> None:
    Worker().run()


if __name__ == "__main__":
    run()
