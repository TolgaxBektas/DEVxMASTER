from functools import lru_cache
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    app_name: str = "Print Intelligence Foundation"
    database_url: str = "sqlite:///./print_intelligence.db"
    storage_path: Path = Path("./data")
    local_work_dir: Path = Path("./work")
    storage_backend: str = "filesystem"
    vision_provider: str = "recorded"
    vision_recorded_dir: Path = Path("tests/fixtures/qwen")
    ollama_url: str = "http://host.docker.internal:11434"
    ollama_model: str = "qwen3-vl:4b"
    ollama_timeout: float = 120.0
    render_dpi: int = 120
    artwork_dpi: int = 300
    artwork_padding: int = 8
    artwork_trim_cap: int = 4
    confidence_threshold: float = 0.7
    max_download_bytes: int = 50_000_000
    bbox_iou_threshold: float = 0.85
    max_job_attempts: int = 3
    stage_timeout_seconds: float = 300.0
    redis_url: str = "redis://localhost:6379/0"
    redis_queue: str = "print-intelligence:documents"
    redis_visibility_timeout: float = 60.0
    redis_max_attempts: int = 3
    redis_backoff_seconds: float = 1.0
    discovery_max_depth: int = 2
    discovery_max_pages: int = 50
    discovery_max_entries: int = 100
    discovery_timeout_seconds: float = 60.0
    discovery_request_delay: float = 0.25
    discovery_user_agent: str = "print-intelligence-foundation/1.0"
    s3_endpoint_url: str | None = None
    s3_bucket: str = "print"
    s3_access_key: str | None = None
    s3_secret_key: str | None = None
    s3_region: str = "us-east-1"
    service_token: str | None = None
    auth_disabled: bool = False


@lru_cache
def get_settings() -> Settings:
    return Settings()


def validate_auth_config(settings: Settings) -> None:
    if not settings.service_token and not settings.auth_disabled:
        raise RuntimeError(
            "SERVICE_TOKEN must be configured, or AUTH_DISABLED=true must be explicitly set for local development"
        )
