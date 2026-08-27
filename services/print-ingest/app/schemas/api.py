from pydantic import BaseModel, HttpUrl

class DiscoverRequest(BaseModel):
    urls: list[HttpUrl]

class DownloadRequest(BaseModel):
    url: HttpUrl
    source_id: int | None = None
    archive_length: int | None = None

class ProcessRequest(BaseModel):
    document_id: int

class SourceOut(BaseModel):
    id: int
    url: str
    domain: str
    status: str
    score: float
    class Config:
        from_attributes = True

class AutoDiscoverRequest(BaseModel):
    seed_pages: list[HttpUrl] = []
    archive_domains: list[str] = []
    search_terms: list[str] = []
    max_results: int = 100
    area_name: str | None = None

class RevisitRequest(BaseModel):
    url: HttpUrl
    fingerprint: str | None = None
