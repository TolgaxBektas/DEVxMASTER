"""store unsupported X-Core communication channels for later import."""

from alembic import op
import sqlalchemy as sa


revision = "0009_deferred_channels"
down_revision = "0008_reset_legacy_import_sources"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "deferred_channels",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("company_id", sa.Integer(), sa.ForeignKey("companies.id"), nullable=False),
        sa.Column("field_name", sa.String(length=50), nullable=False),
        sa.Column("value", sa.Text(), nullable=False),
        sa.Column("source_url", sa.Text(), nullable=True),
        sa.Column("retrieved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("data_source", sa.String(length=40), nullable=False, server_default="xdata_germany"),
        sa.Column("recorded_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("status", sa.String(length=30), nullable=False, server_default="waiting_for_x_core"),
        sa.UniqueConstraint("company_id", "field_name", "value"),
    )
    op.create_index(
        "ix_deferred_channels_company_id", "deferred_channels", ["company_id"]
    )
    op.create_index(
        "ix_deferred_channels_status_source",
        "deferred_channels",
        ["status", "data_source"],
    )


def downgrade():
    op.drop_index("ix_deferred_channels_status_source", table_name="deferred_channels")
    op.drop_index("ix_deferred_channels_company_id", table_name="deferred_channels")
    op.drop_table("deferred_channels")
