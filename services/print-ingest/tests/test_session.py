from sqlalchemy import text

from app.db.session import create_database_engine


def test_sqlite_engine_configures_concurrent_writes(tmp_path):
    engine = create_database_engine(f"sqlite:///{tmp_path / 'print-ingest.db'}")
    try:
        with engine.connect() as connection:
            assert connection.execute(text("PRAGMA journal_mode")).scalar() == "wal"
            assert connection.execute(text("PRAGMA busy_timeout")).scalar() == 30000
    finally:
        engine.dispose()
