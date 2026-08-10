from pydantic import BaseModel, HttpUrl

class DiscoverRequest(BaseModel):
    urls: list[HttpUrl]

class DownloadRequest(BaseModel):
    url: HttpUrl
    source_id: int | None = None

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
    search_terms: list[str] = []
    max_results: int = 100
