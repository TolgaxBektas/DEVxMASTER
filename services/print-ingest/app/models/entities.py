from datetime import datetime
from sqlalchemy import String, Integer, DateTime, Float, ForeignKey, Text, Boolean, JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.db.base import Base

class Source(Base):
    __tablename__ = 'sources'
    id: Mapped[int] = mapped_column(primary_key=True)
    url: Mapped[str] = mapped_column(String(2048), unique=True, index=True)
    domain: Mapped[str] = mapped_column(String(255), index=True)
    source_type: Mapped[str] = mapped_column(String(64), default='web')
    status: Mapped[str] = mapped_column(String(32), default='DISCOVERED')
    score: Mapped[float] = mapped_column(Float, default=0)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

class Document(Base):
    __tablename__ = 'documents'
    id: Mapped[int] = mapped_column(primary_key=True)
    source_id: Mapped[int | None] = mapped_column(ForeignKey('sources.id'), nullable=True)
    original_url: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    filename: Mapped[str] = mapped_column(String(512))
    sha256: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    mime_type: Mapped[str] = mapped_column(String(128), default='application/pdf')
    size_bytes: Mapped[int] = mapped_column(Integer)
    page_count: Mapped[int] = mapped_column(Integer, default=0)
    state: Mapped[str] = mapped_column(String(64), default='DOWNLOADED', index=True)
    storage_key: Mapped[str] = mapped_column(String(1024))
    relevance_score: Mapped[float] = mapped_column(Float, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

class Page(Base):
    __tablename__ = 'pages'
    id: Mapped[int] = mapped_column(primary_key=True)
    document_id: Mapped[int] = mapped_column(ForeignKey('documents.id'), index=True)
    page_number: Mapped[int] = mapped_column(Integer)
    image_key: Mapped[str] = mapped_column(String(1024))
    text: Mapped[str] = mapped_column(Text, default='')
    classification: Mapped[str] = mapped_column(String(64), default='UNKNOWN')
    ad_probability: Mapped[float] = mapped_column(Float, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

class AdOccurrence(Base):
    __tablename__ = 'ad_occurrences'
    id: Mapped[int] = mapped_column(primary_key=True)
    page_id: Mapped[int] = mapped_column(ForeignKey('pages.id'), index=True)
    bbox: Mapped[dict] = mapped_column(JSON, default=dict)
    image_key: Mapped[str] = mapped_column(String(1024))
    confidence: Mapped[float] = mapped_column(Float, default=0)
    validation_status: Mapped[str] = mapped_column(String(32), default='REVIEW_REQUIRED')
    extracted_json: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

class ProcessingJob(Base):
    __tablename__ = 'processing_jobs'
    id: Mapped[int] = mapped_column(primary_key=True)
    document_id: Mapped[int | None] = mapped_column(ForeignKey('documents.id'), nullable=True)
    job_type: Mapped[str] = mapped_column(String(64), index=True)
    state: Mapped[str] = mapped_column(String(64), index=True)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
