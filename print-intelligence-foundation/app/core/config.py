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
    confidence_threshold: float = 0.7
    max_download_bytes: int = 50_000_000
    bbox_iou_threshold: float = 0.85
    max_job_attempts: int = 3
    stage_timeout_seconds: float = 300.0
    redis_url: str = "redis://localhost:6379/0"
    redis_queue: str = "print-intelligence:documents"
    s3_endpoint_url: str | None = None
    s3_bucket: str = "print"
    s3_access_key: str | None = None
    s3_secret_key: str | None = None
    s3_region: str = "us-east-1"


@lru_cache
def get_settings() -> Settings:
    return Settings()
