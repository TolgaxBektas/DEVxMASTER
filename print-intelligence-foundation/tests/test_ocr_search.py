from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.db.base import Base
from app.models import AdOccurrence, Document, ReviewItem
from app.services.discovery import DiscoveryCrawler
from app.services.factory import make_search_provider
from app.services.ocr import OCRResult, RecordedOCRProvider, TesseractOCRProvider
from app.services.search import RecordedSearchProvider, SearchResult
from app.services.storage import LocalStorage
from app.services.pipeline import Pipeline


class _NoopVision:
    def extract_fields(self, _crop_path):
        return {}


def test_ocr_fills_only_empty_fields_and_records_provenance(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'ocr.db'}")
    Base.metadata.create_all(engine)
    digest = "a" * 64
    crop = tmp_path / "work" / digest / "crops" / "page_1_0.png"
    crop.parent.mkdir(parents=True)
    crop.write_bytes(b"not-an-image")
    with Session(engine) as session:
        document = Document(content_sha256=digest, filename="test.pdf")
        session.add(document)
        session.flush()
        occurrence = AdOccurrence(
            page_id=1,
            occurrence_key="1,2,3,4",
            bbox="1,2,3,4",
            crop_path=f"{digest}/crops/page_1_0.png",
        )
        session.add(occurrence)
        session.flush()
        pipeline = Pipeline(
            session,
            _NoopVision(),
            LocalStorage(tmp_path / "storage"),
            local_work_dir=tmp_path / "work",
            ocr_provider=RecordedOCRProvider(
                {
                    "page_1_0.png": OCRResult(
                        {"phone": "999", "email": "ocr@example.de"},
                        {"phone": 0.4, "email": 0.95},
                    )
                }
            ),
        )
        fields = {"address": "existing"}
        provenance = {"address": "vision"}
        data = {"fields": fields}
        pipeline._apply_ocr(fields, provenance, data, occurrence, document)
        assert fields == {
            "address": "existing",
            "phone": "999",
            "email": "ocr@example.de",
        }
        assert provenance == {
            "address": "vision",
            "phone": "ocr",
            "email": "ocr",
        }
        assert data["ocr"]["confidence"]["email"] == 0.95
        review = session.scalar(
            select(ReviewItem).where(ReviewItem.ad_id == occurrence.id)
        )
        assert review is not None
        assert "low confidence OCR field: phone" in review.reason
        assert "low confidence OCR field: email" not in review.reason


def test_tesseract_confidence_is_attributed_to_matching_field_words(
    monkeypatch, tmp_path
):
    import pytesseract
    from PIL import Image

    crop_path = tmp_path / "crop.png"
    Image.new("RGB", (20, 20), "white").save(crop_path)
    monkeypatch.setattr(
        "app.services.ocr.TesseractOCRProvider._ensure_available",
        lambda self: True,
    )
    monkeypatch.setattr(
        pytesseract,
        "image_to_data",
        lambda *args, **kwargs: {
            "text": ["01234", "56789", "good@example.de"],
            "conf": ["20", "20", "95"],
        },
    )
    result = TesseractOCRProvider().extract_fields(str(crop_path))
    assert result.fields["phone"] == "0123456789"
    assert result.fields["email"] == "good@example.de"
    assert result.confidence["phone"] == 0.2
    assert result.confidence["email"] == 0.95


def test_tesseract_reconstructs_lines_for_addresses(monkeypatch, tmp_path):
    import pytesseract
    from PIL import Image

    crop_path = tmp_path / "crop.png"
    Image.new("RGB", (20, 20), "white").save(crop_path)
    monkeypatch.setattr(
        "app.services.ocr.TesseractOCRProvider._ensure_available",
        lambda self: True,
    )
    data = {
        "text": [
            "Musterstraße",
            "1",
            "12345",
            "Berlin",
            "01234",
            "56789",
        ],
        "conf": ["95"] * 6,
        "block_num": [1] * 6,
        "par_num": [1] * 6,
        "line_num": [1, 1, 2, 2, 3, 3],
    }
    monkeypatch.setattr(pytesseract, "image_to_data", lambda *a, **k: data)
    result = TesseractOCRProvider().extract_fields(str(crop_path))
    assert result.fields["address"] == "Musterstraße 1 12345 Berlin"
    assert "\n" in result.text

    data["text"] = ["Musterstraße", "1", "12345", "Berlin", "Betreuung"]
    data["conf"] = ["95"] * 5
    data["block_num"] = [1] * 5
    data["par_num"] = [1] * 5
    data["line_num"] = [1, 1, 2, 2, 3]
    result = TesseractOCRProvider().extract_fields(str(crop_path))
    assert result.fields["address"] == "Musterstraße 1 12345 Berlin"
    assert result.fields["address"] != result.text


def test_ocr_threshold_is_separate_from_detector_threshold(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'ocr-threshold.db'}")
    Base.metadata.create_all(engine)
    digest = "c" * 64
    crop = tmp_path / "work" / digest / "crops" / "page_1_0.png"
    crop.parent.mkdir(parents=True)
    crop.write_bytes(b"not-an-image")
    with Session(engine) as session:
        document = Document(content_sha256=digest, filename="test.pdf")
        session.add(document)
        session.flush()
        occurrence = AdOccurrence(
            page_id=1,
            occurrence_key="1,2,3,4",
            bbox="1,2,3,4",
            crop_path=f"{digest}/crops/page_1_0.png",
        )
        session.add(occurrence)
        session.flush()
        pipeline = Pipeline(
            session,
            _NoopVision(),
            LocalStorage(tmp_path / "storage"),
            confidence_threshold=0.9,
            ocr_confidence_threshold=0.3,
            local_work_dir=tmp_path / "work",
            ocr_provider=RecordedOCRProvider(
                {"page_1_0.png": OCRResult({"email": "ocr@example.de"}, {"email": 0.4})}
            ),
        )
        fields, provenance = {}, {}
        pipeline._apply_ocr(fields, provenance, {"fields": fields}, occurrence, document)
        assert pipeline.confidence_threshold == 0.9
        assert pipeline.ocr_confidence_threshold == 0.3
        assert session.scalar(select(ReviewItem).where(ReviewItem.ad_id == occurrence.id)) is None


def test_tesseract_missing_binary_skips_without_failing(monkeypatch, tmp_path):
    monkeypatch.setattr("app.services.ocr.shutil.which", lambda _: None)
    result = TesseractOCRProvider().extract_fields(str(tmp_path / "crop.png"))
    assert result == OCRResult({}, {})


def test_tesseract_missing_language_data_skips_without_failing(
    monkeypatch, tmp_path
):
    import pytesseract

    monkeypatch.setattr(
        "app.services.ocr.shutil.which", lambda _: "/usr/bin/tesseract"
    )
    monkeypatch.setattr(pytesseract, "get_languages", lambda config="": ["eng"])
    result = TesseractOCRProvider().extract_fields(str(tmp_path / "crop.png"))
    assert result == OCRResult({}, {})


def test_confident_ocr_value_does_not_create_review(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'ocr-confident.db'}")
    Base.metadata.create_all(engine)
    digest = "b" * 64
    crop = tmp_path / "work" / digest / "crops" / "page_1_0.png"
    crop.parent.mkdir(parents=True)
    crop.write_bytes(b"not-an-image")
    with Session(engine) as session:
        document = Document(content_sha256=digest, filename="test.pdf")
        session.add(document)
        session.flush()
        occurrence = AdOccurrence(
            page_id=1,
            occurrence_key="1,2,3,4",
            bbox="1,2,3,4",
            crop_path=f"{digest}/crops/page_1_0.png",
        )
        session.add(occurrence)
        session.flush()
        pipeline = Pipeline(
            session,
            _NoopVision(),
            LocalStorage(tmp_path / "storage"),
            local_work_dir=tmp_path / "work",
            ocr_provider=RecordedOCRProvider(
                {"page_1_0.png": OCRResult({"email": "ocr@example.de"}, {"email": 0.95})}
            ),
        )
        fields, provenance = {}, {}
        data = {"fields": fields}
        pipeline._apply_ocr(fields, provenance, data, occurrence, document)
        assert fields["email"] == "ocr@example.de"
        assert provenance["email"] == "ocr"
        assert session.scalar(select(ReviewItem).where(ReviewItem.ad_id == occurrence.id)) is None


def test_search_provider_is_disabled_by_default_and_records_results():
    assert make_search_provider(Settings()) is None
    provider = RecordedSearchProvider(
        {"brochure": [SearchResult("https://example.test/file.pdf")]}
    )
    assert provider.search("brochure", 1) == [
        SearchResult("https://example.test/file.pdf")
    ]


def test_searxng_provider_uses_compatible_json_contract(monkeypatch):
    class Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "results": [
                    {
                        "url": "https://example.test/file.pdf",
                        "title": "File",
                        "content": "brochure",
                    }
                ]
            }

    monkeypatch.setattr("app.services.search.httpx.get", lambda *args, **kwargs: Response())
    provider = make_search_provider(
        Settings(search_provider="searxng", searxng_url="https://search.test")
    )
    assert provider.search("brochure", 5) == [
        SearchResult("https://example.test/file.pdf", "File", "brochure")
    ]


def test_search_results_are_ssrf_filtered_bounded_and_read_only(monkeypatch):
    provider = RecordedSearchProvider(
        {
            "brochure": [
                SearchResult("http://127.0.0.1/private.pdf"),
                SearchResult("https://good.test/one.pdf"),
                SearchResult("https://good.test/two.pdf"),
            ]
        }
    )

    def validate(url):
        if "127.0.0.1" in url:
            raise ValueError("private URL")

    monkeypatch.setattr("app.services.discovery.validate_public_url", validate)
    crawler = DiscoveryCrawler.for_proposals(
        search_provider=provider, max_entries=3, max_pages=2
    )
    proposals = crawler.propose([], ["brochure"], max_results=2)
    assert proposals == [
        {
            "url": "https://good.test/one.pdf",
            "score": 1.0,
            "found_on": None,
            "origin": {"type": "search", "query": "brochure"},
            "discovery": "search",
        }
    ]
    assert crawler.session is None
