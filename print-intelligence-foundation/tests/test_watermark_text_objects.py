import json
from types import SimpleNamespace

from PIL import Image
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.db.base import Base
from app.models import AdOccurrence, ReviewItem
from app.services.bbox import Box
from app.services.pipeline import Pipeline
from app.services.restoration import RestorationResult
from app.services.storage import LocalStorage
from app.services.watermark_text_objects import (
    clean_pdf,
    verify_cleaned_ad,
)
from app.services.vision.recorded import RecordedVisionProvider
from tests.test_order_forms import _pdf


def test_cleaned_pdf_removes_marker_without_external_pixel_changes(tmp_path):
    source = tmp_path / "source.pdf"
    cleaned = tmp_path / "cleaned.pdf"
    source.write_bytes(_pdf([["© inixmedia"]]))
    box = Box(0, 0, 1020, 1320)

    result = clean_pdf(source, cleaned, {1: [box]}, ["inixmedia"])
    verification = verify_cleaned_ad(
        source, result.pdf_path, 1, box, ["inixmedia"], 120
    )

    assert result.removed_blocks
    assert verification.passed
    assert verification.marker_check["markers_after"] == 0
    assert verification.pixel_check["changed_pixels_outside"] == 0


def _pipeline(tmp_path, provider=object()):
    engine = create_engine(f"sqlite:///{tmp_path / 'restoration.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    session = factory()
    pipeline = Pipeline(
        session,
        RecordedVisionProvider("tests/fixtures/qwen"),
        LocalStorage(tmp_path / "storage"),
        restoration_enabled=True,
        image_edit_provider=provider,
        local_work_dir=tmp_path / "work",
    )
    occurrence = AdOccurrence(
        page_id=1,
        occurrence_key="1,1,40,40",
        bbox="1,1,40,40",
        fields_json=json.dumps({"fields": {}}),
    )
    session.add(occurrence)
    session.flush()
    return factory, session, pipeline, occurrence


def test_passed_cleaning_is_deterministic_without_review(tmp_path, monkeypatch):
    factory, session, pipeline, occurrence = _pipeline(tmp_path, None)
    source = tmp_path / "source.pdf"
    source.write_bytes(_pdf([["Anzeige © inixmedia"]]))
    artwork = tmp_path / "artwork.png"
    Image.new("RGB", (40, 40), "white").save(artwork)
    cleaned_page = Image.new("RGB", (40, 40), "white")
    verification = SimpleNamespace(
        passed=True,
        as_dict=lambda: {
            "status": "passed",
            "marker": {"status": "passed"},
            "text": {"status": "passed"},
            "pixels": {"status": "passed"},
        },
    )
    def fake_level_one(*args):
        assert args[0] == tmp_path / "cleaned.pdf"
        return RestorationResult(
            cleaned_page.copy(),
            {
                "cascade_level": 1,
                "geometry_quality": {
                    "status": "assessed",
                    "text_characters": 1,
                    "invalid_ratio": 0,
                    "overlap_ratio": 0,
                },
                "verification": {"status": "not_assessed", "checks": []},
            },
            None,
        )

    monkeypatch.setattr(
        "app.services.pipeline.propose_level_one", fake_level_one
    )
    monkeypatch.setattr(
        pipeline,
        "_write_cleaned_artwork",
        lambda *_args: (tmp_path / "cleaned-artwork.png", Box(0, 0, 40, 40)),
    )
    monkeypatch.setattr(
        "app.services.pipeline.verify_cleaned_ad",
        lambda *_args, **_kwargs: verification,
    )
    monkeypatch.setattr(
        "app.services.pipeline.extract_content_anchors",
        lambda *_args, **_kwargs: {
            "text_lines": [],
            "phones": [],
            "emails": [],
            "domains": [],
            "qr_removed": False,
        },
    )
    monkeypatch.setattr(
        "app.services.pipeline.compare_content_anchors",
        lambda *_args, **_kwargs: {
            "findings": [],
            "severity": "passed",
            "status": "passed",
            "qr_removed": False,
            "watermark_removed": True,
            "watermark_markers_original": ["inixmedia"],
            "watermark_markers_restored": [],
        },
    )
    monkeypatch.setattr(
        "app.services.pipeline.compare_visual_motifs",
        lambda *_args, **_kwargs: {"findings": []},
    )
    monkeypatch.setattr(
        "app.services.pipeline.finding_messages", lambda *_args: []
    )

    evidence = [{"marker": "inixmedia", "text": "© inixmedia"}]
    pipeline._maybe_write_restoration(
        occurrence,
        source,
        1,
        Box(0, 0, 40, 40),
        (40, 40),
        artwork,
        Box(0, 0, 40, 40),
        "digest",
        None,
        evidence,
        (tmp_path / "cleaned.pdf", cleaned_page),
    )

    manifest = json.loads(occurrence.restoration_manifest_json)
    assert manifest["restoration_stage"] == "deterministic_text_object"
    assert manifest["edit_status"] == "applied"
    assert manifest["geometry_quality"]["status"] == "assessed"
    assert manifest["verification"]["status"] == "passed"
    assert manifest["review_status"] == "not_required"
    assert occurrence.restoration_path is not None
    with Image.open(
        pipeline.storage.root / occurrence.restoration_path
    ) as restored:
        assert restored.size == cleaned_page.size
        assert list(restored.getdata()) == list(cleaned_page.getdata())
    assert session.scalar(select(ReviewItem).where(ReviewItem.ad_id == occurrence.id)) is None
    session.close()


def test_failed_cleaning_falls_back_to_generative_review(tmp_path, monkeypatch):
    factory, session, pipeline, occurrence = _pipeline(tmp_path)
    source = tmp_path / "source.pdf"
    source.write_bytes(_pdf([["Anzeige © inixmedia"]]))
    artwork = tmp_path / "artwork.png"
    Image.new("RGB", (40, 40), "white").save(artwork)
    verification = SimpleNamespace(
        passed=False,
        as_dict=lambda: {"status": "failed"},
    )
    generative_called = []
    monkeypatch.setattr(
        "app.services.pipeline.verify_cleaned_ad",
        lambda *_args, **_kwargs: verification,
    )

    def fake_generative(result, *_args):
        generative_called.append(True)
        result.manifest["generative"] = {"status": "passed"}
        return Image.new("RGB", (40, 40), "white"), "requires review"

    monkeypatch.setattr(pipeline, "_try_generative_restoration", fake_generative)
    monkeypatch.setattr(
        "app.services.pipeline.extract_content_anchors",
        lambda *_args, **_kwargs: {
            "text_lines": [],
            "phones": [],
            "emails": [],
            "domains": [],
            "qr_removed": False,
        },
    )
    monkeypatch.setattr(
        "app.services.pipeline.compare_content_anchors",
        lambda *_args, **_kwargs: {
            "findings": [],
            "severity": "passed",
            "status": "passed",
            "qr_removed": False,
            "watermark_removed": False,
            "watermark_markers_original": ["inixmedia"],
            "watermark_markers_restored": [],
        },
    )
    monkeypatch.setattr(
        "app.services.pipeline.compare_visual_motifs",
        lambda *_args, **_kwargs: {"findings": []},
    )
    monkeypatch.setattr(
        "app.services.pipeline.finding_messages", lambda *_args: []
    )

    pipeline._maybe_write_restoration(
        occurrence,
        source,
        1,
        Box(0, 0, 40, 40),
        (40, 40),
        artwork,
        Box(0, 0, 40, 40),
        "digest",
        None,
        [{"marker": "inixmedia", "text": "© inixmedia"}],
        (tmp_path / "cleaned.pdf", Image.new("RGB", (40, 40), "white")),
    )

    manifest = json.loads(occurrence.restoration_manifest_json)
    assert generative_called
    assert manifest["watermark_text_objects"]["verification"]["status"] == "failed"
    assert manifest["review_status"] == "pending"
    assert session.scalar(select(ReviewItem).where(ReviewItem.ad_id == occurrence.id))
    session.close()
