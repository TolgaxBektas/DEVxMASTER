"""add restoration proposal artifacts"""

from alembic import op
import sqlalchemy as sa


revision = "0005_restoration_proposals"
down_revision = "0004_detection_reviews"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("ad_occurrences", sa.Column("restoration_path", sa.Text(), nullable=True))
    op.add_column(
        "ad_occurrences",
        sa.Column(
            "restoration_manifest_json",
            sa.Text(),
            nullable=False,
            server_default="{}",
        ),
    )


def downgrade():
    op.drop_column("ad_occurrences", "restoration_manifest_json")
    op.drop_column("ad_occurrences", "restoration_path")
