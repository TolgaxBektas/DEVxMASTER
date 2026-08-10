"""add order form metadata and restored artwork artifacts"""

from alembic import op
import sqlalchemy as sa

revision = "0003_order_forms_artwork"
down_revision = "0002_discovery"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "pages",
        sa.Column("is_order_form", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "pages",
        sa.Column("form_header_json", sa.Text(), nullable=False, server_default="{}"),
    )
    op.add_column("ad_occurrences", sa.Column("artwork_path", sa.Text()))
    op.add_column("ad_occurrences", sa.Column("artwork_trimmed_path", sa.Text()))
    op.add_column(
        "ad_occurrences",
        sa.Column("artwork_metadata_json", sa.Text(), nullable=False, server_default="{}"),
    )
    op.add_column(
        "ad_occurrences",
        sa.Column("is_order_form", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade():
    op.drop_column("ad_occurrences", "is_order_form")
    op.drop_column("ad_occurrences", "artwork_metadata_json")
    op.drop_column("ad_occurrences", "artwork_trimmed_path")
    op.drop_column("ad_occurrences", "artwork_path")
    op.drop_column("pages", "form_header_json")
    op.drop_column("pages", "is_order_form")
