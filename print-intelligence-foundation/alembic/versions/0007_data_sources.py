"""add xDATA source-aware company state.

Source provenance is assigned by ingestion, never inferred from filenames.
Existing databases are corrected by 0008 using the legacy migration marker.
"""

import json
from datetime import datetime, timezone

from alembic import op
import sqlalchemy as sa


revision = "0007_data_sources"
down_revision = "0006_review_notes"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "companies",
        sa.Column("data_source", sa.String(length=40), nullable=False, server_default="xdata_germany"),
    )
    op.add_column(
        "companies",
        sa.Column("canonical_fields_json", sa.Text(), nullable=False, server_default="{}"),
    )
    op.add_column(
        "companies",
        sa.Column("secondary_findings_json", sa.Text(), nullable=False, server_default="[]"),
    )
    op.add_column(
        "companies",
        sa.Column("canonical_updated_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "ad_occurrences",
        sa.Column("data_source", sa.String(length=40), nullable=False, server_default="xdata_germany"),
    )
    connection = op.get_bind()
    connection.execute(
        sa.text(
            "UPDATE ad_occurrences SET data_source = 'xdata_germany'"
        )
    )
    rows = connection.execute(
        sa.text(
            "SELECT c.id FROM companies c"
        )
    ).mappings()
    now = datetime.now(timezone.utc)
    canonical_by_company = {}
    occurrence_rows = connection.execute(
        sa.text(
            "SELECT a.company_id, a.fields_json "
            "FROM ad_occurrences a "
            "WHERE a.company_id IS NOT NULL "
            "ORDER BY a.id"
        )
    ).mappings()
    for occurrence in occurrence_rows:
        company_id = occurrence["company_id"]
        if company_id in canonical_by_company:
            continue
        try:
            fields = json.loads(occurrence["fields_json"] or "{}")
        except (TypeError, json.JSONDecodeError):
            fields = {}
        canonical_by_company[company_id] = fields if isinstance(fields, dict) else {}
    for row in rows:
        connection.execute(
            sa.text(
                "UPDATE companies SET data_source = 'xdata_germany', "
                "canonical_fields_json = :fields, canonical_updated_at = :updated_at "
                "WHERE id = :id"
            ),
            {
                "fields": json.dumps(canonical_by_company.get(row["id"], {}), ensure_ascii=False),
                "updated_at": now,
                "id": row["id"],
            },
        )


def downgrade():
    op.drop_column("ad_occurrences", "data_source")
    op.drop_column("companies", "canonical_updated_at")
    op.drop_column("companies", "secondary_findings_json")
    op.drop_column("companies", "canonical_fields_json")
    op.drop_column("companies", "data_source")
