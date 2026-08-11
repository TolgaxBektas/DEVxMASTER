from collections.abc import Generator
from app.core.config import get_settings
from app.db.session import SessionLocal
from app.services.factory import make_pipeline
from app.services.factory import make_storage
from app.services.pipeline import Pipeline


def session_dependency() -> Generator:
    with SessionLocal() as session:
        yield session


def pipeline_dependency(session) -> Pipeline:
    settings = get_settings()
    return make_pipeline(session, settings)


def storage_dependency():
    return make_storage(get_settings())
