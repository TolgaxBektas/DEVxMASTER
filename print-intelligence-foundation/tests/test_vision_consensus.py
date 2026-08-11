from pathlib import Path

from pytest import approx
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.db.base import Base
from app.models import AdOccurrence, Page, ReviewItem
from app.services.bbox import Box
from app.services.pipeline import Pipeline
from app.services.storage import LocalStorage

from tests.test_order_forms import _pdf


class _ChangingProvider:
    def __init__(self, results):
        self.results = results
        self.calls = 0

    def detect_ads(self, _image_path, _page_number):
        result = self.results[self.calls]
        self.calls += 1
        return result

    def extract_fields(self, _crop_path):
        return {}

    def available(self):
        return True


def _pipeline(tmp_path, provider, runs):
    engine = create_engine(f"sqlite:///{tmp_path / 'consensus.db'}")
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, expire_on_commit=False)
    session = session_factory()
    pipeline = Pipeline(
        session,
        provider,
        LocalStorage(tmp_path / "storage"),
        render_dpi=36,
        local_work_dir=tmp_path / "work",
        bbox_iou_threshold=0.5,
        vision_consensus_runs=runs,
    )
    return session, pipeline


def test_consensus_keeps_majority_and_records_unstable_detection_review(tmp_path):
    majority = [
        {
            "bbox": [100, 100, 500, 500],
            "confidence": 0.2,
            "company_name": "Alpha GmbH",
        }
    ]
    majority_shifted = [
        {
            "bbox": [110, 100, 510, 500],
            "confidence": 0.3,
            "company_name": "Alpha GmbH",
        }
    ]
    minority = [
        {
            "bbox": [700, 700, 900, 900],
            "confidence": 1.0,
            "company_name": "False Positive GmbH",
        }
    ]
    provider = _ChangingProvider(
        [majority, majority_shifted, majority, minority, minority]
    )
    session, pipeline = _pipeline(tmp_path, provider, 5)
    try:
        pdf = _pdf(["Synthetic publication"])
        document = pipeline.ingest(pdf)
        page = session.scalar(select(Page).where(Page.document_id == document.id))
        ads = session.scalars(
            select(AdOccurrence).where(AdOccurrence.page_id == page.id)
        ).all()
        assert len(ads) == 1
        assert ads[0].bbox == "31,39,154,198"
        assert ads[0].confidence == approx(0.5389, abs=0.001)
        assert ads[0].company.name == "Alpha GmbH"
        review = session.scalar(
            select(ReviewItem).where(
                ReviewItem.page_id == page.id, ReviewItem.ad_id.is_(None)
            )
        )
        assert review is not None
        assert "detection unstable" in review.reason
        assert "False Positive" not in ads[0].fields_json
    finally:
        session.close()


def test_consensus_runs_once_preserving_original_result(tmp_path):
    result = [
        {
            "bbox": [100, 100, 500, 500],
            "confidence": 0.8,
            "company_name": "Original GmbH",
        }
    ]
    provider = _ChangingProvider([result])
    session, pipeline = _pipeline(tmp_path, provider, 1)
    try:
        candidates, unstable = pipeline._detect_candidates(
            Path("page.png"), 1, (1000, 1000)
        )
        assert candidates == [(Box(100, 100, 500, 500), result[0])]
        assert unstable == []
        assert provider.calls == 1
    finally:
        session.close()
