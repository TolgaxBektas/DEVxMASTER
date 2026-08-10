import json
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import select
from app.api.auth import require_auth
from app.api.dependencies import pipeline_dependency, session_dependency
from app.core.config import get_settings
from app.models import Document, Page
from app.services.downloader import download
from app.services.storage import sha256

router = APIRouter(
    prefix="/documents", tags=["documents"], dependencies=[Depends(require_auth)]
)


@router.post("/upload")
def upload(file: UploadFile = File(...), session=Depends(session_dependency)):
    settings = get_settings()
    data = bytearray()
    while chunk := file.file.read(1024 * 1024):
        data.extend(chunk)
        if len(data) > settings.max_download_bytes:
            raise HTTPException(413, "file too large")
    return {
        "document_id": pipeline_dependency(session)
        .ingest(bytes(data), file.filename or "document.pdf")
        .id
    }


@router.post("/url")
def ingest_url(url: str, session=Depends(session_dependency)):
    settings = get_settings()
    try:
        data = download(url, settings.max_download_bytes)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    digest = sha256(data)
    existing = session.scalar(select(Document).where(Document.content_sha256 == digest))
    if existing:
        return {"document_id": existing.id}
    return {"document_id": pipeline_dependency(session).ingest(data, source_url=url).id}


@router.post("/{document_id}/reprocess")
def reprocess(document_id: int, session=Depends(session_dependency)):
    doc = session.get(Document, document_id)
    if not doc:
        raise HTTPException(404)
    storage = pipeline_dependency(session).storage
    try:
        data = storage.get(f"{doc.content_sha256}/source.pdf")
    except Exception as exc:
        raise HTTPException(409, "source is not available in storage") from exc
    return {
        "document_id": pipeline_dependency(session)
        .reprocess(data, doc.filename or "document.pdf")
        .id
    }


@router.get("/{document_id}")
def document(document_id: int, session=Depends(session_dependency)):
    doc = session.get(Document, document_id)
    if not doc:
        raise HTTPException(404)
    pages = session.scalars(select(Page).where(Page.document_id == document_id)).all()
    return {
        "id": doc.id,
        "pages": [
            {
                "id": p.id,
                "page_number": p.page_number,
                "classification": p.classification,
                "ads": [
                    {
                        "id": a.id,
                        "company": a.company.name if a.company else None,
                        "fields": json.loads(a.fields_json or "{}").get("fields", {}),
                        "text": json.loads(a.fields_json or "{}").get("text", ""),
                        "bbox": a.bbox,
                    }
                    for a in p.ads
                ],
            }
            for p in pages
        ],
    }
