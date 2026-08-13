import json
from pathlib import Path

from PIL import Image
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from app.db.base import Base
from app.models import AdOccurrence, Company, Document, Page, ReviewItem
from app.api.dependencies import session_dependency, storage_dependency
from app.main import app
from app.services.bbox import Box
from app.services.crop import restore_artwork
from app.services.pipeline import Pipeline
from app.services.storage import LocalStorage
from app.services.vision.recorded import RecordedVisionProvider
from fastapi.testclient import TestClient

from tests.test_order_forms import _pdf


class _SyntheticProvider:
    def detect_ads(self, _image_path, _page_number):
        return [
            {
                "company_name": "Other Synthetic GmbH",
                "bbox": [50, 150, 950, 850],
                "confidence": 0.95,
            }
        ]

    def extract_fields(self, _crop_path):
        return {"company": "Other Synthetic GmbH", "phone": "02222"}


def test_restore_artwork_keeps_untrimmed_png_and_trimmed_copy(tmp_path):
    page = Image.new("RGB", (100, 80), "white")
    for x in range(20, 80):
        for y in range(15, 65):
            page.putpixel((x, y), (20, 80, 160))
    raw, trimmed, box = restore_artwork(
        page,
        box=Box(20, 15, 80, 65),
        output_path=tmp_path / "raw.png",
        trimmed_output_path=tmp_path / "trimmed.png",
        padding=5,
        trim_cap=4,
    )
    assert raw.read_bytes().startswith(b"\x89PNG")
    assert trimmed.read_bytes().startswith(b"\x89PNG")
    assert box.left == 15 and box.top == 10
    assert Image.open(raw).size == (70, 60)
    assert Image.open(trimmed).size == (62, 52)


def test_order_form_pipeline_persists_header_and_conflict_review(tmp_path):
    pdf = _pdf(
        [
            "PUBLIKATIONSVORSCHLAG",
            "FIRMA : Synthetic Bau GmbH",
            "STRASSE : Teststrasse 1",
            "PLZ/ORT : 12345 Teststadt",
            "ASP. : Frau Test",
            "TEL : 01234 56789",
            "E-MAIL : customer@example.de",
            "Datum : 01.01.2026",
            "Vorgang : SYN",
            "Berater : Unit",
            "Other Synthetic GmbH 02222",
        ]
    )
    engine = create_engine(f"sqlite:///{tmp_path / 'order.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as session:
        pipeline = Pipeline(
            session,
            _SyntheticProvider(),
            LocalStorage(tmp_path / "storage"),
            render_dpi=36,
            artwork_dpi=72,
            local_work_dir=tmp_path / "work",
        )
        document = pipeline.ingest(pdf, filename="synthetic-order-form.pdf")
        page = session.scalar(
            select(Page).where(Page.document_id == document.id)
        )
        ad = session.scalar(select(AdOccurrence).where(AdOccurrence.page_id == page.id))
        payload = json.loads(ad.fields_json)
        assert page.is_order_form
        assert ad.is_order_form
        assert payload["form_header"]["fields"]["contact_person"] == "Frau Test"
        assert payload["fields"]["company"] == "Synthetic Bau GmbH"
        assert payload["advert_fields"]["company"] == "Other Synthetic GmbH"
        assert payload["provenance"]["company"] == "order_form_header"
        assert payload["provenance"]["phone"] == "order_form_header"
        assert payload["provenance"]["email"] == "order_form_header"
        assert payload["field_conflicts"]["company"]["header"] == "Synthetic Bau GmbH"
        review = session.scalar(select(ReviewItem).where(ReviewItem.ad_id == ad.id))
        assert "header/advert conflict for company" in review.reason
        assert "header/advert conflict for phone" in review.reason
        assert ad.artwork_path and ad.artwork_trimmed_path
        assert json.loads(ad.artwork_metadata_json)["source_dpi"] == 72
        assert session.scalar(select(func.count(Company.id))) == 1
        assert session.scalar(select(func.count(ReviewItem.id))) == 1


def test_page11_ads_receive_restored_artwork_artifacts(tmp_path):
    pdf = Path("tests/fixtures/Seniorenpost_Mai_Juni_2026.pdf").read_bytes()
    engine = create_engine(f"sqlite:///{tmp_path / 'artwork.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as session:
        document = Pipeline(
            session,
            RecordedVisionProvider("tests/fixtures/qwen"),
            LocalStorage(tmp_path / "storage"),
            render_dpi=36,
            artwork_dpi=120,
            local_work_dir=tmp_path / "work",
        ).ingest(pdf)
        pages = session.scalars(
            select(Page).where(Page.document_id == document.id)
        ).all()
        ads = session.scalars(
            select(AdOccurrence)
            .join(Page)
            .where(Page.document_id == document.id, Page.page_number == 11)
        ).all()
        assert len(ads) == 4
        assert all(
            page.form_header_json == "{}"
            for page in pages
            if not page.is_order_form
        )
        assert all(ad.artwork_path and ad.artwork_trimmed_path for ad in ads)
        assert all(
            json.loads(ad.artwork_metadata_json)["source_dpi"] == 120 for ad in ads
        )


def test_order_form_frame_gate_rejects_full_page_boxes():
    assert not Pipeline._order_form_box_is_plausible(
        Box(0, 0, 1000, 1000), (1000, 1000)
    )


def test_reused_pipeline_rekeys_form_cache_by_source(tmp_path):
    def form(company):
        return _pdf(
            [
                "PUBLIKATIONSVORSCHLAG",
                f"FIRMA : {company}",
                "STRASSE : Teststrasse 1",
                "PLZ/ORT : 12345 Teststadt",
                "ASP. : Frau Test",
                "TEL : 01234 56789",
                "E-MAIL : customer@example.de",
            ]
        )

    engine = create_engine(f"sqlite:///{tmp_path / 'cache.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as session:
        pipeline = Pipeline(
            session,
            _SyntheticProvider(),
            LocalStorage(tmp_path / "storage"),
            render_dpi=36,
            artwork_dpi=72,
            local_work_dir=tmp_path / "work",
        )
        first = pipeline.ingest(form("Synthetic First GmbH"))
        second = pipeline.ingest(form("Synthetic Second GmbH"))
        first_ad = session.scalar(
            select(AdOccurrence)
            .join(Page)
            .where(Page.document_id == first.id)
        )
        second_ad = session.scalar(
            select(AdOccurrence)
            .join(Page)
            .where(Page.document_id == second.id)
        )
        assert json.loads(first_ad.fields_json)["form_header"]["fields"]["company"] == (
            "Synthetic First GmbH"
        )
        assert json.loads(second_ad.fields_json)["form_header"]["fields"]["company"] == (
            "Synthetic Second GmbH"
        )


def test_authenticated_artwork_api_returns_png(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'api.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    storage = LocalStorage(tmp_path / "storage")
    artwork_key = storage.put(b"\x89PNG synthetic", "artwork.png")
    with factory() as session:
        document = Document(content_sha256="a" * 64)
        session.add(document)
        session.flush()
        page = Page(document_id=document.id, page_number=1)
        session.add(page)
        session.flush()
        ad = AdOccurrence(
            page_id=page.id,
            occurrence_key="1",
            bbox="1,1,2,2",
            artwork_path=artwork_key,
        )
        session.add(ad)
        session.commit()
        ad_id, document_id = ad.id, document.id

    def override():
        with factory() as session:
            yield session

    app.dependency_overrides[session_dependency] = override
    app.dependency_overrides[storage_dependency] = lambda: storage
    try:
        with TestClient(app) as client:
            response = client.get(f"/documents/{document_id}/ads/{ad_id}/artwork")
        assert response.status_code == 200
        assert response.headers["content-type"] == "image/png"
        assert response.content == b"\x89PNG synthetic"
    finally:
        app.dependency_overrides.clear()
