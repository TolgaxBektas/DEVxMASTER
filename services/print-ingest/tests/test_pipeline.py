from types import SimpleNamespace

from app.models.entities import AdOccurrence, Page
from app.core.config import settings
from app.services import pipeline
from app.services.run50 import Run50Ad, Run50PageResult


class FakeStorage:
    def __init__(self):
        self.objects = {}

    def get_bytes(self, _key):
        return b"%PDF-1.7"

    def put_bytes(self, key, data, content_type="application/octet-stream"):
        self.objects[key] = (data, content_type)


class FakeSession:
    def __init__(self):
        self.rows = []

    def add(self, row):
        self.rows.append(row)

    def flush(self):
        for row in self.rows:
            if isinstance(row, Page) and row.id is None:
                row.id = 1

    def commit(self):
        pass


def test_process_document_stores_crop_metadata_without_changing_detected_bbox(monkeypatch):
    storage = FakeStorage()
    db = FakeSession()
    document = SimpleNamespace(
        id=1,
        state="DOWNLOADED",
        storage_key="source.pdf",
        sha256="abc123",
        page_count=0,
        error=None,
    )
    region = {
        "x": 0.2,
        "y": 0.3,
        "width": 0.4,
        "height": 0.2,
        "confidence": 0.9,
        "evidence": ["geometry"],
        "preview": "Muster GmbH",
    }
    layout = {"page_width": 400, "page_height": 300, "blocks": [], "images": []}
    crop_info = {
        "crop_bbox": {"x": 0.19, "y": 0.29, "width": 0.42, "height": 0.22},
        "margin_mm": {"left": 5.0, "top": 5.0, "right": 5.0, "bottom": 5.0},
        "shortfall": [],
    }
    monkeypatch.setattr(pipeline, "storage", storage)
    monkeypatch.setattr(pipeline, "load_page_gray", lambda _image: None)
    monkeypatch.setattr(
        pipeline,
        "render_and_extract",
        lambda _pdf: [{
            "page_number": 1,
            "text": "Muster GmbH",
            "image_bytes": b"page-png",
            "classification": "MIXED_CONTENT",
            "ad_probability": 0.5,
            "layout": layout,
        }],
    )
    monkeypatch.setattr(
        pipeline,
        "heuristic_ad_regions",
        lambda *_args: [region],
    )
    monkeypatch.setattr(
        pipeline,
        "render_ad_crop_with_margin",
        lambda *_args, **_kwargs: (b"crop-png", crop_info),
    )

    result = pipeline.process_document(db, document)

    occurrence = next(row for row in db.rows if isinstance(row, AdOccurrence))
    assert result["state"] == "REVIEW_REQUIRED"
    assert occurrence.bbox == {
        "x": region["x"],
        "y": region["y"],
        "width": region["width"],
        "height": region["height"],
        "confidence": region["confidence"],
    }
    assert occurrence.extracted_json["crop"] == crop_info
    assert storage.objects["ads/abc123/page-0001-01.png"] == (
        b"crop-png",
        "image/png",
    )


def test_process_document_persists_run50_provenance_and_bbox(monkeypatch):
    storage = FakeStorage()
    db = FakeSession()
    document = SimpleNamespace(
        id=1,
        state="DOWNLOADED",
        storage_key="source.pdf",
        sha256="run50",
        page_count=0,
        error=None,
    )
    region = {
        "x": 0.2,
        "y": 0.3,
        "width": 0.4,
        "height": 0.2,
        "confidence": 0.9,
        "evidence": ["positiv:run50", "positiv:p3"],
        "preview": "Muster GmbH Telefon 01234 567890",
    }
    crop_info = {
        "crop_bbox": {"x": 0.19, "y": 0.29, "width": 0.42, "height": 0.22},
        "margin_mm": {"left": 5.0, "top": 5.0, "right": 5.0, "bottom": 5.0},
        "shortfall": [],
    }
    run50_metadata = {
        "model": "gpt-5.1",
        "detector_prompt_sha256": "detector-hash",
    }
    ad = Run50Ad(
        region=region,
        company="Muster GmbH",
        crop_png=b"run50-crop",
        crop_info=crop_info,
        text="Muster GmbH Telefon 01234 567890",
        run50=run50_metadata,
    )
    monkeypatch.setattr(pipeline, "storage", storage)
    monkeypatch.setattr(settings, "ad_detector", "run50", raising=False)
    monkeypatch.setattr(settings, "openai_api_key", "test-key")
    monkeypatch.setattr(
        pipeline,
        "render_and_extract",
        lambda _pdf: [{
            "page_number": 1,
            "text": "Muster GmbH",
            "image_bytes": b"page-png",
            "classification": "MIXED_CONTENT",
            "ad_probability": 0.5,
            "layout": None,
        }],
    )
    monkeypatch.setattr(pipeline, "ResponsesClient", lambda _key: object())
    monkeypatch.setattr(
        pipeline,
        "detect_document",
        lambda _pdf, _pages, _client, concurrency: [
            Run50PageResult(1, [ad], [], [])
        ],
    )

    result = pipeline.process_document(db, document)

    page = next(row for row in db.rows if isinstance(row, Page))
    occurrence = next(row for row in db.rows if isinstance(row, AdOccurrence))
    assert result["state"] == "REVIEW_REQUIRED"
    assert page.image_key == "pages/run50/page-0001.png"
    assert occurrence.bbox == {
        "x": 0.2,
        "y": 0.3,
        "width": 0.4,
        "height": 0.2,
        "confidence": 0.9,
    }
    assert occurrence.extracted_json["run50"] == run50_metadata
    assert occurrence.extracted_json["crop"] == crop_info
    assert storage.objects["ads/run50/page-0001-01.png"] == (
        b"run50-crop",
        "image/png",
    )
