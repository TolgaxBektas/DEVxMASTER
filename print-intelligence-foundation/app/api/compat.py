import json
import re
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from PIL import Image
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.auth import require_compat_auth
from app.api.dependencies import pipeline_dependency, session_dependency, storage_dependency
from app.core.config import get_settings
from app.models import Document, Page
from app.services.downloader import download_with_metadata, sanitize_filename
from app.services.discovery import DiscoveryCrawler
from app.services.ingest import validate_pdf
from app.services.storage import Storage
from app.services.text_layer import page_text


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


def _bbox(
    value: str, page_size: tuple[int, int]
) -> tuple[dict[str, float], dict[str, int]]:
    left, top, right, bottom = (float(item) for item in value.split(","))
    page_width, page_height = page_size
    pixel = {
        "x": int(left),
        "y": int(top),
        "width": int(right - left),
        "height": int(bottom - top),
    }
    normalized = {
        "x": pixel["x"] / page_width,
        "y": pixel["y"] / page_height,
        "width": pixel["width"] / page_width,
        "height": pixel["height"] / page_height,
    }
    return normalized, pixel


def _publish_outputs(
    document: Document,
    output_prefix: str,
    storage: Storage,
    session,
    pipeline,
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
        with Image.open(page_path) as image:
            page_size = image.size
        occurrences = []
        for index, occurrence in enumerate(page.ads):
            crop_key = None
            if occurrence.crop_path:
                crop_key = f"{output_prefix}/ad-{page.page_number:04d}-{index:04d}.png"
                storage.put(storage.get(occurrence.crop_path), crop_key)
            artwork_key = None
            if occurrence.artwork_path:
                artwork_key = (
                    f"{output_prefix}/ad-{page.page_number:04d}-{index:04d}-artwork.png"
                )
                storage.put(storage.get(occurrence.artwork_path), artwork_key)
            payload = json.loads(occurrence.fields_json or "{}")
            bbox, pixel_bbox = _bbox(occurrence.bbox, page_size)
            occurrences.append(
                {
                    "bbox": bbox,
                    "pixel_bbox": pixel_bbox,
                    "render_dpi": get_settings().render_dpi,
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
                "text": _page_text(page, pipeline),
                "image_key": page_key,
                "classification": page.classification or "unknown",
                "ad_probability": max(
                    _classification_probability(page.classification),
                    max(
                        (occurrence.confidence for occurrence in page.ads),
                        default=0.0,
                    ),
                ),
                "occurrences": occurrences,
            }
        )
    return result


def _classification_probability(classification: str | None) -> float:
    return {"ad-page": 1.0, "mixed": 0.5}.get(classification or "", 0.0)


def _page_text(page: Page, pipeline) -> str:
    source_path = pipeline.source_path(page.document.content_sha256)
    if source_path.is_file():
        return page_text(source_path, page.page_number)
    return " ".join(
        str(json.loads(occurrence.fields_json or "{}").get("text") or "")
        for occurrence in page.ads
    ).strip()


def _restore_missing_renders(document: Document, pipeline, session) -> Document:
    pages = session.scalars(
        select(Page).where(Page.document_id == document.id)
    ).all()
    if not any(not Path(page.image_path or "").is_file() for page in pages):
        return document
    try:
        source = pipeline.storage.get(f"{document.content_sha256}/source.pdf")
    except Exception as exc:
        raise HTTPException(409, "source is not available in storage") from exc
    return pipeline.reprocess(source, document.filename or "document.pdf")


@router.post(
    "/process",
    dependencies=[Depends(require_compat_auth)],
)
def process(
    file: UploadFile = File(...),
    output_prefix: str = Form(...),
    session=Depends(session_dependency),
    storage=Depends(storage_dependency),
):
    settings = get_settings()
    _validate_output_prefix(output_prefix)
    data = bytearray()
    while chunk := file.file.read(1024 * 1024):
        data.extend(chunk)
        if len(data) > settings.max_download_bytes:
            raise HTTPException(413, "file too large")
    try:
        validate_pdf(bytes(data))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    pipeline = pipeline_dependency(session)
    document = pipeline.ingest(bytes(data), file.filename or "document.pdf")
    document = _restore_missing_renders(document, pipeline, session)
    return {
        "pages": _publish_outputs(
            document, output_prefix, storage, session, pipeline
        )
    }


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
                f'attachment; filename="{sanitize_filename(metadata["filename"])}"'
            ),
        },
    )


@router.post(
    "/discovery/proposals",
    dependencies=[Depends(require_compat_auth)],
)
def discovery_proposals(payload: DiscoveryProposalsRequest):
    settings = get_settings()
    crawler = DiscoveryCrawler.for_proposals(
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
