from fastapi.testclient import TestClient

from app.api import stateless
from app.core.config import settings
from app.main import app


def test_company_from_text_prefers_legal_entity_over_slogan():
    assert stateless._company_from_text(
        "Im ganzen Landkreis für Sie da. "
        "Caritasverband für Stadt und Landkreis Passau e. V. "
        "Telefon 0851 123456"
    ) == "Caritasverband für Stadt und Landkreis Passau e. V."

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
        "heuristic_ad_regions",
        lambda *_args: [{
            "x": 0.1,
            "y": 0.1,
            "width": 0.8,
            "height": 0.8,
            "confidence": 0.8,
            "evidence": ["phone"],
            "preview": "Muster GmbH Telefon 01234 567890 info@muster.de www.muster.de 12345  Musterstadt",
        }],
    )
    monkeypatch.setattr(stateless, "render_ad_crop", lambda *_args: b"crop-png")
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
    assert response.json()["pages"][0]["occurrences"][0]["contacts"] == {
        "phone": "01234 567890",
        "email": "info@muster.de",
        "website": "www.muster.de",
        "postal_code": "12345",
        "city": "Musterstadt",
    }
    assert "tenants/1/processed/hash/page-0001.png" in storage.objects


def test_process_keeps_distinct_ad_keys_and_region_text(monkeypatch):
    storage = FakeStorage()
    monkeypatch.setattr(stateless, "storage", storage)
    monkeypatch.setattr(
        stateless,
        "heuristic_ad_regions",
        lambda *_args: [
            {
                "x": 0.0,
                "y": 0.0,
                "width": 0.4,
                "height": 1.0,
                "confidence": 0.8,
                "evidence": ["geometry"],
                "preview": "Alpha GmbH Telefon 01234 567890",
            },
            {
                "x": 0.6,
                "y": 0.0,
                "width": 0.4,
                "height": 1.0,
                "confidence": 0.9,
                "evidence": ["geometry"],
                "preview": "Beta AG www.beta.example",
            },
        ],
    )
    monkeypatch.setattr(stateless, "render_ad_crop", lambda *_args: b"crop-png")
    monkeypatch.setattr(
        stateless,
        "render_and_extract",
        lambda _data: [
            {
                "page_number": 1,
                "text": "Redaktioneller Text ohne Werbetreibenden",
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
    occurrences = response.json()["pages"][0]["occurrences"]
    assert [item["image_key"] for item in occurrences] == [
        "tenants/1/processed/hash/ad-0001-01.png",
        "tenants/1/processed/hash/ad-0001-02.png",
    ]
    assert [item["company"] for item in occurrences] == ["Alpha GmbH", "Beta AG"]
    assert [item["preview"] for item in occurrences] == [
        "Alpha GmbH Telefon 01234 567890",
        "Beta AG www.beta.example",
    ]
    assert [item["bbox"] for item in occurrences] == [
        {"x": 0.0, "y": 0.0, "width": 0.4, "height": 1.0, "confidence": 0.8},
        {"x": 0.6, "y": 0.0, "width": 0.4, "height": 1.0, "confidence": 0.9},
    ]
    assert [item["evidence"] for item in occurrences] == [["geometry"], ["geometry"]]
    assert [item["contacts"] for item in occurrences] == [
        {
            "phone": "01234 567890",
            "email": None,
            "website": None,
            "postal_code": None,
            "city": None,
        },
        {
            "phone": None,
            "email": None,
            "website": "www.beta.example",
            "postal_code": None,
            "city": None,
        },
    ]
    assert all(set(item["bbox"]) == {"x", "y", "width", "height", "confidence"} for item in occurrences)


def test_process_does_not_use_page_text_for_contact_fields(monkeypatch):
    storage = FakeStorage()
    monkeypatch.setattr(stateless, "storage", storage)
    monkeypatch.setattr(
        stateless,
        "heuristic_ad_regions",
        lambda *_args: [{
            "x": 0.0,
            "y": 0.0,
            "width": 0.5,
            "height": 1.0,
            "confidence": 0.8,
            "evidence": ["geometry"],
            "preview": "Muster GmbH",
        }],
    )
    monkeypatch.setattr(stateless, "render_ad_crop", lambda *_args: b"crop-png")
    monkeypatch.setattr(
        stateless,
        "render_and_extract",
        lambda _data: [{
            "page_number": 1,
            "text": "Redaktion Telefon 030 123456 außerhalb der Anzeige",
            "image_bytes": b"png",
            "classification": "MIXED_CONTENT",
            "ad_probability": 0.48,
        }],
    )
    response = TestClient(app).post(
        "/api/v1/process",
        headers={"x-service-token": settings.service_token},
        files={"file": ("document.pdf", b"%PDF-1.7", "application/pdf")},
        data={"output_prefix": "tenants/1/processed/hash"},
    )
    assert response.status_code == 200
    assert response.json()["pages"][0]["occurrences"][0]["contacts"] == {
        "phone": None,
        "email": None,
        "website": None,
        "postal_code": None,
        "city": None,
    }


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
