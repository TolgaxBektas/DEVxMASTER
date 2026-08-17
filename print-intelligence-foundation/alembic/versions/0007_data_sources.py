"""add xDATA source-aware company state"""

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
    connection = op.get_bind()
    rows = connection.execute(
        sa.text(
            "SELECT c.id, c.name, c.contact_key, "
            "EXISTS (SELECT 1 FROM ad_occurrences a "
            "JOIN pages p ON p.id = a.page_id "
            "JOIN documents d ON d.id = p.document_id "
            "WHERE a.company_id = c.id AND "
            "(d.filename LIKE 'print-batch-%' OR d.content_sha256 LIKE 'print-batch-%')) "
            "AS is_high_quality FROM companies c"
        )
    ).mappings()
    now = datetime.now(timezone.utc)
    canonical_by_company = {}
    occurrence_rows = connection.execute(
        sa.text(
            "SELECT a.company_id, a.fields_json, d.filename "
            "FROM ad_occurrences a JOIN pages p ON p.id = a.page_id "
            "JOIN documents d ON d.id = p.document_id "
            "WHERE a.company_id IS NOT NULL "
            "ORDER BY CASE WHEN "
            "(d.filename LIKE 'print-batch-%' OR d.content_sha256 LIKE 'print-batch-%') "
            "THEN 0 ELSE 1 END, a.id"
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
        source = "xdata_nb_high_quality" if row["is_high_quality"] else "xdata_germany"
        connection.execute(
            sa.text(
                "UPDATE companies SET data_source = :source, "
                "canonical_fields_json = :fields, canonical_updated_at = :updated_at "
                "WHERE id = :id"
            ),
            {
                "source": source,
                "fields": json.dumps(canonical_by_company.get(row["id"], {}), ensure_ascii=False),
                "updated_at": now,
                "id": row["id"],
            },
        )


def downgrade():
    op.drop_column("companies", "canonical_updated_at")
    op.drop_column("companies", "secondary_findings_json")
    op.drop_column("companies", "canonical_fields_json")
    op.drop_column("companies", "data_source")
