import json

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.api import auth
from app.api.compat_reviews import _image_available
from app.api.dependencies import session_dependency, storage_dependency
from app.core.config import Settings
from app.db.base import Base
from app.main import app
from app.models import AdOccurrence, Company, Page, ReviewItem
from app.services.storage import LocalStorage


def _metadata(name: str, page: int) -> dict:
    return {
        "company_name": name,
        "source": {
            "publication": "Reviewblatt",
            "issue": "01/2026",
            "page": page,
            "url": f"https://example.test/{page}.pdf",
        },
        "bbox": [1, 2, 30, 40],
        "crop_size": [1200, 800],
        "evidence": {"verified": True},
        "plan_digest": f"plan-{page}",
        "prompt_hash": "a" * 64,
        "model_name": "gpt-image-2",
        "output_size": "1200x800",
        "usage": {"output_tokens": 100},
        "cost": {"total_cost_usd": 0.12},
        "restaurierung": {
            "review_status": "pending",
            "geometry_quality": {"status": "external"},
        },
    }


def _files(metadata: dict, original: bytes = b"original", restored: bytes = b"restored"):
    return {
        "original": ("original.png", original, "image/png"),
        "restored": ("restored.png", restored, "image/png"),
        "metadata": (None, json.dumps(metadata), "application/json"),
    }


def _import(client, metadata, original=b"original", restored=b"restored"):
    return client.post(
        "/imports/print-batch",
        headers={"Authorization": "Bearer review-token"},
        files=_files(metadata, original, restored),
    )


def _client(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'reviews.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    storage = LocalStorage(tmp_path / "storage")
    settings = Settings(service_token="review-token", auth_disabled=False)
    monkeypatch.setattr(auth, "get_settings", lambda: settings)

    def session_override():
        with factory() as session:
            yield session

    app.dependency_overrides[session_dependency] = session_override
    app.dependency_overrides[storage_dependency] = lambda: storage
    return TestClient(app), factory


def test_open_review_list_contains_metadata_and_image_availability(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    try:
        imported = _import(client, _metadata("Review Test GmbH", 4))
        assert imported.status_code == 200
        response = client.get(
            "/api/v1/reviews/open",
            headers={"x-service-token": "review-token"},
        )
        assert response.status_code == 200
        item = response.json()[0]
        assert item["reason"] == "generativ erzeugt, menschliche Freigabe erforderlich"
        assert item["page"] == 4
        assert item["company"]["name"] == "Review Test GmbH"
        assert item["company"]["verification"] == {"verified": True}
        assert item["data_source"] == "xdata_nb_high_quality"
        assert item["restoration"]["review_status"] == "pending"
        assert item["restoration"]["geometry_quality_status"] == (
            "external_generated_not_geometrically_measured"
        )
        assert item["images"] == {
            "original_available": True,
            "restored_available": True,
        }
    finally:
        app.dependency_overrides.clear()


def test_review_source_filter_separates_open_cases(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    try:
        assert _import(client, _metadata("Filtered Review GmbH", 10)).status_code == 200
        high_quality = client.get(
            "/api/v1/reviews/open?data_source=xdata_nb_high_quality",
            headers={"x-service-token": "review-token"},
        )
        germany = client.get(
            "/api/v1/reviews/open?data_source=xdata_germany",
            headers={"x-service-token": "review-token"},
        )
        invalid = client.get(
            "/api/v1/reviews/open?data_source=other",
            headers={"x-service-token": "review-token"},
        )
        assert len(high_quality.json()) == 1
        assert germany.json() == []
        assert invalid.status_code == 422
    finally:
        app.dependency_overrides.clear()


def test_case_source_stays_germany_when_company_is_high_quality(tmp_path, monkeypatch):
    client, factory = _client(tmp_path, monkeypatch)
    try:
        imported = _import(client, _metadata("Gemeinsame Firma GmbH", 10))
        with factory() as session:
            occurrence = session.scalar(
                select(AdOccurrence).where(AdOccurrence.id == imported.json()["ad_id"])
            )
            company = session.get(Company, occurrence.company_id)
            occurrence.data_source = "xdata_germany"
            company.data_source = "xdata_nb_high_quality"
            session.commit()
        items = client.get(
            "/api/v1/reviews/open?data_source=xdata_germany",
            headers={"x-service-token": "review-token"},
        ).json()
        assert len(items) == 1
        assert items[0]["data_source"] == "xdata_germany"
        assert client.get(
            "/api/v1/reviews/open?data_source=xdata_nb_high_quality",
            headers={"x-service-token": "review-token"},
        ).json() == []
    finally:
        app.dependency_overrides.clear()


def test_imported_contact_values_and_verification_are_normalized(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    try:
        verified_metadata = _metadata("Altenzentrum Wetzlar", 8)
        verified_metadata["evidence"] = {
            "verified": True,
            "reason": "Website belegt.",
            "website_domain": {
                "value": "www.altenzentrum-wetzlar.de",
                "source_url": "https://example.test/contact",
                "retrieved_at": "2026-08-15T05:17:45+00:00",
            },
            "emails": [],
            "phones": [
                {
                    "value": "06441 / 9954 00",
                    "source_url": "https://example.test/contact",
                    "retrieved_at": "2026-08-15T05:17:45+00:00",
                }
            ],
            "sources": ["https://example.test/contact"],
        }
        unverified_metadata = _metadata("Ungeprüfte Firma", 9)
        unverified_metadata["evidence"] = {
            "verified": False,
            "reason": "Kein belastbarer Beleg.",
            "sources": [],
        }
        assert _import(client, verified_metadata).status_code == 200
        assert _import(client, unverified_metadata).status_code == 200
        items = client.get(
            "/api/v1/reviews/open",
            headers={"x-service-token": "review-token"},
        ).json()
        verified = next(item for item in items if item["company"]["name"] == "Altenzentrum Wetzlar")
        assert verified["company"]["extracted_values"] == {
            "company": "Altenzentrum Wetzlar",
            "website": "www.altenzentrum-wetzlar.de",
            "phones": ["06441 / 9954 00"],
        }
        assert verified["company"]["evidence"]["website"] == {
            "source_url": "https://example.test/contact",
            "retrieved_at": "2026-08-15T05:17:45+00:00",
        }
        assert verified["company"]["verification"] == {
            "verified": True,
            "reason": "Website belegt.",
            "sources": ["https://example.test/contact"],
        }
        unverified = next(item for item in items if item["company"]["name"] == "Ungeprüfte Firma")
        assert unverified["company"]["verification"]["verified"] is False
    finally:
        app.dependency_overrides.clear()


def test_review_images_are_byte_identical_and_missing_is_404(tmp_path, monkeypatch):
    client, factory = _client(tmp_path, monkeypatch)
    try:
        imported = _import(
            client,
            _metadata("Image Test GmbH", 4),
            b"original-file",
            b"restored-file",
        )
        item_id = imported.json()["ad_id"]
        review_id = client.get(
            "/api/v1/reviews/open", headers={"x-service-token": "review-token"}
        ).json()[0]["id"]
        original = client.get(
            f"/api/v1/reviews/{review_id}/original",
            headers={"x-service-token": "review-token"},
        )
        restored = client.get(
            f"/api/v1/reviews/{review_id}/restored",
            headers={"x-service-token": "review-token"},
        )
        assert original.content == b"original-file"
        assert restored.content == b"restored-file"
        assert item_id > 0
        with factory() as session:
            occurrence = session.scalar(
                select(AdOccurrence).where(AdOccurrence.id == item_id)
            )
            occurrence.restoration_path = None
            session.commit()
        missing = client.get(
            f"/api/v1/reviews/{review_id}/restored",
            headers={"x-service-token": "review-token"},
        )
        assert missing.status_code == 404
    finally:
        app.dependency_overrides.clear()


def test_decision_sets_status_note_and_next_open_id(tmp_path, monkeypatch):
    client, factory = _client(tmp_path, monkeypatch)
    try:
        first = _import(client, _metadata("First Review GmbH", 4))
        second = _import(client, _metadata("Second Review GmbH", 5))
        first_review = next(
            item["id"]
            for item in client.get(
                "/api/v1/reviews/open",
                headers={"x-service-token": "review-token"},
            ).json()
            if item["ad_id"] == first.json()["ad_id"]
        )
        second_review = next(
            item["id"]
            for item in client.get(
                "/api/v1/reviews/open",
                headers={"x-service-token": "review-token"},
            ).json()
            if item["ad_id"] == second.json()["ad_id"]
        )
        response = client.post(
            f"/api/v1/reviews/{first_review}/decision",
            headers={"x-service-token": "review-token"},
            json={"decision": "approve", "note": "Geprüft"},
        )
        assert response.status_code == 200
        assert response.json()["next_open_id"] == second_review
        with factory() as session:
            item = session.get(ReviewItem, first_review)
            assert item.status == "approved"
            assert item.review_note == "Geprüft"
    finally:
        app.dependency_overrides.clear()


def test_review_rejects_unknown_and_invalid_decisions(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    try:
        unknown = client.get(
            "/api/v1/reviews/999/original",
            headers={"x-service-token": "review-token"},
        )
        unknown_detail = client.get(
            "/api/v1/reviews/999",
            headers={"x-service-token": "review-token"},
        )
        invalid = client.post(
            "/api/v1/reviews/999/decision",
            headers={"x-service-token": "review-token"},
            json={"decision": "later"},
        )
        assert unknown.status_code == 404
        assert unknown_detail.status_code == 404
        assert invalid.status_code == 400
    finally:
        app.dependency_overrides.clear()


def test_review_requires_compat_token(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    try:
        response = client.get("/api/v1/reviews/open")
        assert response.status_code == 401
    finally:
        app.dependency_overrides.clear()


def test_review_list_includes_orphaned_review_item(tmp_path, monkeypatch):
    client, factory = _client(tmp_path, monkeypatch)
    try:
        imported = _import(client, _metadata("Orphan Review GmbH", 6))
        with factory() as session:
            page = session.scalar(select(Page))
            session.add(
                ReviewItem(
                    page_id=page.id,
                    status="pending",
                    reason="Zuordnung fehlt",
                )
            )
            session.commit()
        items = client.get(
            "/api/v1/reviews/open",
            headers={"x-service-token": "review-token"},
        ).json()
        orphan = next(item for item in items if item["reason"] == "Zuordnung fehlt")
        assert orphan["ad_id"] is None
        assert orphan["page"] == 6
        assert orphan["images"] == {
            "original_available": False,
            "restored_available": False,
        }
        assert imported.status_code == 200
    finally:
        app.dependency_overrides.clear()


def test_image_availability_uses_existence_without_reading_bytes():
    class ExistsOnlyStorage:
        def exists(self, path):
            assert path == "stored.png"
            return True

        def get(self, path):
            raise AssertionError("image bytes must not be read")

    assert _image_available(ExistsOnlyStorage(), "stored.png") is True


def test_legacy_decision_without_note_preserves_existing_note(tmp_path, monkeypatch):
    client, factory = _client(tmp_path, monkeypatch)
    try:
        imported = _import(client, _metadata("Note Test GmbH", 7))
        review_id = client.get(
            "/api/v1/reviews/open", headers={"x-service-token": "review-token"}
        ).json()[0]["id"]
        with factory() as session:
            item = session.get(ReviewItem, review_id)
            item.review_note = "Vorhandene Notiz"
            session.commit()
        response = client.post(
            f"/review-queue/{review_id}/approve",
            headers={"Authorization": "Bearer review-token"},
        )
        assert response.status_code == 200
        with factory() as session:
            assert session.get(ReviewItem, review_id).review_note == "Vorhandene Notiz"
        assert imported.status_code == 200
    finally:
        app.dependency_overrides.clear()
