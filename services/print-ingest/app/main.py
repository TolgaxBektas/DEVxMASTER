from fastapi import FastAPI
from app.core.config import settings
from app.db.base import Base
from app.db.session import engine
from app.api.routes import router
from app.api.ui import router as ui_router
from app.api.stateless import router as stateless_router

app=FastAPI(title=settings.app_name,version='0.1.0')

@app.on_event('startup')
def startup():
    Base.metadata.create_all(bind=engine)

app.include_router(router,prefix='/api/v1')
app.include_router(stateless_router,prefix='/api/v1')

app.include_router(ui_router)
