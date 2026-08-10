from pathlib import Path
import json
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker
from app.db.base import Base
from app.models import AdOccurrence, Company, Document, Job, Page, ReviewItem
from app.services.pipeline import Pipeline
from app.services.storage import LocalStorage
from app.services.vision.recorded import RecordedVisionProvider


def test_seniorenpost_recorded_pipeline_is_idempotent(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'test.db'}")
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, expire_on_commit=False)
    pdf = Path("tests/fixtures/Seniorenpost_Mai_Juni_2026.pdf").read_bytes()
    provider = RecordedVisionProvider("tests/fixtures/qwen")
    with session_factory() as session:
        pipeline = Pipeline(
            session,
            provider,
            LocalStorage(tmp_path / "storage"),
            render_dpi=36,
            local_work_dir=tmp_path / "work",
        )
        document = pipeline.ingest(pdf)
        pipeline.ingest(pdf)
        pipeline.reprocess(pdf)
        assert session.scalar(select(func.count(Document.id))) == 1
        assert session.scalar(select(func.count(Page.id))) > 11
        ads = session.scalars(
            select(AdOccurrence)
            .join(Page)
            .where(Page.document_id == document.id, Page.page_number == 11)
        ).all()
        assert [ad.company.name for ad in ads] == [
            "Grau & Sohn",
            "Altenzentrum Wetzlar-Pariser Gasse",
            "AWO Kreisverband Lahn-Dill e.V.",
            "Pietät Ulm",
        ]
        assert len({ad.crop_path for ad in ads}) == 4
        assert len({ad.bbox for ad in ads}) == 4
        digest = document.content_sha256
        assert (
            len(
                {
                    (
                        tmp_path / "work" / digest / "crops" / Path(ad.crop_path).name
                    ).read_bytes()
                    for ad in ads
                }
            )
            == 4
        )
        payloads = [json.loads(ad.fields_json) for ad in ads]
        assert all(payloads[index]["text"] for index in (0, 2, 3))
        assert payloads[1]["text"] == ""
        contacts = [payload["fields"] for payload in payloads]
        assert all(payloads[index]["text"] for index in (0, 2, 3))
        companies = [ad.company.name for ad in ads]
        contact_values = {
            value
            for fields in contacts
            for value in (
                fields.get("phone"),
                fields.get("email"),
                fields.get("domain"),
            )
            if value
        }
        for index, payload in enumerate(payloads):
            for company in companies:
                if company != companies[index]:
                    assert company not in payload["text"]
            for value in contact_values:
                if value not in contacts[index].values():
                    assert value.casefold() not in payload["text"].casefold()
        for key in ("phone", "email", "domain"):
            values = [fields.get(key) for fields in contacts if fields.get(key)]
            assert len(values) == len(set(values))
        assert session.scalar(select(func.count(Company.id))) == 4
        assert session.scalar(select(func.count(ReviewItem.id))) >= 1
        assert session.scalar(select(func.count(Job.id))) == 6


def test_resumed_detect_uses_numeric_page_mapping(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'test.db'}")
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, expire_on_commit=False)
    pdf = Path("tests/fixtures/Seniorenpost_Mai_Juni_2026.pdf").read_bytes()
    with session_factory() as session:
        pipeline = Pipeline(
            session,
            RecordedVisionProvider("tests/fixtures/qwen"),
            LocalStorage(tmp_path / "storage"),
            render_dpi=12,
            local_work_dir=tmp_path / "work",
        )
        document = pipeline.ingest(pdf)
        detect_job = session.scalar(
            select(Job).where(Job.document_id == document.id, Job.stage == "detect")
        )
        detect_job.state = "queued"
        session.commit()
        pipeline.ingest(pdf)
        ads = session.scalars(
            select(AdOccurrence)
            .join(Page)
            .where(Page.document_id == document.id, Page.page_number == 11)
        ).all()
        assert len(ads) == 4
        assert [ad.company.name for ad in ads] == [
            "Grau & Sohn",
            "Altenzentrum Wetzlar-Pariser Gasse",
            "AWO Kreisverband Lahn-Dill e.V.",
            "Pietät Ulm",
        ]
