from typing import Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select

from app.api.auth import require_compat_auth
from app.api.dependencies import session_dependency
from app.models import Company, DeferredChannel


router = APIRouter(
    prefix="/api/v1/deferred-channels",
    tags=["deferred-channels"],
    dependencies=[Depends(require_compat_auth)],
)


@router.get("")
def list_deferred_channels(
    status: Literal["waiting_for_x_core", "transferred_to_x_core"] | None = Query(None),
    data_source: Literal["xdata_germany", "xdata_nb_high_quality"] | None = Query(None),
    session=Depends(session_dependency),
):
    query = (
        select(DeferredChannel, Company)
        .join(Company, DeferredChannel.company_id == Company.id)
        .order_by(DeferredChannel.id)
    )
    if status is not None:
        query = query.where(DeferredChannel.status == status)
    if data_source is not None:
        query = query.where(DeferredChannel.data_source == data_source)
    return [
        {
            "id": channel.id,
            "company_id": company.id,
            "company_name": company.name,
            "field_name": channel.field_name,
            "value": channel.value,
            "source_url": channel.source_url,
            "retrieved_at": (
                channel.retrieved_at.isoformat() if channel.retrieved_at else None
            ),
            "data_source": channel.data_source,
            "recorded_at": channel.recorded_at.isoformat(),
            "status": channel.status,
        }
        for channel, company in session.execute(query).all()
    ]
