from collections.abc import Generator
from app.core.config import get_settings
from app.db.session import SessionLocal
from app.services.factory import make_provider, make_storage
from app.services.pipeline import Pipeline


def session_dependency() -> Generator:
    with SessionLocal() as session:
        yield session


def pipeline_dependency(session) -> Pipeline:
    settings = get_settings()
    return Pipeline(
        session,
        make_provider(settings),
        make_storage(settings),
        settings.render_dpi,
        settings.confidence_threshold,
        settings.max_job_attempts,
        settings.stage_timeout_seconds,
        settings.local_work_dir,
        settings.bbox_iou_threshold,
    )
