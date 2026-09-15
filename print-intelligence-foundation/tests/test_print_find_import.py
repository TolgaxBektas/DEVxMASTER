import json

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from app.api.dependencies import session_dependency, storage_dependency
from app.db.base import Base
from app.main import app
from app.models import AdOccurrence, Document, Page, ReviewItem
from app.services.storage import LocalStorage


def _client(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'import.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    storage = LocalStorage(tmp_path / "storage")

    def session_override():
        with factory() as session:
            yield session

    app.dependency_overrides[session_dependency] = session_override
    app.dependency_overrides[storage_dependency] = lambda: storage
    return TestClient(app), factory


def _manifest(*, occurrence_id=42, company="Frischer Fund GmbH", proof=None):
    return {
        "company_name": company,
        "preview": "Frischer Fund Vorschau",
        "confidence": 0.95,
        "advertiser_proof": proof or ["positiv:p2", "positiv:p3"],
        "evidence": ["geometry", "positiv:p2", "positiv:p3"],
        "provenance": {
            "data_source": "xdata_germany",
            "center_tenant_id": 7,
            "center_occurrence_id": occurrence_id,
            "document_sha256": "a" * 64,
            "document_filename": "amtsblatt.pdf",
            "source_url": "https://example.test/amtsblatt.pdf",
            "area_name": "Musterkreis",
            "area_ags": "09162",
            "area_state": "Bayern",
            "publication": "Musterblatt",
            "edition": "Ausgabe 4",
            "year": 2026,
            "issue": 4,
            "page": 3,
            "bbox": [0.1, 0.2, 0.3, 0.4],
        },
    }


def _files(manifest):
    return {
        "original": ("original.png", b"original-bytes", "image/png"),
        "manifest": (None, json.dumps(manifest), "application/json"),
    }


def test_print_find_import_creates_pending_review_and_is_open(tmp_path):
    client, factory = _client(tmp_path)
    try:
        response = client.post(
            "/imports/print-find",
            files=_files(_manifest()),
        )
        assert response.status_code == 200
        body = response.json()
        assert body["review_status"] == "pending"
        assert body["deduplicated"] is False

        with factory() as session:
            document = session.scalar(select(Document))
            page = session.scalar(select(Page))
            occurrence = session.scalar(select(AdOccurrence))
            review = session.scalar(select(ReviewItem))
            assert document is not None
            assert page is not None
            assert occurrence is not None
            assert review is not None
            assert review.status == "pending"
            assert review.reason == (
                "frischer Internetfund, menschliche Freigabe erforderlich"
            )
            assert occurrence.source_explicit is True
            assert occurrence.restoration_path is None
            assert occurrence.restoration_manifest_json == "{}"
            assert json.loads(occurrence.artwork_metadata_json)["provenance"]["page"] == 3
            assert json.loads(occurrence.fields_json) == {
                "fields": {"company": "Frischer Fund GmbH"}
            }

        open_reviews = client.get("/api/v1/reviews/open")
        assert open_reviews.status_code == 200
        assert len(open_reviews.json()) == 1
        assert open_reviews.json()[0]["ad_id"] == body["ad_id"]
        assert open_reviews.json()[0]["images"] == {
            "original_available": True,
            "restored_available": False,
        }
    finally:
        app.dependency_overrides.clear()


def test_print_find_import_deduplicates_and_keeps_decision(tmp_path):
    client, factory = _client(tmp_path)
    try:
        first = client.post("/imports/print-find", files=_files(_manifest()))
        assert first.status_code == 200
        with factory() as session:
            review = session.scalar(select(ReviewItem))
            assert review is not None
            review_id = review.id
        decision = client.post(
            f"/api/v1/reviews/{review_id}/decision",
            json={"decision": "approve"},
        )
        assert decision.status_code == 200

        second = client.post("/imports/print-find", files=_files(_manifest()))
        assert second.status_code == 200
        assert second.json()["deduplicated"] is True
        assert second.json()["review_status"] == "approved"
        with factory() as session:
            assert session.scalar(select(func.count(Document.id))) == 1
            assert session.scalar(select(func.count(AdOccurrence.id))) == 1
            assert session.scalar(select(func.count(ReviewItem.id))) == 1
            assert session.scalar(select(ReviewItem.status)) == "approved"
    finally:
        app.dependency_overrides.clear()


def test_print_find_import_two_occurrences_share_document_and_page(tmp_path):
    client, factory = _client(tmp_path)
    try:
        first = client.post("/imports/print-find", files=_files(_manifest()))
        second = client.post(
            "/imports/print-find",
            files=_files(_manifest(occurrence_id=43, company="Zweiter Fund GmbH")),
        )
        assert first.status_code == second.status_code == 200
        assert first.json()["document_id"] == second.json()["document_id"]
        with factory() as session:
            assert session.scalar(select(func.count(Document.id))) == 1
            assert session.scalar(select(func.count(Page.id))) == 1
            assert session.scalar(select(func.count(AdOccurrence.id))) == 2
            assert session.scalar(select(func.count(ReviewItem.id))) == 2
    finally:
        app.dependency_overrides.clear()


def test_print_find_import_requires_positive_advertiser_proof(tmp_path):
    client, _ = _client(tmp_path)
    try:
        response = client.post(
            "/imports/print-find",
            files=_files(_manifest(proof=["geometry", "fehlend:p4"])),
        )
        assert response.status_code == 422
        assert response.json()["detail"] == "advertiser proof required"
    finally:
        app.dependency_overrides.clear()
