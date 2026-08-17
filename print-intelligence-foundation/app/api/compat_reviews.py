import json
from datetime import datetime
from typing import Any

from botocore.exceptions import ClientError
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import or_, select

from app.api.auth import require_compat_auth
from app.api.dependencies import session_dependency, storage_dependency
from app.api.reviews import apply_review_decision
from app.models import AdOccurrence, Company, Document, Page, ReviewItem
from app.services.companies import XDATA_GERMANY, XDATA_NB_HIGH_QUALITY


router = APIRouter(prefix="/api/v1/reviews", tags=["compatibility-review"])


class ReviewDecision(BaseModel):
    decision: str
    note: str | None = None


def _data_source(
    occurrence: AdOccurrence | None,
    document: Document | None,
    company: Company | None,
) -> str:
    if occurrence and occurrence.data_source:
        return occurrence.data_source
    if document and (
        (document.filename or "").startswith("print-batch-")
        or (document.content_sha256 or "").startswith("print-batch-")
    ):
        return XDATA_NB_HIGH_QUALITY
    return XDATA_GERMANY


def _source_clause(data_source: str):
    fallback_print_batch = (
        (Document.filename.like("print-batch-%"))
        | (Document.content_sha256.like("print-batch-%"))
    )
    fallback_source = (
        XDATA_NB_HIGH_QUALITY
        if data_source == XDATA_NB_HIGH_QUALITY
        else XDATA_GERMANY
    )
    if fallback_source == XDATA_NB_HIGH_QUALITY:
        return or_(
            AdOccurrence.data_source == data_source,
            (AdOccurrence.id.is_(None) & fallback_print_batch),
        )
    return or_(
        AdOccurrence.data_source == data_source,
        (AdOccurrence.id.is_(None) & ~fallback_print_batch),
    )


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


def _evidence_entry(value: Any) -> dict[str, str] | None:
    if isinstance(value, str) and value:
        return {"source_url": value}
    if not isinstance(value, dict):
        return None
    source_url = value.get("source_url") or value.get("source")
    entry = {
        "source_url": source_url,
        "retrieved_at": value.get("retrieved_at"),
    }
    entry = {
        key: item for key, item in entry.items() if isinstance(item, str) and item
    }
    return entry or None


def _evidence_value(values: list[Any]) -> Any:
    entries = [entry for value in values if (entry := _evidence_entry(value))]
    if not entries:
        return None
    if all(entry == entries[0] for entry in entries[1:]):
        return entries[0]
    return entries


def _import_contact_data(data: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    raw = data.get("evidence")
    if not isinstance(raw, dict):
        return {}, {}, {}
    extracted: dict[str, Any] = {}
    evidence: dict[str, Any] = {}
    mapping = {
        "website_domain": "website",
        "emails": "emails",
        "phones": "phones",
        "faxes": "faxes",
        "social_profiles": "social_profiles",
        "street": "street",
        "postal_code": "postal_code",
        "city": "city",
    }
    company = data.get("company")
    if company:
        extracted["company"] = company
    for source_key, target_key in mapping.items():
        raw_value = raw.get(source_key)
        if raw_value is None or raw_value == []:
            continue
        values = raw_value if isinstance(raw_value, list) else [raw_value]
        clean_values = []
        evidence_values = []
        for value in values:
            if isinstance(value, dict):
                normalized = value.get("value")
                if normalized in (None, ""):
                    continue
                clean_values.append(normalized)
                evidence_values.append(value)
            elif value not in (None, ""):
                clean_values.append(value)
        if not clean_values:
            continue
        extracted[target_key] = (
            clean_values if isinstance(raw_value, list) else clean_values[0]
        )
        if evidence_value := _evidence_value(evidence_values):
            evidence[target_key] = evidence_value
    verification = {
        key: raw[key]
        for key in ("verified", "reason", "sources")
        if key in raw
    }
    return extracted, evidence, verification


def _contact_data(
    occurrence: AdOccurrence | None,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    if occurrence is None:
        return {}, {}, {}
    try:
        data = json.loads(occurrence.fields_json or "{}")
    except (TypeError, json.JSONDecodeError):
        return {}, {}, {}
    if not isinstance(data, dict):
        return {}, {}, {}
    if isinstance(data.get("fields"), dict):
        fields = {
            key: value
            for key, value in data["fields"].items()
            if value not in (None, "", [])
        }
        provenance = data.get("provenance")
        field_evidence = {}
        if isinstance(provenance, dict):
            for key, value in provenance.items():
                if key in fields and (entry := _evidence_entry(value)):
                    field_evidence[key] = entry
        return fields, field_evidence, {}
    return _import_contact_data(data)


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
    extracted_values, evidence, verification = _contact_data(occurrence)
    return {
        "id": item.id,
        "reason": item.reason,
        "status": item.status,
        "reviewed_at": item.reviewed_at.isoformat() if item.reviewed_at else None,
        "data_source": _data_source(occurrence, document, company),
        "document_id": document.id if document else None,
        "ad_id": occurrence.id if occurrence else None,
        "page": page.page_number if page else None,
        "company": {
            "id": company.id if company else None,
            "name": company.name if company else None,
            "extracted_values": extracted_values,
            "evidence": evidence,
            "verification": verification,
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
            "content_comparison": manifest.get("content_comparison"),
            "content_anchors": manifest.get("content_anchors"),
            "visual_comparison": manifest.get("visual_comparison"),
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
    data_source: str | None = Query(None),
):
    if data_source not in {None, XDATA_NB_HIGH_QUALITY, XDATA_GERMANY}:
        raise HTTPException(422, "invalid data source")
    query = (
        _item_query()
        .where(ReviewItem.status == "pending")
        .order_by(ReviewItem.id)
    )
    if data_source is not None:
        query = query.where(_source_clause(data_source))
    rows = session.execute(query).all()
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
    if payload.decision not in {"approve", "reject"}:
        raise HTTPException(400, "decision must be approve or reject")
    current_row = _row(session, item_id)
    current_source = _data_source(current_row[1], current_row[3], current_row[4])
    item = apply_review_decision(session, item_id, payload.decision, payload.note)
    session.commit()
    next_query = (
        _item_query()
        .where(ReviewItem.status == "pending", ReviewItem.id != item.id)
        .where(_source_clause(current_source))
        .order_by(ReviewItem.id)
    )
    next_row = session.execute(next_query).first()
    next_item = next_row[0].id if next_row else None
    return {
        "id": item.id,
        "status": item.status,
        "note": item.review_note,
        "next_open_id": next_item,
    }
