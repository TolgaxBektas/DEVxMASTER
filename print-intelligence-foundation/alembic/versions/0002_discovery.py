"""persist discovery sources and candidates"""
from alembic import op
import sqlalchemy as sa

revision = "0002_discovery"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "sources",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("base_url", sa.Text(), nullable=False),
        sa.Column("label", sa.String(255), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("crawl_strategy", sa.String(20), nullable=False),
        sa.Column("last_crawled_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("base_url"),
    )
    op.create_table(
        "discovered_candidates",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("source_id", sa.Integer(), sa.ForeignKey("sources.id"), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("normalized_url", sa.Text(), nullable=False),
        sa.Column("discovered_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("state", sa.String(20), nullable=False),
        sa.Column("error", sa.Text()),
        sa.Column("content_sha256", sa.String(64)),
        sa.Column("document_id", sa.Integer(), sa.ForeignKey("documents.id")),
        sa.UniqueConstraint("normalized_url"),
    )
    op.create_index(
        "ix_discovered_candidates_source_id",
        "discovered_candidates",
        ["source_id"],
    )


def downgrade():
    op.drop_index("ix_discovered_candidates_source_id", table_name="discovered_candidates")
    op.drop_table("discovered_candidates")
    op.drop_table("sources")
