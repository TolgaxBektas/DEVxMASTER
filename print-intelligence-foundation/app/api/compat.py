import json
import re
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.auth import require_compat_auth
from app.api.dependencies import pipeline_dependency, session_dependency, storage_dependency
from app.core.config import get_settings
from app.models import Document, Page
from app.services.downloader import download_with_metadata
from app.services.discovery import DiscoveryCrawler
from app.services.ingest import validate_pdf
from app.services.storage import Storage
from app.services.text_layer import page_text_in_box
from app.services.bbox import Box


router = APIRouter(prefix="/api/v1", tags=["compatibility"])
_OUTPUT_PREFIX = re.compile(r"[A-Za-z0-9][A-Za-z0-9/_-]{0,199}\Z")


class FetchRequest(BaseModel):
    url: str


class DiscoveryProposalsRequest(BaseModel):
    seed_pages: list[str] = Field(default_factory=list)
    search_terms: list[str] = Field(default_factory=list)
    max_results: int = Field(default=100, ge=1, le=500)


def _validate_output_prefix(value: str) -> str:
    if (
        not _OUTPUT_PREFIX.fullmatch(value)
        or "//" in value
        or ".." in value
        or value.endswith("/")
    ):
        raise HTTPException(400, "invalid_output_prefix")
    return value


def _bbox(value: str) -> dict[str, float]:
    left, top, right, bottom = (float(item) for item in value.split(","))
    return {"x1": left, "y1": top, "x2": right, "y2": bottom}


def _publish_outputs(
    document: Document,
    output_prefix: str,
    storage: Storage,
    session,
) -> list[dict]:
    pages = session.scalars(
        select(Page)
        .where(Page.document_id == document.id)
        .order_by(Page.page_number)
    ).all()
    result = []
    for page in pages:
        page_key = f"{output_prefix}/page-{page.page_number:04d}.png"
        page_path = Path(page.image_path or "")
        if not page_path.is_file():
            raise HTTPException(500, "page render is not available")
        storage.put_file(page_path, page_key)
        occurrences = []
        for index, occurrence in enumerate(page.ads):
            crop_key = f"{output_prefix}/ad-{page.page_number:04d}-{index:04d}.png"
            if occurrence.crop_path:
                storage.put(storage.get(occurrence.crop_path), crop_key)
            artwork_key = None
            if occurrence.artwork_path:
                artwork_key = (
                    f"{output_prefix}/ad-{page.page_number:04d}-{index:04d}-artwork.png"
                )
                storage.put(storage.get(occurrence.artwork_path), artwork_key)
            payload = json.loads(occurrence.fields_json or "{}")
            occurrences.append(
                {
                    "bbox": _bbox(occurrence.bbox),
                    "image_key": crop_key,
                    "confidence": occurrence.confidence,
                    "company": occurrence.company.name if occurrence.company else "",
                    "preview": str(payload.get("text") or "")[:1000],
                    "restored_artwork_key": artwork_key,
                }
            )
        result.append(
            {
                "page_number": page.page_number,
                "text": _page_text(page),
                "image_key": page_key,
                "classification": page.classification or "unknown",
                "ad_probability": max(
                    (occurrence.confidence for occurrence in page.ads), default=0.0
                ),
                "occurrences": occurrences,
            }
        )
    return result


def _page_text(page: Page) -> str:
    source_path = Path(page.image_path or "").parent.parent / "source.pdf"
    if source_path.is_file():
        try:
            return page_text_in_box(
                source_path,
                page.page_number,
                Box(0, 0, 10_000, 10_000),
                get_settings().render_dpi,
            )
        except Exception:
            pass
    return " ".join(
        str(json.loads(occurrence.fields_json or "{}").get("text") or "")
        for occurrence in page.ads
    ).strip()


@router.post(
    "/process",
    dependencies=[Depends(require_compat_auth)],
)
async def process(
    file: UploadFile = File(...),
    output_prefix: str = Form(...),
    session=Depends(session_dependency),
    pipeline=Depends(pipeline_dependency),
    storage=Depends(storage_dependency),
):
    settings = get_settings()
    _validate_output_prefix(output_prefix)
    data = bytearray()
    while chunk := await file.read(1024 * 1024):
        data.extend(chunk)
        if len(data) > settings.max_download_bytes:
            raise HTTPException(413, "file too large")
    try:
        validate_pdf(bytes(data))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    document = pipeline.ingest(bytes(data), file.filename or "document.pdf")
    return {"pages": _publish_outputs(document, output_prefix, storage, session)}


@router.post(
    "/fetch",
    dependencies=[Depends(require_compat_auth)],
)
def fetch_source(payload: FetchRequest):
    try:
        data, metadata = download_with_metadata(
            payload.url, get_settings().max_download_bytes
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return Response(
        content=data,
        media_type="application/pdf",
        headers={
            "X-Source-Url": metadata["final_url"],
            "X-Source-Sha256": metadata["sha256"],
            "Content-Disposition": (
                f'attachment; filename="{metadata["filename"]}"'
            ),
        },
    )


@router.post(
    "/discovery/proposals",
    dependencies=[Depends(require_compat_auth)],
)
def discovery_proposals(payload: DiscoveryProposalsRequest):
    settings = get_settings()
    crawler = DiscoveryCrawler(
        session=None,
        max_bytes=settings.max_download_bytes,
        max_depth=settings.discovery_max_depth,
        max_pages=settings.discovery_max_pages,
        max_entries=settings.discovery_max_entries,
        timeout_seconds=settings.discovery_timeout_seconds,
        request_delay=settings.discovery_request_delay,
        user_agent=settings.discovery_user_agent,
    )
    return {
        "proposals": crawler.propose(
            payload.seed_pages, payload.search_terms, payload.max_results
        )
    }
