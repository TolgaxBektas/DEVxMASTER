from app.core.config import Settings
from app.services.pipeline import Pipeline
from app.services.storage import LocalStorage, S3Storage
from app.services.vision import OllamaVisionProvider, RecordedVisionProvider
from app.services.ocr import TesseractOCRProvider
from app.services.search import SearXNGSearchProvider


def make_provider(settings: Settings):
    if settings.vision_provider == "recorded":
        return RecordedVisionProvider(settings.vision_recorded_dir)
    return OllamaVisionProvider(
        settings.ollama_url, settings.ollama_model, settings.ollama_timeout
    )


def make_storage(settings: Settings):
    if settings.storage_backend == "s3":
        return S3Storage(
            settings.s3_bucket,
            settings.s3_endpoint_url,
            settings.s3_access_key,
            settings.s3_secret_key,
            settings.s3_region,
        )
    return LocalStorage(settings.storage_path)


def make_ocr_provider(settings: Settings):
    if not settings.ocr_enabled:
        return None
    return TesseractOCRProvider(
        settings.ocr_languages, settings.ocr_confidence_threshold
    )


def make_search_provider(settings: Settings):
    if (
        not settings.searxng_url
        or settings.search_provider.lower() not in {"auto", "searxng"}
    ):
        return None
    return SearXNGSearchProvider(
        settings.searxng_url,
        settings.search_timeout_seconds,
        settings.discovery_user_agent,
    )


def make_pipeline(session, settings: Settings):
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
        settings.artwork_dpi,
        settings.artwork_padding,
        settings.artwork_trim_cap,
        make_ocr_provider(settings),
        settings.ocr_confidence_threshold,
        settings.vision_consensus_runs,
        settings.restoration_enabled,
    )
