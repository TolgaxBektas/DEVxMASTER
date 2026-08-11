from pathlib import Path

import pytest
from fastapi import Depends
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api import compat
from app.api import auth
from app.api.dependencies import (
    pipeline_dependency,
    session_dependency,
    storage_dependency,
)
from app.main import app
from app.db.base import Base
from app.models import AdOccurrence, Company, Document, Job, Page, ReviewItem
from app.core.config import Settings
from app.services.pipeline import Pipeline
from app.services.discovery import DiscoveryCrawler
from app.services.storage import LocalStorage
from app.services.vision.recorded import RecordedVisionProvider


FIXTURE = Path("tests/fixtures/Seniorenpost_Mai_Juni_2026.pdf")


@pytest.fixture
def isolated_db(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'compat.db'}")
    Base.metadata.create_all(engine)
    yield engine, sessionmaker(bind=engine, expire_on_commit=False)


@pytest.fixture
def compatibility_client(monkeypatch, isolated_db, tmp_path):
    _, factory = isolated_db
    storage = LocalStorage(tmp_path / "storage")
    settings = Settings(
        service_token="compat-token",
        auth_disabled=False,
        max_download_bytes=50_000_000,
        render_dpi=12,
        local_work_dir=tmp_path / "work",
        storage_path=tmp_path / "storage",
    )
    monkeypatch.setattr(compat, "get_settings", lambda: settings)
    monkeypatch.setattr(auth, "get_settings", lambda: settings)

    def session_override():
        with factory() as session:
            yield session

    def pipeline_override(session=Depends(session_dependency)):
        return Pipeline(
            session,
            RecordedVisionProvider("tests/fixtures/qwen"),
            storage,
            render_dpi=12,
            local_work_dir=tmp_path / "work",
        )

    app.dependency_overrides[session_dependency] = session_override
    app.dependency_overrides[pipeline_dependency] = pipeline_override
    app.dependency_overrides[storage_dependency] = lambda: storage
    try:
        with TestClient(app) as client:
            yield client, factory, settings
    finally:
        app.dependency_overrides.clear()


def _upload(client, token="compat-token", output_prefix="tenant/document"):
    return client.post(
        "/api/v1/process",
        headers={"x-service-token": token},
        data={"output_prefix": output_prefix},
        files={
            "file": (
                "seniorenpost.pdf",
                FIXTURE.read_bytes(),
                "application/pdf",
            )
        },
    )


def test_process_publishes_distinct_occurrences_and_is_idempotent(
    compatibility_client,
):
    client, factory, _ = compatibility_client
    first = _upload(client)
    assert first.status_code == 200, first.text
    pages = first.json()["pages"]
    page_11 = next(page for page in pages if page["page_number"] == 11)
    occurrences = page_11["occurrences"]
    assert len(occurrences) == 4
    crop_keys = [occurrence["image_key"] for occurrence in occurrences]
    assert len(set(crop_keys)) == 4
    assert all(key.startswith("tenant/document/") for key in crop_keys)
    assert all(occurrence["restored_artwork_key"] for occurrence in occurrences)
    for occurrence in occurrences:
        assert set(occurrence["bbox"]) == {"x", "y", "width", "height"}
        assert all(0 <= value <= 1 for value in occurrence["bbox"].values())
        assert set(occurrence["pixel_bbox"]) == {"x", "y", "width", "height"}
        assert occurrence["render_dpi"] == 12
    assert page_11["text"]
    assert page_11["ad_probability"] >= max(
        occurrence["confidence"] for occurrence in occurrences
    )
    assert page_11["classification"] in {
        "cover",
        "editorial",
        "ad-page",
        "mixed",
        "blank",
    }

    second = _upload(client)
    assert second.status_code == 200, second.text
    with factory() as session:
        assert session.query(Document).count() == 1
        assert session.query(Page).count() == 44
        assert session.query(AdOccurrence).count() == 4
        assert session.query(Company).count() == 4
        assert session.query(ReviewItem).count() == 1
        assert session.query(Job).count() == 6


def test_compatibility_auth_rejects_missing_and_wrong_tokens(compatibility_client):
    client, _, _ = compatibility_client
    missing = client.post(
        "/api/v1/discovery/proposals",
        json={"seed_pages": [], "search_terms": [], "max_results": 1},
    )
    wrong = client.post(
        "/api/v1/discovery/proposals",
        headers={"x-service-token": "wrong"},
        json={"seed_pages": [], "search_terms": [], "max_results": 1},
    )
    assert missing.status_code == wrong.status_code == 401


def test_compatibility_auth_accepts_existing_bearer_token(
    monkeypatch, compatibility_client
):
    client, _, _ = compatibility_client
    monkeypatch.setattr(
        "app.services.discovery.DiscoveryCrawler.propose", lambda *args: []
    )
    response = client.post(
        "/api/v1/discovery/proposals",
        headers={"Authorization": "Bearer compat-token"},
        json={"seed_pages": [], "search_terms": [], "max_results": 1},
    )
    assert response.status_code == 200


def test_process_rejects_invalid_prefix_and_oversized_upload(compatibility_client):
    client, _, settings = compatibility_client
    invalid = _upload(client, output_prefix="../escape")
    assert invalid.status_code == 400
    assert invalid.json()["detail"] == "invalid_output_prefix"

    settings.max_download_bytes = 8
    oversized = _upload(client)
    assert oversized.status_code == 413


@pytest.mark.parametrize("payload", [b"", b"not a pdf", FIXTURE.read_bytes()[:100]])
def test_process_rejects_malformed_upload_before_pipeline(
    compatibility_client, payload
):
    client, factory, _ = compatibility_client
    response = client.post(
        "/api/v1/process",
        headers={"x-service-token": "compat-token"},
        data={"output_prefix": "tenant/document"},
        files={"file": ("broken.pdf", payload, "application/pdf")},
    )
    assert response.status_code == 400
    with factory() as session:
        assert session.query(Document).count() == 0
        assert session.query(Job).count() == 0


def test_fetch_rejects_ssrf_url(compatibility_client):
    client, _, _ = compatibility_client
    response = client.post(
        "/api/v1/fetch",
        headers={"x-service-token": "compat-token"},
        json={"url": "http://127.0.0.1/document.pdf"},
    )
    assert response.status_code == 400


def test_fetch_returns_pdf_and_source_headers(monkeypatch, compatibility_client):
    client, _, _ = compatibility_client
    monkeypatch.setattr(
        compat,
        "download_with_metadata",
        lambda url, limit: (
            b"%PDF-test",
            {
                "final_url": "https://example.test/final.pdf",
                "sha256": "abc123",
                "filename": "../../final\x00report.pdf",
            },
        ),
    )
    response = client.post(
        "/api/v1/fetch",
        headers={"x-service-token": "compat-token"},
        json={"url": "https://example.test/source.pdf"},
    )
    assert response.status_code == 200
    assert response.content == b"%PDF-test"
    assert response.headers["x-source-url"] == "https://example.test/final.pdf"
    assert response.headers["x-source-sha256"] == "abc123"
    assert response.headers["content-disposition"] == (
        'attachment; filename="finalreport.pdf"'
    )


def test_proposals_are_read_only(monkeypatch, compatibility_client):
    client, factory, _ = compatibility_client
    monkeypatch.setattr(
        "app.services.discovery.DiscoveryCrawler.propose",
        lambda self, seed_pages, search_terms, max_results: [
            {
                "url": "https://example.test/file.pdf",
                "score": 1.0,
                "found_on": seed_pages[0],
                "discovery": "seed_page",
            }
        ],
    )
    response = client.post(
        "/api/v1/discovery/proposals",
        headers={"x-service-token": "compat-token"},
        json={
            "seed_pages": ["https://example.test/"],
            "search_terms": ["senior"],
            "max_results": 10,
        },
    )
    assert response.status_code == 200
    assert response.json()["proposals"][0]["url"].endswith(".pdf")
    with factory() as session:
        assert session.query(Document).count() == 0
        assert session.query(Page).count() == 0


def test_proposal_crawler_rejects_stateful_operations_without_session():
    crawler = DiscoveryCrawler.for_proposals()
    with pytest.raises(
        RuntimeError, match="stateful discovery operation requires a database session"
    ):
        crawler.crawl(None)
