import json
from pathlib import Path

from PIL import Image, ImageChops
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.db.base import Base
from app.models import AdOccurrence, Page, ReviewItem
from app.services.pipeline import Pipeline
from app.services.restoration import _is_ink
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
