import json
from collections import Counter
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from PIL import Image, ImageChops, ImageDraw
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.db.base import Base
from app.services.bbox import Box
from app.models import AdOccurrence, Page, ReviewItem
from app.services.pipeline import Pipeline
from app.services.restoration import (
    _is_ink,
    verify_generative_proposal,
    verify_proposal,
)
from app.services.vision.image_edit import (
    ImageEditResult,
    OpenAIImageEditProvider,
    RecordedImageEditProvider,
    image_sha256,
    prepare_image_edit_input,
    restore_image_edit_output,
    select_image_edit_size,
)
from app.services.storage import LocalStorage
from app.services.vision.recorded import RecordedVisionProvider
from tests.test_order_forms import _pdf


FIXTURE = Path("tests/fixtures/Seniorenpost_Mai_Juni_2026.pdf")


class _LowConfidenceOrderFormProvider:
    def detect_ads(self, _image_path, _page_number):
        return [
            {
                "company_name": "Synthetic Bau GmbH",
                "bbox": [40, 120, 560, 680],
                "confidence": 0.1,
            }
        ]

    def extract_fields(self, _crop_path):
        return {"company": "Synthetic Bau GmbH"}


def _run(tmp_path, enabled):
    engine = create_engine(f"sqlite:///{tmp_path / 'restoration.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as session:
        pipeline = Pipeline(
            session,
            RecordedVisionProvider("tests/fixtures/qwen"),
            LocalStorage(tmp_path / "storage"),
            render_dpi=120,
            local_work_dir=tmp_path / "work",
            restoration_enabled=enabled,
        )
        document = pipeline.ingest(FIXTURE.read_bytes())
        ads = session.scalars(
            select(AdOccurrence)
            .join(Page)
            .where(Page.document_id == document.id, Page.page_number == 11)
            .order_by(AdOccurrence.id)
        ).all()
        return session, document, ads, factory


def test_restoration_is_off_by_default_and_preserves_existing_artifacts(tmp_path):
    session, _, ads, _ = _run(tmp_path, False)
    assert all(ad.restoration_path is None for ad in ads)
    assert all(json.loads(ad.restoration_manifest_json) == {} for ad in ads)
    assert all(ad.artwork_path for ad in ads)
    session.close()


def test_fixture_restoration_accepts_clean_lines_and_refuses_uncertain_ads(tmp_path):
    session, document, ads, factory = _run(tmp_path, True)
    manifests = [json.loads(ad.restoration_manifest_json) for ad in ads]
    assert [manifest["edit_status"] for manifest in manifests] == [
        "refused",
        "refused",
        "refused",
        "applied",
    ]
    assert ads[0].restoration_path is None
    assert ads[3].restoration_path
    assert ads[1].restoration_path is None
    assert ads[2].restoration_path is None
    assert "rendered ink extends" in manifests[0]["cascade_justification"]
    assert "fewer than two communication lines" in manifests[1]["cascade_justification"]
    assert "malformed or overlapping" in manifests[2]["cascade_justification"]
    assert manifests[0]["cascade_level"] == manifests[3]["cascade_level"] == 1
    assert manifests[3]["geometry_quality"]["status"] == "assessed"
    assert manifests[3]["verification"]["status"] == "passed"
    assert all(
        manifest["verification"]["status"] == "not_assessed"
        for manifest in manifests[:3]
    )
    assert all(manifest["review_status"] == "pending" for manifest in manifests)
    assert all(
        "qr_detection_unavailable"
        in {finding["rule"] for finding in manifest["findings"]}
        for manifest in manifests
    )
    with factory() as check:
        reasons = [
            item.reason
            for item in check.scalars(select(ReviewItem)).all()
            if item.ad_id
        ]
        assert any("QR detection is unavailable" in reason for reason in reasons)
    session.close()


def test_existing_order_form_occurrence_respects_restoration_gate(tmp_path):
    pdf = _pdf(
        [
            "PUBLIKATIONSVORSCHLAG",
            "FIRMA : Synthetic Bau GmbH",
            "STRASSE : Teststrasse 1",
            "PLZ/ORT : 12345 Teststadt",
            "ASP. : Frau Test",
            "TEL : 01234 56789",
            "E-MAIL : customer@example.de",
        ]
    )
    engine = create_engine(f"sqlite:///{tmp_path / 'order-form.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as session:
        pipeline = Pipeline(
            session,
            _LowConfidenceOrderFormProvider(),
            LocalStorage(tmp_path / "storage"),
            render_dpi=36,
            artwork_dpi=72,
            local_work_dir=tmp_path / "work",
            restoration_enabled=True,
        )
        document = pipeline.ingest(pdf, filename="order-form.pdf")
        pipeline.reprocess(pdf, filename="order-form.pdf")
        occurrence = session.scalar(
            select(AdOccurrence)
            .join(Page)
            .where(Page.document_id == document.id)
        )
        manifest = json.loads(occurrence.restoration_manifest_json)
        assert occurrence.artwork_path is None
        assert occurrence.restoration_path is None
        assert "order-form artwork gate failed" in manifest["cascade_justification"]
        assert "low confidence" in manifest["cascade_justification"]
        assert manifest["geometry_quality"]["status"] == "not_assessed"
        assert {
            finding["rule"] for finding in manifest["findings"]
        } == {"qr_detection_unavailable"}
        assert not (
            tmp_path / "work" / document.content_sha256 / "restoration_source"
        ).exists()


def test_accepted_proposal_changes_only_recorded_regions_and_preserves_dimensions(
    tmp_path,
):
    session, document, ads, _ = _run(tmp_path, True)
    manifest = json.loads(ads[3].restoration_manifest_json)
    original = Image.open(tmp_path / "work" / ads[3].artwork_path)
    proposal = Image.open(
        tmp_path / "storage" / ads[3].restoration_path
    )
    assert proposal.size == original.size
    assert proposal.size[0] / proposal.size[1] == original.size[0] / original.size[1]
    changed = ImageChops.difference(original.convert("RGB"), proposal.convert("RGB"))
    assert changed.getbbox() is not None
    boundary = manifest["ad_boundary"]
    original_pixels = original.load()
    proposal_pixels = proposal.load()
    for y in range(original.height):
        for x in range(original.width):
            inside = (
                boundary[0] <= x < boundary[2]
                and boundary[1] <= y < boundary[3]
            )
            if not inside:
                assert original_pixels[x, y] == proposal_pixels[x, y]
    assert manifest["source_regions"]
    assert manifest["destination_regions"]
    assert manifest["protected_regions"]
    assert manifest["background_regions"]
    background = tuple(manifest["background_source_color"])
    replacement = tuple(manifest["background_replacement_color"])
    assert background != replacement
    for source, destination in zip(
        manifest["source_regions"], manifest["destination_regions"]
    ):
        source_image = original.crop(tuple(source))
        destination_image = proposal.crop(tuple(destination))
        for source_pixel, destination_pixel in zip(
            source_image.getdata(), destination_image.getdata()
        ):
            if not _is_ink(source_pixel, background):
                assert destination_pixel == replacement
            else:
                assert destination_pixel == source_pixel
    source_regions = [tuple(region) for region in manifest["source_regions"]]
    destination_regions = [
        tuple(region) for region in manifest["destination_regions"]
    ]
    for region in source_regions + destination_regions:
        assert boundary[0] <= region[0] <= region[2] <= boundary[2]
        assert boundary[1] <= region[1] <= region[3] <= boundary[3]
    edited_regions = source_regions + destination_regions
    for y in range(boundary[1], boundary[3]):
        for x in range(boundary[0], boundary[2]):
            source_pixel = original_pixels[x, y]
            in_edited_region = any(
                region[0] <= x < region[2]
                and region[1] <= y < region[3]
                for region in edited_regions
            )
            if source_pixel == background and not in_edited_region:
                assert proposal_pixels[x, y] == replacement
            elif _is_ink(source_pixel, background) and not in_edited_region:
                assert proposal_pixels[x, y] == source_pixel
    session.close()


def test_independent_verifier_rejects_corrupted_proposals(tmp_path):
    session, _, ads, _ = _run(tmp_path, True)
    manifest = json.loads(ads[3].restoration_manifest_json)
    original = Image.open(tmp_path / "work" / ads[3].artwork_path).convert("RGB")
    proposal = Image.open(tmp_path / "storage" / ads[3].restoration_path).convert(
        "RGB"
    )
    boundary = manifest["ad_boundary"]
    outside = proposal.copy()
    outside.putpixel((0, 0), (1, 2, 3))
    result = verify_proposal(
        FIXTURE,
        11,
        Box(*[value / 2.5 for value in boundary]),
        120,
        tmp_path / "work" / ads[3].artwork_path,
        outside,
        (0, 0),
        300,
        manifest,
    )
    assert result["status"] == "failed"
    assert result["checks"][1]["name"] == "approved_boundary"
    assert result["checks"][1]["status"] == "failed"
    dropped_phone = proposal.copy()
    ImageDraw.Draw(dropped_phone).rectangle(
        tuple(manifest["destination_regions"][0]), fill=tuple(
            manifest["background_replacement_color"]
        )
    )
    result = verify_proposal(
        FIXTURE, 11, Box(*boundary), 120,
        tmp_path / "work" / ads[3].artwork_path, dropped_phone,
        (0, 0), 300, manifest,
    )
    assert result["status"] == "failed"
    assert result["checks"][2]["name"] == "text_anchors"
    duplicated = proposal.copy()
    source_region = tuple(manifest["source_regions"][0])
    duplicated.paste(original.crop(source_region), source_region[:2])
    result = verify_proposal(
        FIXTURE, 11, Box(*boundary), 120,
        tmp_path / "work" / ads[3].artwork_path, duplicated,
        (0, 0), 300, manifest,
    )
    assert result["status"] == "failed"
    assert result["checks"][4]["name"] == "duplicated_content"
    added_ink = proposal.copy()
    source_color = next(
        color
        for color, _ in Counter(original.getdata()).most_common()
        if color != tuple(manifest["background_replacement_color"])
    )
    x1, y1, x2, y2 = boundary
    ImageDraw.Draw(added_ink).rectangle(
        (x1 + 10, y1 + 10, min(x1 + 110, x2 - 1), min(y1 + 110, y2 - 1)),
        fill=source_color,
    )
    result = verify_proposal(
        FIXTURE, 11, Box(*[value / 2.5 for value in boundary]), 120,
        tmp_path / "work" / ads[3].artwork_path, added_ink,
        (0, 0), 300, manifest,
    )
    assert result["status"] == "failed"
    assert result["checks"][3]["name"] == "new_content"
    missing_boundary = dict(manifest)
    missing_boundary.pop("ad_boundary")
    result = verify_proposal(
        FIXTURE, 11, Box(*[value / 2.5 for value in boundary]), 120,
        tmp_path / "work" / ads[3].artwork_path, proposal,
        (0, 0), 300, missing_boundary,
    )
    assert result["status"] == "failed"
    assert result["checks"][1]["name"] == "approved_boundary"
    aspect_changed = proposal.resize((proposal.width + 1, proposal.height))
    result = verify_proposal(
        FIXTURE, 11, Box(*boundary), 120,
        tmp_path / "work" / ads[3].artwork_path, aspect_changed,
        (0, 0), 300, manifest,
    )
    assert result["status"] == "failed"
    assert result["checks"][0]["name"] == "dimensions"
    assert original.size == proposal.size
    session.close()


def test_existing_occurrence_restoration_recrops_when_artwork_file_is_missing(
    tmp_path,
):
    engine = create_engine(f"sqlite:///{tmp_path / 'restoration.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    pdf = FIXTURE.read_bytes()
    with factory() as session:
        pipeline = Pipeline(
            session,
            RecordedVisionProvider("tests/fixtures/qwen"),
            LocalStorage(tmp_path / "storage"),
            render_dpi=120,
            local_work_dir=tmp_path / "work",
            restoration_enabled=True,
        )
        document = pipeline.ingest(pdf)
        ads = session.scalars(
            select(AdOccurrence)
            .join(Page)
            .where(Page.document_id == document.id, Page.page_number == 11)
            .order_by(AdOccurrence.id)
        ).all()
        (tmp_path / "work" / document.content_sha256 / "artwork" / "page_11_3.png").unlink()

        pipeline.reprocess(pdf)

        refreshed = session.scalars(
            select(AdOccurrence)
            .join(Page)
            .where(Page.document_id == document.id, Page.page_number == 11)
            .order_by(AdOccurrence.id)
        ).all()
        assert len(refreshed) == len(ads)
        assert refreshed[3].restoration_path
        assert json.loads(refreshed[3].restoration_manifest_json)[
            "edit_status"
        ] == "applied"


def test_generative_verifier_checks_anchors_tokens_boundary_and_colors():
    source = Image.new("RGB", (24, 24), (240, 240, 240))
    draw = ImageDraw.Draw(source)
    draw.rectangle((4, 4, 19, 19), fill=(20, 20, 20))
    boundary = Box(2, 2, 22, 22)
    passed = verify_generative_proposal(
        source,
        source.copy(),
        boundary,
        ["Tel 01234 56789"],
        "Tel 01234 56789",
        "Tel 01234 56789",
    )
    assert passed["status"] == "passed"
    assert {check["name"] for check in passed["checks"]} == {
        "dimensions",
        "approved_boundary",
        "ocr_assessable",
        "text_anchors",
        "no_new_text",
        "brand_colors",
    }

    missing = verify_generative_proposal(
        source,
        source.copy(),
        boundary,
        ["Tel 01234 56789"],
        "Tel 01234 56789",
        "Tel",
    )
    assert missing["status"] == "failed"
    assert next(
        check for check in missing["checks"] if check["name"] == "text_anchors"
    )["status"] == "failed"

    new_text = verify_generative_proposal(
        source,
        source.copy(),
        boundary,
        ["Tel 01234 56789"],
        "Tel 01234 56789",
        "Tel 01234 56789 invented",
    )
    assert new_text["status"] == "failed"
    assert next(
        check for check in new_text["checks"] if check["name"] == "no_new_text"
    )["status"] == "failed"

    outside = source.copy()
    outside.putpixel((0, 0), (1, 2, 3))
    boundary_failure = verify_generative_proposal(
        source,
        outside,
        boundary,
        ["Tel 01234 56789"],
        "Tel 01234 56789",
        "Tel 01234 56789",
    )
    assert boundary_failure["status"] == "failed"
    assert next(
        check
        for check in boundary_failure["checks"]
        if check["name"] == "approved_boundary"
    )["status"] == "failed"

    duplicate_text = verify_generative_proposal(
        source,
        source.copy(),
        boundary,
        ["Tel 01234 56789"],
        "Tel 01234 56789",
        "Tel 01234 56789 Tel 01234 56789",
    )
    assert duplicate_text["status"] == "failed"
    assert next(
        check for check in duplicate_text["checks"] if check["name"] == "text_anchors"
    )["status"] == "failed"

    recolored = source.copy()
    ImageDraw.Draw(recolored).rectangle((4, 4, 19, 19), fill=(220, 20, 20))
    color_failure = verify_generative_proposal(
        source,
        recolored,
        boundary,
        ["Tel 01234 56789"],
        "Tel 01234 56789",
        "Tel 01234 56789",
    )
    assert color_failure["status"] == "failed"
    assert next(
        check for check in color_failure["checks"] if check["name"] == "brand_colors"
    )["status"] == "failed"

    dimension_failure = verify_generative_proposal(
        source,
        source.resize((25, 24)),
        boundary,
        ["Tel 01234 56789"],
        "Tel 01234 56789",
        "Tel 01234 56789",
    )
    assert dimension_failure["status"] == "failed"
    assert dimension_failure["checks"][0]["name"] == "dimensions"

    not_assessed = verify_generative_proposal(
        source, source.copy(), boundary, ["Tel 01234 56789"], "", ""
    )
    assert not_assessed["status"] == "not_assessed"


def test_recorded_image_edit_provider_is_keyed_by_input_digest(tmp_path):
    image = Image.new("RGB", (8, 8), (12, 34, 56))
    result_path = tmp_path / "result.png"
    image.save(result_path)
    (tmp_path / f"{image_sha256(image)}.json").write_text(
        json.dumps(
            {
                "image": result_path.name,
                "model": "recorded-test",
                "reported_cost": 0.25,
            }
        )
    )
    provider = RecordedImageEditProvider(tmp_path)
    result = provider.edit(image, "prompt")
    assert isinstance(result, ImageEditResult)
    assert result.model == "recorded-test"
    assert result.reported_cost == 0.25


def test_image_edit_size_selection_and_round_trip_preserve_aspect_ratio():
    assert select_image_edit_size((100, 100))[0] == "1024x1024"
    assert select_image_edit_size((150, 100))[0] == "1536x1024"
    assert select_image_edit_size((100, 150))[0] == "1024x1536"

    source = Image.new("RGB", (417, 263), (12, 34, 56))
    prepared, fitted_region = prepare_image_edit_input(source, (1536, 1024))
    assert prepared.size == (1536, 1024)
    assert fitted_region == (0, 27, 1536, 996)
    assert prepared.getpixel((0, 0)) == (255, 255, 255)
    restored = restore_image_edit_output(prepared, fitted_region, source.size)
    assert restored.size == source.size
    assert restored.getpixel((200, 100)) == source.getpixel((200, 100))


def test_generative_fallback_composites_crop_and_records_pending_review(
    tmp_path, monkeypatch
):
    class _StubImageEditProvider:
        def __init__(self):
            self.calls = 0

        def edit(self, image, prompt, rejection_reasons=None, size=None):
            del prompt, rejection_reasons
            self.calls += 1
            assert size in {"1024x1024", "1536x1024", "1024x1536"}
            return ImageEditResult(image.copy(), "stub-image-model", 250)

        def available(self):
            return True

    class _StubOCRProvider:
        def extract_fields(self, crop_path):
            del crop_path
            from app.services.ocr import OCRResult

            return OCRResult({"phone": "01234 56789"}, {"phone": 1.0}, "Tel 01234 56789")

    import app.services.pipeline as pipeline_module

    monkeypatch.setattr(
        pipeline_module,
        "communication_lines_for_box",
        lambda *_args: ["Tel 01234 56789"],
    )
    provider = _StubImageEditProvider()
    engine = create_engine(f"sqlite:///{tmp_path / 'generative.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as session:
        pipeline = Pipeline(
            session,
            RecordedVisionProvider("tests/fixtures/qwen"),
            LocalStorage(tmp_path / "storage"),
            render_dpi=120,
            local_work_dir=tmp_path / "work",
            restoration_enabled=True,
            ocr_provider=_StubOCRProvider(),
            image_edit_provider=provider,
            image_edit_max_cost_cents=100,
            image_edit_hard_stop_cents=100,
        )
        document = pipeline.ingest(FIXTURE.read_bytes())
        ads = session.scalars(
            select(AdOccurrence)
            .join(Page)
            .where(Page.document_id == document.id, Page.page_number == 11)
        ).all()
        generative = [
            (ad, json.loads(ad.restoration_manifest_json))
            for ad in ads
            if json.loads(ad.restoration_manifest_json).get("restoration_mode")
            == "generative"
        ]
        assert provider.calls == 1
        assert generative
        ad, manifest = generative[0]
        assert ad.restoration_path
        assert manifest["generative"]["model"] == "stub-image-model"
        assert manifest["generative"]["prompt_sha256"]
        assert manifest["generative"]["cost"] == 250
        assert manifest["generative"]["document_cost_cents"] == 250
        assert manifest["ad_boundary"]
        assert "passed independent verification" in manifest["cascade_justification"]
        assert manifest["generative"]["normalization"]["requested_format"] in {
            "1024x1024",
            "1536x1024",
            "1024x1536",
        }
        assert manifest["generative"]["normalization"]["source_size"]
        assert manifest["generative"]["normalization"]["normalized_size"]
        assert (
            manifest["generative"]["normalization"]["normalized_size"]
            != manifest["generative"]["normalization"]["source_size"]
        )
        assert manifest["generative"]["normalization"]["resampling"] == "LANCZOS"
        assert manifest["verification"]["status"] == "passed"
        assert manifest["review_status"] == "pending"
        assert session.scalar(select(ReviewItem).where(ReviewItem.ad_id == ad.id))


def test_generative_provider_format_mismatch_is_refused(tmp_path, monkeypatch):
    class _WrongSizeProvider:
        def edit(self, image, prompt, rejection_reasons=None, size=None):
            del image, prompt, rejection_reasons
            assert size == "1536x1024"
            return ImageEditResult(
                Image.new("RGB", (1024, 1024), "white"),
                "stub-image-model",
                100,
            )

        def available(self):
            return True

    import app.services.pipeline as pipeline_module

    monkeypatch.setattr(
        pipeline_module,
        "approved_artwork_box",
        lambda *_args: Box(10, 10, 110, 60),
    )
    monkeypatch.setattr(
        pipeline_module,
        "communication_lines_for_box",
        lambda *_args: [],
    )
    artwork_path = tmp_path / "artwork.png"
    Image.new("RGB", (200, 100), "white").save(artwork_path)
    pipeline = Pipeline(
        None,
        RecordedVisionProvider("tests/fixtures/qwen"),
        LocalStorage(tmp_path / "storage"),
        render_dpi=120,
        local_work_dir=tmp_path / "work",
        restoration_enabled=True,
        image_edit_provider=_WrongSizeProvider(),
        image_edit_hard_stop_cents=100,
    )
    pixel_result = SimpleNamespace(
        manifest={"edit_status": "refused"},
        review_reason="pixel stage refused",
    )
    occurrence = SimpleNamespace(fields_json="{}")
    result, reason = pipeline._try_generative_restoration(
        pixel_result,
        FIXTURE,
        11,
        Box(0, 0, 100, 50),
        artwork_path,
        Box(0, 0, 100, 50),
        occurrence,
    )
    assert result is None
    assert "generative verification failed" in reason
    assert pixel_result.manifest["generative"]["status"] == "failed"
    assert pixel_result.manifest["generative"]["verification"]["checks"][0][
        "name"
    ] == "dimensions"


def test_image_edit_provider_rejects_invalid_url_and_empty_data(monkeypatch):
    image = Image.new("RGB", (4, 4), "white")
    insecure = OpenAIImageEditProvider("http://example.test/v1", "model", "key")
    with pytest.raises(ValueError, match="must use https"):
        insecure.edit(image, "prompt")

    def empty_response(*_args, **_kwargs):
        return httpx.Response(
            200,
            json={"data": []},
            request=httpx.Request("POST", "https://example.test/v1/images/edits"),
        )

    monkeypatch.setattr("app.services.vision.image_edit.httpx.post", empty_response)
    monkeypatch.setattr(
        "app.services.vision.image_edit.validate_public_url", lambda _url: None
    )
    provider = OpenAIImageEditProvider("https://example.test/v1", "model", "key")
    with pytest.raises(ValueError, match="no image data"):
        provider.edit(image, "prompt")


def test_non_numeric_reported_cost_uses_upper_bound_and_completes_document(
    tmp_path, monkeypatch
):
    class _StubImageEditProvider:
        def __init__(self):
            self.calls = 0

        def edit(self, image, prompt, rejection_reasons=None, size=None):
            del prompt, rejection_reasons
            self.calls += 1
            assert size in {"1024x1024", "1536x1024", "1024x1536"}
            return ImageEditResult(image.copy(), "stub-image-model", "unknown")

        def available(self):
            return True

    class _StubOCRProvider:
        def extract_fields(self, crop_path):
            del crop_path
            from app.services.ocr import OCRResult

            return OCRResult(
                {"phone": "01234 56789"},
                {"phone": 1.0},
                "Tel 01234 56789",
            )

    import app.services.pipeline as pipeline_module

    monkeypatch.setattr(
        pipeline_module,
        "communication_lines_for_box",
        lambda *_args: ["Tel 01234 56789"],
    )
    provider = _StubImageEditProvider()
    engine = create_engine(f"sqlite:///{tmp_path / 'generative.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as session:
        pipeline = Pipeline(
            session,
            RecordedVisionProvider("tests/fixtures/qwen"),
            LocalStorage(tmp_path / "storage"),
            render_dpi=120,
            local_work_dir=tmp_path / "work",
            restoration_enabled=True,
            ocr_provider=_StubOCRProvider(),
            image_edit_provider=provider,
            image_edit_max_cost_cents=100,
            image_edit_hard_stop_cents=100,
        )
        document = pipeline.ingest(FIXTURE.read_bytes())
        ads = session.scalars(
            select(AdOccurrence)
            .join(Page)
            .where(Page.document_id == document.id, Page.page_number == 11)
        ).all()
        generative = [
            json.loads(ad.restoration_manifest_json)
            for ad in ads
            if json.loads(ad.restoration_manifest_json).get("restoration_mode")
            == "generative"
        ]
        assert provider.calls == 1
        assert generative
        manifest = generative[0]
        assert manifest["generative"]["cost"] == 100
        assert manifest["generative"]["document_cost_cents"] == 100
        assert manifest["verification"]["status"] == "passed"
        assert document.id is not None
