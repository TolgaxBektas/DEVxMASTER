from datetime import datetime, timezone
from sqlalchemy import (
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.db.base import Base


def now() -> datetime:
    return datetime.now(timezone.utc)


class Document(Base):
    __tablename__ = "documents"
    id: Mapped[int] = mapped_column(primary_key=True)
    content_sha256: Mapped[str] = mapped_column(String(64), unique=True)
    source_url: Mapped[str | None] = mapped_column(Text)
    filename: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    pages: Mapped[list["Page"]] = relationship(
        back_populates="document", cascade="all, delete-orphan"
    )


class Page(Base):
    __tablename__ = "pages"
    __table_args__ = (UniqueConstraint("document_id", "page_number"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    document_id: Mapped[int] = mapped_column(ForeignKey("documents.id"), index=True)
    page_number: Mapped[int] = mapped_column(Integer)
    image_path: Mapped[str | None] = mapped_column(Text)
    classification: Mapped[str | None] = mapped_column(String(50))
    is_order_form: Mapped[bool] = mapped_column(default=False)
    form_header_json: Mapped[str] = mapped_column(Text, default="{}")
    document: Mapped[Document] = relationship(back_populates="pages")
    ads: Mapped[list["AdOccurrence"]] = relationship(
        back_populates="page", cascade="all, delete-orphan"
    )


class Company(Base):
    __tablename__ = "companies"
    __table_args__ = (UniqueConstraint("normalized_name", "contact_key"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(500))
    normalized_name: Mapped[str] = mapped_column(String(500), index=True)
    contact_key: Mapped[str] = mapped_column(String(500), default="")


class AdOccurrence(Base):
    __tablename__ = "ad_occurrences"
    __table_args__ = (UniqueConstraint("page_id", "occurrence_key"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    page_id: Mapped[int] = mapped_column(ForeignKey("pages.id"), index=True)
    occurrence_key: Mapped[str] = mapped_column(String(128))
    bbox: Mapped[str] = mapped_column(String(100))
    crop_path: Mapped[str | None] = mapped_column(Text)
    artwork_path: Mapped[str | None] = mapped_column(Text)
    artwork_trimmed_path: Mapped[str | None] = mapped_column(Text)
    artwork_metadata_json: Mapped[str] = mapped_column(Text, default="{}")
    is_order_form: Mapped[bool] = mapped_column(default=False)
    company_id: Mapped[int | None] = mapped_column(ForeignKey("companies.id"))
    fields_json: Mapped[str] = mapped_column(Text, default="{}")
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    page: Mapped[Page] = relationship(back_populates="ads")
    company: Mapped[Company | None] = relationship()


class ReviewItem(Base):
    __tablename__ = "review_items"
    id: Mapped[int] = mapped_column(primary_key=True)
    ad_id: Mapped[int] = mapped_column(ForeignKey("ad_occurrences.id"), unique=True)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    reason: Mapped[str] = mapped_column(Text, default="")
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Job(Base):
    __tablename__ = "jobs"
    __table_args__ = (UniqueConstraint("document_id", "stage"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    document_id: Mapped[int | None] = mapped_column(ForeignKey("documents.id"))
    stage: Mapped[str] = mapped_column(String(50))
    state: Mapped[str] = mapped_column(String(20), default="queued")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=3)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)


class Source(Base):
    __tablename__ = "sources"
    id: Mapped[int] = mapped_column(primary_key=True)
    base_url: Mapped[str] = mapped_column(Text, unique=True)
    label: Mapped[str] = mapped_column(String(255))
    enabled: Mapped[bool] = mapped_column(default=True)
    crawl_strategy: Mapped[str] = mapped_column(String(20), default="html")
    last_crawled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    candidates: Mapped[list["DiscoveredCandidate"]] = relationship(
        back_populates="source", cascade="all, delete-orphan"
    )


class DiscoveredCandidate(Base):
    __tablename__ = "discovered_candidates"
    __table_args__ = (UniqueConstraint("normalized_url"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    source_id: Mapped[int] = mapped_column(ForeignKey("sources.id"), index=True)
    url: Mapped[str] = mapped_column(Text)
    normalized_url: Mapped[str] = mapped_column(Text)
    discovered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    state: Mapped[str] = mapped_column(String(20), default="discovered")
    error: Mapped[str | None] = mapped_column(Text)
    content_sha256: Mapped[str | None] = mapped_column(String(64))
    document_id: Mapped[int | None] = mapped_column(ForeignKey("documents.id"))
    source: Mapped[Source] = relationship(back_populates="candidates")
