from app.core.config import Settings
from app.services.storage import LocalStorage, S3Storage
from app.services.vision import OllamaVisionProvider, RecordedVisionProvider


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
