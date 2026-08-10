import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from alembic import context
from app.db.base import Base
from app.models import *  # noqa
from sqlalchemy import engine_from_config, pool
target_metadata = Base.metadata
def run_migrations_online():
    configuration = context.config.get_section(context.config.config_ini_section, {})
    engine = engine_from_config(configuration, prefix="sqlalchemy.", poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)
        with context.begin_transaction(): context.run_migrations()
run_migrations_online()
