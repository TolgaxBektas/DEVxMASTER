from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from app.api.auth import require_auth
from sqlalchemy import select
from app.api.dependencies import session_dependency
from app.models import ReviewItem

router = APIRouter(
    prefix="/review-queue", tags=["review"], dependencies=[Depends(require_auth)]
)


@router.get("")
def queue(session=Depends(session_dependency)):
    return [
        {
            "id": x.id,
            "ad_id": x.ad_id,
            "page_id": x.page_id,
            "status": x.status,
            "reason": x.reason,
        }
        for x in session.scalars(
            select(ReviewItem).where(ReviewItem.status == "pending")
        )
    ]


@router.post("/{item_id}/{decision}")
def review(item_id: int, decision: str, session=Depends(session_dependency)):
    if decision not in {"approve", "reject"}:
        raise HTTPException(400, "decision must be approve or reject")
    item = session.get(ReviewItem, item_id)
    if not item:
        raise HTTPException(404)
    item.status = "approved" if decision == "approve" else "rejected"
    item.reviewed_at = datetime.now(timezone.utc)
    session.commit()
    return {"id": item.id, "status": item.status}
