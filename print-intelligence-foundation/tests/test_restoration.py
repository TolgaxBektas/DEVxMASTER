import json
from pathlib import Path

from PIL import Image, ImageChops
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.db.base import Base
from app.models import AdOccurrence, Page, ReviewItem
from app.services.pipeline import Pipeline
from app.services.storage import LocalStorage
from app.services.vision.recorded import RecordedVisionProvider


FIXTURE = Path("tests/fixtures/Seniorenpost_Mai_Juni_2026.pdf")


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
    assert manifest["background_regions"]
    background = tuple(manifest["background_source_color"])
    for y in range(boundary[1], boundary[3]):
        for x in range(boundary[0], boundary[2]):
            if original_pixels[x, y] == background:
                assert proposal_pixels[x, y] != background
    for source, destination in zip(
        manifest["source_regions"], manifest["destination_regions"]
    ):
        for region in (source, destination):
            assert boundary[0] <= region[0] <= region[2] <= boundary[2]
            assert boundary[1] <= region[1] <= region[3] <= boundary[3]
        source_image = original.crop(tuple(source))
        destination_image = proposal.crop(tuple(destination))
        for source_pixel, destination_pixel in zip(
            source_image.getdata(), destination_image.getdata()
        ):
            if max(
                abs(source_pixel[channel] - background[channel])
                for channel in range(3)
            ) <= 3:
                assert destination_pixel != background
            else:
                assert destination_pixel == source_pixel
    for protected in manifest["protected_regions"]:
        for source_pixel, proposal_pixel in zip(
            original.crop(tuple(protected)).getdata(),
            proposal.crop(tuple(protected)).getdata(),
        ):
            if source_pixel != background:
                assert source_pixel == proposal_pixel
    session.close()
