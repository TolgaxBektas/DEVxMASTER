import json
from types import SimpleNamespace

from PIL import Image
import pikepdf
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
from app.services.text_layer import watermark_markers_in_boxes
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


def test_split_marker_is_detected_and_removed_as_one_text_block(tmp_path):
    source = tmp_path / "split-source.pdf"
    cleaned = tmp_path / "split-cleaned.pdf"
    source.write_bytes(_pdf([["Anzeige"]]))
    with pikepdf.Pdf.open(source) as pdf:
        pdf.pages[0].Contents = pdf.make_stream(
            b"BT /F1 10 Tf 1 0 0 1 20 760 Tm "
            b"(Anzeige) Tj ET BT /F1 10 Tf 1 0 0 1 20 740 Tm "
            b"( \\251 inix) Tj ( media) Tj ET"
        )
        modified = tmp_path / "split-source-modified.pdf"
        pdf.save(modified)
    source = modified
    box = Box(0, 0, 1020, 1320)

    evidence = watermark_markers_in_boxes(
        source, 1, [box], 120, ["inixmedia"]
    )[0]
    result = clean_pdf(source, cleaned, {1: [box]}, ["inixmedia"], 120)
    verification = verify_cleaned_ad(
        source, result.pdf_path, 1, box, ["inixmedia"], 120
    )

    assert any(item["kind"] == "confirmed" for item in evidence)
    assert result.removed_blocks
    assert verification.passed


def test_malformed_marker_is_suspect_and_not_removed(tmp_path):
    source = tmp_path / "malformed-source.pdf"
    cleaned = tmp_path / "malformed-cleaned.pdf"
    source.write_bytes(_pdf([["Anzeige"]]))
    with pikepdf.Pdf.open(source) as pdf:
        pdf.pages[0].Contents = pdf.make_stream(
            b"BT /F1 10 Tf 1 0 0 1 20 760 Tm "
            b"(Anzeige inmedia) Tj ET"
        )
        modified = tmp_path / "malformed-source-modified.pdf"
        pdf.save(modified)
    source = modified
    box = Box(0, 0, 1020, 1320)

    evidence = watermark_markers_in_boxes(
        source, 1, [box], 120, ["inixmedia"]
    )[0]
    result = clean_pdf(source, cleaned, {1: [box]}, ["inixmedia"], 120)

    assert any(item["kind"] == "suspected" for item in evidence)
    assert not result.removed_blocks


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
        "app.services.pipeline.verify_proposal",
        lambda *args, **kwargs: {
            "status": "passed",
            "checks": [
                {"name": "dimensions", "status": "passed"},
                {"name": "approved_boundary", "status": "passed"},
            ],
        },
    )
    monkeypatch.setattr(
        pipeline,
        "_write_cleaned_artwork",
        lambda *_args: (tmp_path / "cleaned-artwork.png", Box(0, 0, 40, 40)),
    )
    monkeypatch.setattr(
        pipeline,
        "_prepare_qr_removal",
        lambda source_pdf, *_args, **_kwargs: (
            None
            if source_pdf == tmp_path / "cleaned.pdf"
            else (_ for _ in ()).throw(
                AssertionError("QR removal must use the watermark-cleaned PDF")
            )
        ),
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
    assert {
        check["name"] for check in manifest["verification"]["checks"]
    } == {
        "dimensions",
        "approved_boundary",
        "watermark_marker",
        "watermark_text",
        "watermark_pixels",
    }
    assert manifest["review_status"] == "not_required"
    assert occurrence.restoration_path is not None
    with Image.open(
        pipeline.storage.root / occurrence.restoration_path
    ) as restored:
        assert restored.size == cleaned_page.size
        assert list(restored.getdata()) == list(cleaned_page.getdata())
    assert session.scalar(select(ReviewItem).where(ReviewItem.ad_id == occurrence.id)) is None
    session.close()


def test_combined_cleaning_runs_qr_after_watermark_on_same_pdf(
    tmp_path, monkeypatch
):
    factory, session, pipeline, occurrence = _pipeline(tmp_path, None)
    source = tmp_path / "source.pdf"
    source.write_bytes(_pdf([["Anzeige © inixmedia"]]))
    watermark_pdf = tmp_path / "watermark.pdf"
    watermark_pdf.write_bytes(source.read_bytes())
    qr_pdf = tmp_path / "qr.pdf"
    qr_pdf.write_bytes(source.read_bytes())
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
    qr_verification = SimpleNamespace(
        passed=True,
        as_dict=lambda: {
            "status": "passed",
            "decoder": {"status": "passed"},
            "text": {"status": "passed"},
            "pixels": {"status": "passed"},
        },
    )
    qr_removal = SimpleNamespace(
        pdf_path=qr_pdf,
        removed_object={"name": "/Im1", "object": [83, 0]},
    )
    qr_cleaning_sources = []

    monkeypatch.setattr(
        pipeline,
        "_prepare_qr_removal",
        lambda source_pdf, *_args, **_kwargs: (
            qr_cleaning_sources.append(source_pdf)
            or {
                "removal": qr_removal,
                "verification": qr_verification,
                "anchors": {
                    "qr_region": {
                        "x": 4,
                        "y": 4,
                        "width": 20,
                        "height": 20,
                    }
                },
            }
        ),
    )
    monkeypatch.setattr(
        "app.services.pipeline.render_page",
        lambda *_args, **_kwargs: cleaned_page,
    )
    monkeypatch.setattr(
        pipeline,
        "_write_cleaned_artwork",
        lambda *_args: (artwork, Box(0, 0, 40, 40)),
    )
    monkeypatch.setattr(
        "app.services.pipeline.verify_cleaned_ad",
        lambda *_args, **_kwargs: verification,
    )
    monkeypatch.setattr(
        "app.services.pipeline.propose_level_one",
        lambda *_args, **_kwargs: RestorationResult(
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
        ),
    )
    monkeypatch.setattr(
        "app.services.pipeline.verify_proposal",
        lambda *_args, **_kwargs: {
            "status": "passed",
            "checks": [
                {"name": "dimensions", "status": "passed"},
                {"name": "approved_boundary", "status": "passed"},
            ],
        },
    )
    monkeypatch.setattr(
        "app.services.pipeline.extract_content_anchors",
        lambda *_args, **_kwargs: {
            "text_lines": [],
            "phones": [],
            "emails": [],
            "domains": [],
            "qr_removed": True,
        },
    )
    monkeypatch.setattr(
        "app.services.pipeline.compare_content_anchors",
        lambda *_args, **_kwargs: {
            "findings": [],
            "severity": "passed",
            "status": "passed",
            "qr_removed": True,
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
        [{"marker": "inixmedia", "text": "© inixmedia", "kind": "confirmed"}],
        (watermark_pdf, cleaned_page),
    )

    manifest = json.loads(occurrence.restoration_manifest_json)
    assert qr_cleaning_sources == [watermark_pdf]
    assert manifest["restoration_stage"] == "deterministic_text_and_qr"
    assert manifest["review_status"] == "not_required"
    assert {
        check["name"] for check in manifest["verification"]["checks"]
    } == {
        "dimensions",
        "approved_boundary",
        "watermark_marker",
        "watermark_text",
        "watermark_pixels",
        "qr_decoder",
        "qr_text",
        "qr_pixels",
    }
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


def test_passed_cleaning_without_level_one_image_falls_back(
    tmp_path, monkeypatch
):
    factory, session, pipeline, occurrence = _pipeline(tmp_path)
    source = tmp_path / "source.pdf"
    source.write_bytes(_pdf([["Anzeige © inixmedia"]]))
    artwork = tmp_path / "artwork.png"
    Image.new("RGB", (40, 40), "white").save(artwork)
    verification = SimpleNamespace(
        passed=True,
        as_dict=lambda: {
            "status": "passed",
            "marker": {"status": "passed"},
            "text": {"status": "passed"},
            "pixels": {"status": "passed"},
        },
    )
    monkeypatch.setattr(
        "app.services.pipeline.verify_cleaned_ad",
        lambda *_args, **_kwargs: verification,
    )
    monkeypatch.setattr(
        "app.services.pipeline.propose_level_one",
        lambda *_args: RestorationResult(
            None,
            {
                "geometry_quality": {"status": "assessed"},
                "verification": {"status": "not_assessed", "checks": []},
            },
            "level one refused: no clean text geometry",
        ),
    )
    generative_called = []

    def fake_generative(*_args):
        generative_called.append(True)
        return None, "generative restoration failed"

    monkeypatch.setattr(pipeline, "_try_generative_restoration", fake_generative)

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
    assert manifest["deterministic_restoration"]["status"] == "refused"
    assert "no clean text geometry" in manifest["deterministic_restoration"]["reason"]
    assert manifest["review_status"] == "pending"
    assert session.scalar(select(ReviewItem).where(ReviewItem.ad_id == occurrence.id))
    session.close()
