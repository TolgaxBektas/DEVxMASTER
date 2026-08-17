import json

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db.base import Base
from app.services.companies import (
    XDATA_GERMANY,
    XDATA_NB_HIGH_QUALITY,
    resolve_company,
)


def _session(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'companies.db'}")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, expire_on_commit=False)()


def test_germany_finding_does_not_overwrite_high_quality(tmp_path):
    session = _session(tmp_path)
    try:
        high_quality = resolve_company(
            session,
            "Muster GmbH",
            {"company": "Muster GmbH", "website_domain": "muster.example", "phones": ["030 12345"]},
            XDATA_NB_HIGH_QUALITY,
        )
        canonical = high_quality.canonical_fields_json
        germany = resolve_company(
            session,
            "Muster GmbH",
            {"company": "Muster GmbH", "website": "muster.example", "phone": "030 12345"},
            XDATA_GERMANY,
        )
        assert germany.id == high_quality.id
        assert germany.data_source == XDATA_NB_HIGH_QUALITY
        assert germany.canonical_fields_json == canonical
        assert len(json.loads(germany.secondary_findings_json)) == 1
    finally:
        session.close()


def test_high_quality_upgrades_germany_and_overwrites_canonical(tmp_path):
    session = _session(tmp_path)
    try:
        germany = resolve_company(
            session,
            "Muster GmbH",
            {"company": "Muster GmbH", "website": "muster.example"},
            XDATA_GERMANY,
        )
        high_quality = resolve_company(
            session,
            "Muster GmbH",
            {"company": "Muster GmbH", "website_domain": "muster.example", "phones": ["030 12345"]},
            XDATA_NB_HIGH_QUALITY,
        )
        assert high_quality.id == germany.id
        assert high_quality.data_source == XDATA_NB_HIGH_QUALITY
        assert json.loads(high_quality.canonical_fields_json)["phones"] == ["030 12345"]
    finally:
        session.close()


def test_same_name_without_hard_match_stays_separate(tmp_path):
    session = _session(tmp_path)
    try:
        first = resolve_company(
            session,
            "Muster GmbH",
            {"company": "Muster GmbH", "website": "first.example"},
            XDATA_GERMANY,
        )
        second = resolve_company(
            session,
            "Muster GmbH",
            {"company": "Muster GmbH", "website": "second.example"},
            XDATA_NB_HIGH_QUALITY,
        )
        assert second.id != first.id
        assert second.data_source == XDATA_NB_HIGH_QUALITY
    finally:
        session.close()


def test_normalized_phone_matches_across_sources(tmp_path):
    session = _session(tmp_path)
    try:
        germany = resolve_company(
            session,
            "Muster GmbH",
            {"company": "Muster GmbH", "phone": "030 / 123-45"},
            XDATA_GERMANY,
        )
        high_quality = resolve_company(
            session,
            "Muster GmbH",
            {"company": "Muster GmbH", "phones": [{"value": "03012345"}]},
            XDATA_NB_HIGH_QUALITY,
        )
        assert high_quality.id == germany.id
        assert high_quality.data_source == XDATA_NB_HIGH_QUALITY
    finally:
        session.close()


def test_secondary_findings_keep_only_latest_twenty(tmp_path):
    session = _session(tmp_path)
    try:
        company = resolve_company(
            session,
            "Muster GmbH",
            {"company": "Muster GmbH", "website": "muster.example"},
            XDATA_NB_HIGH_QUALITY,
        )
        for index in range(25):
            resolve_company(
                session,
                "Muster GmbH",
                {"company": "Muster GmbH", "website": "muster.example", "phone": str(index)},
                XDATA_GERMANY,
            )
        assert len(json.loads(company.secondary_findings_json)) == 20
    finally:
        session.close()
