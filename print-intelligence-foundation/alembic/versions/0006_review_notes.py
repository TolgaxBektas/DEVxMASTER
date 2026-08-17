"""persist manual review notes"""

from alembic import op
import sqlalchemy as sa


revision = "0006_review_notes"
down_revision = "0005_restoration_proposals"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("review_items", sa.Column("review_note", sa.Text(), nullable=True))


def downgrade():
    op.drop_column("review_items", "review_note")
