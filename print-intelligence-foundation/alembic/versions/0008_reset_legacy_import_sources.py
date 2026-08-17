"""reset the source inferred by the previous migration.

0007 originally classified print-batch filenames as High Quality. That
classification was not provenance and cannot be retained. The explicit marker
is false for rows created before source-aware imports; newly imported rows set
it from metadata, so later genuine High Quality rows are preserved.
"""

from alembic import op
import sqlalchemy as sa


revision = "0008_reset_legacy_import_sources"
down_revision = "0007_data_sources"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "ad_occurrences",
        sa.Column("source_explicit", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    connection = op.get_bind()
    connection.execute(
        sa.text(
            "UPDATE ad_occurrences SET data_source = 'xdata_germany' "
            "WHERE data_source = 'xdata_nb_high_quality' AND source_explicit IS FALSE "
            "AND EXISTS ("
            "SELECT 1 FROM pages p JOIN documents d ON d.id = p.document_id "
            "WHERE p.id = ad_occurrences.page_id AND "
            "(d.filename LIKE 'print-batch-%' OR d.content_sha256 LIKE 'print-batch-%')"
            ")"
        )
    )
    connection.execute(
        sa.text(
            "UPDATE companies SET data_source = 'xdata_germany' "
            "WHERE data_source = 'xdata_nb_high_quality' AND NOT EXISTS ("
            "SELECT 1 FROM ad_occurrences a "
            "WHERE a.company_id = companies.id "
            "AND a.data_source = 'xdata_nb_high_quality'"
            ")"
        )
    )


def downgrade():
    op.drop_column("ad_occurrences", "source_explicit")
