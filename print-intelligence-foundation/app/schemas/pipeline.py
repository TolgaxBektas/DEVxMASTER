from pydantic import BaseModel, Field


class AdFields(BaseModel):
    company: str | None = None
    contact_person: str | None = None
    street: str | None = None
    postal_code: str | None = None
    city: str | None = None
    phone: str | None = None
    fax: str | None = None
    raw_phone: str | None = None
    email: str | None = None
    domain: str | None = None
    address: str | None = None
    industry: str | None = None


class BoundingBox(BaseModel):
    x1: float
    y1: float
    x2: float
    y2: float
    confidence: float = 0.0


class Advertisement(BaseModel):
    company_name: str | None = None
    bbox: list[float] = Field(min_length=4, max_length=4)
    confidence: float = 0.0
    fields: AdFields = AdFields()
