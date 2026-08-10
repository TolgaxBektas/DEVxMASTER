"""initial pipeline schema"""
from alembic import op
import sqlalchemy as sa

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("documents", sa.Column("id", sa.Integer(), primary_key=True), sa.Column("content_sha256", sa.String(64), nullable=False), sa.Column("source_url", sa.Text()), sa.Column("filename", sa.String(255)), sa.Column("created_at", sa.DateTime(timezone=True), nullable=False), sa.UniqueConstraint("content_sha256"))
    op.create_table("pages", sa.Column("id", sa.Integer(), primary_key=True), sa.Column("document_id", sa.Integer(), sa.ForeignKey("documents.id"), nullable=False), sa.Column("page_number", sa.Integer(), nullable=False), sa.Column("image_path", sa.Text()), sa.Column("classification", sa.String(50)), sa.UniqueConstraint("document_id", "page_number"))
    op.create_index("ix_pages_document_id", "pages", ["document_id"])
    op.create_table("companies", sa.Column("id", sa.Integer(), primary_key=True), sa.Column("name", sa.String(500), nullable=False), sa.Column("normalized_name", sa.String(500), nullable=False), sa.Column("contact_key", sa.String(500), nullable=False), sa.UniqueConstraint("normalized_name", "contact_key"))
    op.create_index("ix_companies_normalized_name", "companies", ["normalized_name"])
    op.create_table("ad_occurrences", sa.Column("id", sa.Integer(), primary_key=True), sa.Column("page_id", sa.Integer(), sa.ForeignKey("pages.id"), nullable=False), sa.Column("occurrence_key", sa.String(128), nullable=False), sa.Column("bbox", sa.String(100), nullable=False), sa.Column("crop_path", sa.Text()), sa.Column("company_id", sa.Integer(), sa.ForeignKey("companies.id")), sa.Column("fields_json", sa.Text(), nullable=False), sa.Column("confidence", sa.Float(), nullable=False), sa.UniqueConstraint("page_id", "occurrence_key"))
    op.create_index("ix_ad_occurrences_page_id", "ad_occurrences", ["page_id"])
    op.create_table("review_items", sa.Column("id", sa.Integer(), primary_key=True), sa.Column("ad_id", sa.Integer(), sa.ForeignKey("ad_occurrences.id"), nullable=False), sa.Column("status", sa.String(20), nullable=False), sa.Column("reason", sa.Text(), nullable=False), sa.Column("reviewed_at", sa.DateTime(timezone=True)), sa.UniqueConstraint("ad_id"))
    op.create_table("jobs", sa.Column("id", sa.Integer(), primary_key=True), sa.Column("document_id", sa.Integer(), sa.ForeignKey("documents.id")), sa.Column("stage", sa.String(50), nullable=False), sa.Column("state", sa.String(20), nullable=False), sa.Column("attempts", sa.Integer(), nullable=False), sa.Column("max_attempts", sa.Integer(), nullable=False), sa.Column("created_at", sa.DateTime(timezone=True), nullable=False), sa.Column("started_at", sa.DateTime(timezone=True)), sa.Column("finished_at", sa.DateTime(timezone=True)), sa.Column("last_error", sa.Text()), sa.UniqueConstraint("document_id", "stage"))


def downgrade():
    for table in ("jobs", "review_items"):
        op.drop_table(table)
    op.drop_index("ix_ad_occurrences_page_id", table_name="ad_occurrences")
    op.drop_table("ad_occurrences")
    op.drop_index("ix_companies_normalized_name", table_name="companies")
    op.drop_table("companies")
    op.drop_index("ix_pages_document_id", table_name="pages")
    op.drop_table("pages")
    op.drop_table("documents")
