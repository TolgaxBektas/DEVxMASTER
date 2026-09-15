from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from app.core.config import settings


def create_database_engine(database_url: str):
    is_sqlite = database_url.startswith('sqlite')
    connect_args = {'check_same_thread': False, 'timeout': 30} if is_sqlite else {}
    database_engine = create_engine(
        database_url,
        pool_pre_ping=True,
        connect_args=connect_args,
    )
    if is_sqlite:
        @event.listens_for(database_engine, 'connect')
        def configure_sqlite_connection(dbapi_connection, _connection_record):
            cursor = dbapi_connection.cursor()
            try:
                cursor.execute('PRAGMA journal_mode=WAL')
                cursor.execute('PRAGMA busy_timeout=30000')
            finally:
                cursor.close()
    return database_engine


engine = create_database_engine(settings.database_url)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
