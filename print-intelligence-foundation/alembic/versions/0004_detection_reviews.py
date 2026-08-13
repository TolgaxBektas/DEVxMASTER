"""allow page-level detection review items

Revision ID: 0004_detection_reviews
Revises: 0003_order_forms_artwork
"""

from alembic import op
import sqlalchemy as sa


revision = "0004_detection_reviews"
down_revision = "0003_order_forms_artwork"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("review_items") as batch:
        batch.alter_column("ad_id", existing_type=sa.Integer(), nullable=True)
        batch.add_column(sa.Column("page_id", sa.Integer(), nullable=True))
        batch.create_foreign_key(
            "fk_review_items_page_id", "pages", ["page_id"], ["id"]
        )
        batch.create_index("ix_review_items_page_id", ["page_id"])
        batch.create_index(
            "uq_review_items_page_review",
            ["page_id"],
            unique=True,
            sqlite_where=sa.text("ad_id IS NULL"),
            postgresql_where=sa.text("ad_id IS NULL"),
        )


def downgrade():
    with op.batch_alter_table("review_items") as batch:
        batch.drop_index("uq_review_items_page_review")
        batch.drop_index("ix_review_items_page_id")
        batch.drop_constraint("fk_review_items_page_id", type_="foreignkey")
        batch.drop_column("page_id")
        batch.alter_column("ad_id", existing_type=sa.Integer(), nullable=False)
