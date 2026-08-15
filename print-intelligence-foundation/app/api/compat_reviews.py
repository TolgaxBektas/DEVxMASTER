import json
from datetime import datetime
from typing import Any

from botocore.exceptions import ClientError
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import or_, select

from app.api.auth import require_compat_auth
from app.api.dependencies import session_dependency, storage_dependency
from app.api.reviews import apply_review_decision
from app.models import AdOccurrence, Company, Document, Page, ReviewItem


router = APIRouter(prefix="/api/v1/reviews", tags=["compatibility-review"])


class ReviewDecision(BaseModel):
    decision: str
    note: str | None = None


def _item_query():
    return (
        select(ReviewItem, AdOccurrence, Page, Document, Company)
        .outerjoin(AdOccurrence, ReviewItem.ad_id == AdOccurrence.id)
        .outerjoin(
            Page,
            or_(
                AdOccurrence.page_id == Page.id,
                ReviewItem.page_id == Page.id,
            ),
        )
        .outerjoin(Document, Page.document_id == Document.id)
        .outerjoin(Company, AdOccurrence.company_id == Company.id)
    )


def _manifest(occurrence: AdOccurrence | None) -> dict[str, Any]:
    if occurrence is None:
        return {}
    try:
        return json.loads(occurrence.restoration_manifest_json or "{}")
    except (TypeError, json.JSONDecodeError):
        return {}


def _contact_data(occurrence: AdOccurrence | None) -> tuple[dict[str, Any], Any]:
    if occurrence is None:
        return {}, {}
    try:
        data = json.loads(occurrence.fields_json or "{}")
    except (TypeError, json.JSONDecodeError):
        return {}, {}
    if not isinstance(data, dict):
        return {}, {}
    return data.get("fields") or {}, data.get("evidence") or data.get("provenance") or {}


def _artwork_metadata(occurrence: AdOccurrence | None) -> dict[str, Any]:
    if occurrence is None:
        return {}
    try:
        return json.loads(occurrence.artwork_metadata_json or "{}")
    except (TypeError, json.JSONDecodeError):
        return {}


def _bbox(value: str) -> Any:
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return value


def _image_available(storage, path: str | None) -> bool:
    if not path:
        return False
    return storage.exists(path)


def _payload(item, occurrence, page, document, company, storage) -> dict[str, Any]:
    manifest = _manifest(occurrence)
    artwork_metadata = _artwork_metadata(occurrence)
    extracted_values, evidence = _contact_data(occurrence)
    return {
        "id": item.id,
        "reason": item.reason,
        "status": item.status,
        "reviewed_at": item.reviewed_at.isoformat() if item.reviewed_at else None,
        "document_id": document.id if document else None,
        "ad_id": occurrence.id if occurrence else None,
        "page": page.page_number if page else None,
        "company": {
            "id": company.id if company else None,
            "name": company.name if company else None,
            "extracted_values": extracted_values,
            "evidence": evidence,
        },
        "bbox": _bbox(occurrence.bbox) if occurrence else None,
        "restoration": {
            "review_status": manifest.get("review_status"),
            "geometry_quality_status": (
                manifest.get("geometry_quality") or {}
            ).get("status"),
            "model_name": (
                manifest.get("model_name")
                or manifest.get("model")
                or artwork_metadata.get("model_name")
            ),
            "plan_digest": (
                manifest.get("plan_digest") or artwork_metadata.get("plan_digest")
            ),
        },
        "images": {
            "original_available": _image_available(
                storage, occurrence.artwork_path if occurrence else None
            ),
            "restored_available": _image_available(
                storage, occurrence.restoration_path if occurrence else None
            ),
        },
        "created_at": (
            document.created_at.isoformat()
            if document and isinstance(document.created_at, datetime)
            else document.created_at if document else None
        ),
    }


def _row(session, item_id: int):
    row = session.execute(_item_query().where(ReviewItem.id == item_id)).first()
    if not row:
        raise HTTPException(404, "review item not found")
    return row


@router.get("/open", dependencies=[Depends(require_compat_auth)])
def open_reviews(
    session=Depends(session_dependency),
    storage=Depends(storage_dependency),
):
    rows = session.execute(
        _item_query()
        .where(ReviewItem.status == "pending")
        .order_by(ReviewItem.id)
    ).all()
    return [_payload(*row, storage) for row in rows]


@router.get("/{item_id}", dependencies=[Depends(require_compat_auth)])
def review_detail(
    item_id: int,
    session=Depends(session_dependency),
    storage=Depends(storage_dependency),
):
    return _payload(*_row(session, item_id), storage)


def _image_response(item_id: int, kind: str, session, storage):
    item, occurrence, *_ = _row(session, item_id)
    if occurrence is None:
        raise HTTPException(404, f"{kind} image not available")
    path = occurrence.artwork_path if kind == "original" else occurrence.restoration_path
    if not path:
        raise HTTPException(404, f"{kind} image not available")
    try:
        content = storage.get(path)
    except (FileNotFoundError, ClientError) as exc:
        raise HTTPException(404, f"{kind} image not available") from exc
    return Response(content=content, media_type="image/png")


@router.get("/{item_id}/original", dependencies=[Depends(require_compat_auth)])
def original_image(
    item_id: int,
    session=Depends(session_dependency),
    storage=Depends(storage_dependency),
):
    return _image_response(item_id, "original", session, storage)


@router.get("/{item_id}/restored", dependencies=[Depends(require_compat_auth)])
def restored_image(
    item_id: int,
    session=Depends(session_dependency),
    storage=Depends(storage_dependency),
):
    return _image_response(item_id, "restored", session, storage)


@router.post("/{item_id}/decision", dependencies=[Depends(require_compat_auth)])
def decide_review(
    item_id: int,
    payload: ReviewDecision,
    session=Depends(session_dependency),
):
    item = apply_review_decision(session, item_id, payload.decision, payload.note)
    session.commit()
    next_item = session.scalar(
        select(ReviewItem.id)
        .where(
            ReviewItem.status == "pending",
            ReviewItem.id != item.id,
        )
        .order_by(ReviewItem.id)
    )
    return {
        "id": item.id,
        "status": item.status,
        "note": item.review_note,
        "next_open_id": next_item,
    }
