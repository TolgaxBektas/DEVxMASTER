import json

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import AdOccurrence, Company, DeferredChannel
from app.services.dedupe import normalize_name


def _alembic_config(database_url, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", database_url)
    from app.core.config import get_settings

    get_settings.cache_clear()
    config = Config("alembic.ini")
    config.set_main_option("sqlalchemy.url", database_url)
    return config


def _upgrade_to_head(tmp_path, monkeypatch):
    database_url = f"sqlite:///{tmp_path / 'migration.db'}"
    config = _alembic_config(database_url, monkeypatch)
    command.upgrade(config, "head")
    return database_url, config


def test_normalization_migration_merges_references_and_rehomes_data(
    tmp_path, monkeypatch
):
    database_url, config = _upgrade_to_head(tmp_path, monkeypatch)
    engine = create_engine(database_url)
    with Session(engine) as session:
        old = Company(
            name="Altenzentrum Wetzlar–Pariser Gasse",
            normalized_name="altenzentrum wetzlar–pariser gasse",
            contact_key="domain=altenzentrum-wetzlar.de",
            data_source="xdata_germany",
            canonical_fields_json=json.dumps(
                {"website_domain": "altenzentrum-wetzlar.de"}
            ),
            secondary_findings_json="[]",
        )
        high_quality = Company(
            name="Altenzentrum Wetzlar–Pariser Gasse",
            normalized_name="altenzentrum wetzlar pariser gasse",
            contact_key="domain=altenzentrum-wetzlar.de|email=info@example.test",
            data_source="xdata_nb_high_quality",
            canonical_fields_json=json.dumps(
                {
                    "website_domain": "altenzentrum-wetzlar.de",
                    "email": "info@example.test",
                }
            ),
            secondary_findings_json="[]",
        )
        session.add_all([old, high_quality])
        session.flush()
        occurrence = AdOccurrence(
            page_id=1,
            occurrence_key="migration-test",
            bbox="[0, 0, 1, 1]",
            confidence=1,
            company_id=old.id,
        )
        session.add(occurrence)
        session.add_all(
            [
                DeferredChannel(
                    company_id=old.id,
                    field_name="fax",
                    value="06441 123",
                    data_source="xdata_germany",
                ),
                DeferredChannel(
                    company_id=high_quality.id,
                    field_name="fax",
                    value="06441 123",
                    data_source="xdata_nb_high_quality",
                ),
            ]
        )
        session.commit()
        old_id, high_quality_id = old.id, high_quality.id

    command.stamp(config, "0009_deferred_channels")
    command.upgrade(config, "0010_repair_company_norm")

    with Session(engine) as session:
        companies = session.scalars(select(Company)).all()
        assert len(companies) == 1
        winner = companies[0]
        assert winner.id == high_quality_id
        assert winner.normalized_name == normalize_name(winner.name)
        assert session.scalar(select(AdOccurrence.company_id)) == high_quality_id
        channels = session.scalars(select(DeferredChannel)).all()
        assert len(channels) == 1
        assert channels[0].company_id == high_quality_id
        assert channels[0].data_source == "xdata_nb_high_quality"
        findings = json.loads(winner.secondary_findings_json)
        assert any(item["fields"].get("website_domain") for item in findings)
        assert old_id != high_quality_id


def test_normalization_migration_keeps_different_hard_contacts_separate(
    tmp_path, monkeypatch
):
    database_url, config = _upgrade_to_head(tmp_path, monkeypatch)
    engine = create_engine(database_url)
    with Session(engine) as session:
        session.add_all(
            [
                Company(
                    name="Pietät Ulm",
                    normalized_name="pietat ul m",
                    contact_key="domain=first.example",
                    canonical_fields_json=json.dumps(
                        {"website_domain": "first.example"}
                    ),
                    secondary_findings_json="[]",
                ),
                Company(
                    name="Pietät Ulm",
                    normalized_name="pietat ulm",
                    contact_key="domain=second.example",
                    canonical_fields_json=json.dumps(
                        {"website_domain": "second.example"}
                    ),
                    secondary_findings_json="[]",
                ),
            ]
        )
        session.commit()

    command.stamp(config, "0009_deferred_channels")
    command.upgrade(config, "0010_repair_company_norm")

    with Session(engine) as session:
        companies = session.scalars(select(Company)).all()
        assert len(companies) == 2
        assert {company.normalized_name for company in companies} == {"pietat ulm"}
