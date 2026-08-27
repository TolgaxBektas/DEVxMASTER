from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file='.env', extra='ignore')
    app_env: str = 'development'
    app_name: str = 'Print Intelligence Engine'
    api_host: str = '0.0.0.0'
    api_port: int = 8000
    database_url: str = 'sqlite:///./print_intelligence.db'
    redis_url: str = 'redis://localhost:6379/0'
    s3_endpoint: str = 'http://localhost:9000'
    s3_access_key: str = 'print_storage'
    s3_secret_key: str = 'change_me_storage'
    s3_bucket: str = 'print-intelligence'
    s3_region: str = 'us-east-1'
    outbound_http_enabled: bool = True
    discovery_enabled: bool = True
    max_download_mb: int = 250
    max_response_mb: int = 16
    max_discovery_requests: int = 40
    max_discovery_depth: int = 2
    max_discovery_seconds: int = 90
    max_redirects: int = 3
    crawl_user_agent: str = 'PrintIntelligenceBot/0.1'
    request_timeout_seconds: int = 30
    search_timeout_seconds: int = 5
    ocr_provider: str = 'local_tesseract'
    vision_provider: str = 'stub'
    openai_api_key: str | None = None
    azure_document_intelligence_endpoint: str | None = None
    azure_document_intelligence_key: str | None = None
    service_token: str = 'change-me-print-ingest-token'

settings = Settings()
