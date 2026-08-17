import hashlib
import json
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, ConfigDict, Field, PositiveInt, ValidationError
from sqlalchemy import select

from app.api.auth import require_auth
from app.api.dependencies import session_dependency, storage_dependency
from app.core.config import get_settings
from app.models import AdOccurrence, Document, Page, ReviewItem
from app.services.companies import XDATA_GERMANY, resolve_company
from app.services.ingest import UploadTooLargeError, read_limited
from app.services.storage import sha256


class PrintBatchSource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    data_source: Literal["xdata_nb_high_quality", "xdata_germany"] = XDATA_GERMANY
    publication: str | None = None
    issue: str | None = None
    page: PositiveInt
    url: str | None = None


class PrintBatchMetadata(BaseModel):
    company_name: str = Field(min_length=1)
    source: PrintBatchSource
    bbox: list[float] = Field(min_length=4, max_length=4)
    crop_size: list[int] = Field(min_length=2, max_length=2)
    evidence: dict[str, Any]
    plan_digest: str = Field(min_length=1)
    prompt_hash: str = Field(min_length=1)
    model_name: str = Field(min_length=1)
    output_size: str = Field(min_length=1)
    usage: dict[str, Any]
    cost: dict[str, Any]
    restaurierung: dict[str, Any]


router = APIRouter(
    prefix="/imports", tags=["imports"], dependencies=[Depends(require_auth)]
)


def _stable_key(metadata: PrintBatchMetadata) -> str:
    identity = {
        "company_name": metadata.company_name,
        "source": metadata.source.model_dump(exclude={"data_source"}),
        "bbox": metadata.bbox,
    }
    return hashlib.sha256(
        json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _manifest(metadata: PrintBatchMetadata) -> dict[str, Any]:
    manifest = dict(metadata.restaurierung)
    manifest.setdefault("model_name", metadata.model_name)
    manifest.setdefault("output_size", metadata.output_size)
    manifest.setdefault("usage", metadata.usage)
    manifest.setdefault("cost", metadata.cost)
    manifest.setdefault("prompt_hash", metadata.prompt_hash)
    manifest["review_status"] = "pending"
    manifest["geometry_quality"] = {
        "status": "external_generated_not_geometrically_measured",
        "reason": "extern erzeugt, nicht geometrisch gemessen",
    }
    return manifest


@router.post("/print-batch")
def import_print_batch(
    original: UploadFile = File(...),
    restored: UploadFile = File(...),
    metadata: str = Form(...),
    session=Depends(session_dependency),
    storage=Depends(storage_dependency),
):
    try:
        payload = PrintBatchMetadata.model_validate_json(metadata)
    except (ValidationError, ValueError) as exc:
        raise HTTPException(422, "invalid print-batch metadata") from exc

    max_bytes = get_settings().max_download_bytes
    try:
        original_bytes = read_limited(original.file, max_bytes)
        restored_bytes = read_limited(restored.file, max_bytes)
    except UploadTooLargeError as exc:
        raise HTTPException(413, str(exc)) from exc
    if not original_bytes or not restored_bytes:
        raise HTTPException(422, "original and restored images are required")

    manifest = _manifest(payload)
    if not payload.prompt_hash or not payload.restaurierung:
        raise HTTPException(422, "restaurierung and prompt_hash are required")

    identity = _stable_key(payload)
    document_digest = sha256(f"print-batch:{identity}".encode())
    document = session.scalar(
        select(Document).where(Document.content_sha256 == document_digest)
    )
    if document is None:
        document = Document(
            content_sha256=document_digest,
            source_url=str(payload.source.url or payload.source.publication or ""),
            filename=f"print-batch-{identity}.json",
        )
        session.add(document)
        session.flush()
        page = Page(
            document_id=document.id,
            page_number=payload.source.page,
            image_path=None,
            classification="advertisement",
        )
        session.add(page)
        session.flush()
        occurrence = AdOccurrence(
            page_id=page.id,
            occurrence_key=identity,
            bbox=json.dumps(payload.bbox),
            confidence=1.0,
            data_source=payload.source.data_source,
        )
        session.add(occurrence)
    else:
        page = session.scalar(select(Page).where(Page.document_id == document.id))
        occurrence = session.scalar(
            select(AdOccurrence).where(AdOccurrence.page_id == page.id)
        )
    occurrence.data_source = payload.source.data_source
    occurrence.source_explicit = "data_source" in payload.source.model_fields_set
    session.flush()

    company = resolve_company(
        session,
        payload.company_name,
        {"company": payload.company_name, **payload.evidence},
        payload.source.data_source,
    )

    prefix = f"print-batch/{identity}"
    occurrence.artwork_path = storage.put(original_bytes, f"{prefix}/original.png")
    occurrence.restoration_path = storage.put(restored_bytes, f"{prefix}/restored.png")
    occurrence.artwork_metadata_json = json.dumps(
        {
            "company_name": payload.company_name,
            "source": payload.source.model_dump(),
            "crop_size": payload.crop_size,
            "evidence": payload.evidence,
            "plan_digest": payload.plan_digest,
            "prompt_hash": payload.prompt_hash,
        },
        ensure_ascii=False,
    )
    occurrence.restoration_manifest_json = json.dumps(
        manifest, ensure_ascii=False
    )
    occurrence.company_id = company.id
    occurrence.fields_json = json.dumps(
        {"company": payload.company_name, "evidence": payload.evidence},
        ensure_ascii=False,
    )
    review = session.scalar(
        select(ReviewItem).where(ReviewItem.ad_id == occurrence.id)
    )
    if review is None:
        session.add(
            ReviewItem(
                ad_id=occurrence.id,
                page_id=page.id,
                status="pending",
                reason="generativ erzeugt, menschliche Freigabe erforderlich",
            )
        )
    else:
        review.status = "pending"
        review.reason = "generativ erzeugt, menschliche Freigabe erforderlich"
        review.reviewed_at = None
    session.commit()
    return {
        "document_id": document.id,
        "ad_id": occurrence.id,
        "review_status": "pending",
        "artwork_url": f"/documents/{document.id}/ads/{occurrence.id}/artwork",
        "restoration_url": f"/documents/{document.id}/ads/{occurrence.id}/restoration",
        "manifest_url": (
            f"/documents/{document.id}/ads/{occurrence.id}/restoration/manifest"
        ),
    }
