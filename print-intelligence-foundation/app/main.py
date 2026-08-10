from contextlib import asynccontextmanager
from fastapi import FastAPI
from app.api import documents, health, reviews
from app.core.config import get_settings
from app.core.config import validate_auth_config
from app.db.base import Base
from app.db.session import engine
from app import models  # noqa: F401


@asynccontextmanager
async def lifespan(_app: FastAPI):
    validate_auth_config(get_settings())
    Base.metadata.create_all(engine)
    yield


app = FastAPI(title=get_settings().app_name, lifespan=lifespan)
app.include_router(health.router)
app.include_router(documents.router)
app.include_router(reviews.router)
