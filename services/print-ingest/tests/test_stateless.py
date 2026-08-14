from fastapi.testclient import TestClient

from app.api import stateless
from app.core.config import settings
from app.main import app


class FakeStorage:
    def __init__(self):
        self.objects = {}

    def put_bytes(self, key, data, content_type="application/octet-stream"):
        self.objects[key] = (data, content_type)


def test_process_requires_service_token():
    response = TestClient(app).post(
        "/api/v1/process",
        files={"file": ("document.pdf", b"%PDF-1.7", "application/pdf")},
        data={"output_prefix": "tenants/1/processed/hash"},
    )
    assert response.status_code == 401


def test_process_returns_pages_without_document_rows(monkeypatch):
    storage = FakeStorage()
    monkeypatch.setattr(stateless, "storage", storage)
    monkeypatch.setattr(
        stateless,
        "render_and_extract",
        lambda _data: [
            {
                "page_number": 1,
                "text": "Muster GmbH Telefon 01234 567890 www.muster.de",
                "image_bytes": b"png",
                "classification": "MIXED_CONTENT",
                "ad_probability": 0.48,
            }
        ],
    )
    response = TestClient(app).post(
        "/api/v1/process",
        headers={"x-service-token": settings.service_token},
        files={"file": ("document.pdf", b"%PDF-1.7", "application/pdf")},
        data={"output_prefix": "tenants/1/processed/hash"},
    )
    assert response.status_code == 200
    assert response.json()["pages"][0]["occurrences"][0]["company"] == "Muster GmbH"
    assert "tenants/1/processed/hash/page-0001.png" in storage.objects


def test_process_rejects_non_pdf(monkeypatch):
    monkeypatch.setattr(stateless, "storage", FakeStorage())
    response = TestClient(app).post(
        "/api/v1/process",
        headers={"x-service-token": settings.service_token},
        files={"file": ("document.txt", b"not pdf", "text/plain")},
        data={"output_prefix": "tenants/1/processed/hash"},
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "not_a_real_pdf"


def test_process_rejects_oversized_pdf(monkeypatch):
    monkeypatch.setattr(stateless, "storage", FakeStorage())
    monkeypatch.setattr(stateless.settings, "max_download_mb", 0)
    response = TestClient(app).post(
        "/api/v1/process",
        headers={"x-service-token": settings.service_token},
        files={"file": ("document.pdf", b"%PDF-1.7", "application/pdf")},
        data={"output_prefix": "tenants/1/processed/hash"},
    )
    assert response.status_code == 413
    assert response.json()["detail"] == "file_too_large"
