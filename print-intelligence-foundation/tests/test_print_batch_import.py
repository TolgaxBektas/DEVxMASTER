import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.api.dependencies import session_dependency, storage_dependency
from app.api import imports as imports_api
from app.db.base import Base
from app.core.config import Settings
from app.main import app
from app.models import AdOccurrence, Company, Document, Page, ReviewItem
from app.services.storage import LocalStorage


def _metadata():
    return {
        "company_name": "Import Test GmbH",
        "source": {
            "publication": "Testblatt",
            "issue": "01/2026",
            "page": 4,
            "url": "https://example.test/testblatt.pdf",
        },
        "bbox": [1, 2, 30, 40],
        "crop_size": [1200, 800],
        "evidence": {
            "verified": True,
            "website_domain": {
                "value": "import-test.example",
                "source_url": "https://import-test.example/impressum",
                "retrieved_at": "2026-01-01T00:00:00Z",
            },
        },
        "plan_digest": "run50-import-test-plan",
        "prompt_hash": "a" * 64,
        "model_name": "gpt-image-2",
        "output_size": "1200x800",
        "usage": {"output_tokens": 100},
        "cost": {"total_cost_usd": 0.12},
        "restaurierung": {"verification": {"anchors": "passed"}},
    }


def _client(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'import.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    storage = LocalStorage(tmp_path / "storage")

    def session_override():
        with factory() as session:
            yield session

    app.dependency_overrides[session_dependency] = session_override
    app.dependency_overrides[storage_dependency] = lambda: storage
    return TestClient(app), factory, storage


def _files(metadata=None):
    return {
        "original": ("original.png", b"original-bytes", "image/png"),
        "restored": ("restored.png", b"restored-bytes", "image/png"),
        "metadata": (
            None,
            json.dumps(metadata or _metadata()),
            "application/json",
        ),
    }


def test_print_batch_import_is_idempotent_and_reviewable(tmp_path):
    client, factory, storage = _client(tmp_path)
    try:
        first = client.post("/imports/print-batch", files=_files())
        second = client.post("/imports/print-batch", files=_files())
        assert first.status_code == second.status_code == 200
        assert first.json()["document_id"] == second.json()["document_id"]
        assert first.json()["ad_id"] == second.json()["ad_id"]

        with factory() as session:
            assert len(session.scalars(select(Document)).all()) == 1
            assert len(session.scalars(select(AdOccurrence)).all()) == 1
            reviews = session.scalars(select(ReviewItem)).all()
            assert len(reviews) == 1
            assert reviews[0].status == "pending"
            assert reviews[0].reason == (
                "generativ erzeugt, menschliche Freigabe erforderlich"
            )
        queue = client.get("/review-queue")
        assert queue.status_code == 200
        assert len(queue.json()) == 1
    finally:
        app.dependency_overrides.clear()


def test_print_batch_import_rejects_incomplete_case_without_record(tmp_path):
    client, factory, _ = _client(tmp_path)
    try:
        metadata = _metadata()
        metadata.pop("prompt_hash")
        response = client.post(
            "/imports/print-batch",
            files=_files(metadata),
        )
        assert response.status_code == 422
        with factory() as session:
            assert session.scalars(select(Document)).all() == []
            assert session.scalars(select(Page)).all() == []
            assert session.scalars(select(AdOccurrence)).all() == []
            assert session.scalars(select(Company)).all() == []
            assert session.scalars(select(ReviewItem)).all() == []
    finally:
        app.dependency_overrides.clear()


def test_print_batch_import_rejects_upload_over_limit(tmp_path, monkeypatch):
    client, factory, _ = _client(tmp_path)
    monkeypatch.setattr(
        imports_api, "get_settings", lambda: Settings(max_download_bytes=3)
    )
    try:
        response = client.post("/imports/print-batch", files=_files())
        assert response.status_code == 413
        with factory() as session:
            assert session.scalars(select(Document)).all() == []
            assert session.scalars(select(AdOccurrence)).all() == []
    finally:
        app.dependency_overrides.clear()


def test_print_batch_import_uses_canonical_company_normalization(tmp_path):
    client, factory, _ = _client(tmp_path)
    try:
        first = _metadata()
        first["company_name"] = "Import-Test GmbH"
        second = _metadata()
        second["company_name"] = "Import Test GmbH"
        second["source"]["page"] = 5
        assert client.post("/imports/print-batch", files=_files(first)).status_code == 200
        assert client.post("/imports/print-batch", files=_files(second)).status_code == 200
        with factory() as session:
            companies = session.execute(
                select(AdOccurrence.company_id)
            ).all()
            assert len(companies) == 2
            assert len({row[0] for row in companies}) == 1
            company = session.scalar(select(Company))
            assert company.normalized_name == "import test gmbh"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.parametrize("page", [None, "vier"])
def test_print_batch_import_rejects_invalid_source_page(tmp_path, page):
    client, factory, _ = _client(tmp_path)
    try:
        metadata = _metadata()
        metadata["source"]["page"] = page
        response = client.post("/imports/print-batch", files=_files(metadata))
        assert response.status_code == 422
        with factory() as session:
            assert session.scalars(select(Document)).all() == []
            assert session.scalars(select(Page)).all() == []
            assert session.scalars(select(AdOccurrence)).all() == []
            assert session.scalars(select(Company)).all() == []
            assert session.scalars(select(ReviewItem)).all() == []
    finally:
        app.dependency_overrides.clear()


def test_print_batch_import_serves_original_restored_and_manifest(tmp_path):
    client, _, _ = _client(tmp_path)
    try:
        imported = client.post("/imports/print-batch", files=_files())
        data = imported.json()
        original = client.get(data["artwork_url"])
        restored = client.get(data["restoration_url"])
        manifest = client.get(data["manifest_url"])
        assert original.status_code == restored.status_code == 200
        assert original.content == b"original-bytes"
        assert restored.content == b"restored-bytes"
        assert manifest.json()["geometry_quality"]["status"] == (
            "external_generated_not_geometrically_measured"
        )
    finally:
        app.dependency_overrides.clear()
