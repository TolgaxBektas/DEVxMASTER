from datetime import datetime
from typing import Any

from sqlalchemy import select

from app.models import Company, DeferredChannel
from app.services.companies import XDATA_GERMANY, XDATA_NB_HIGH_QUALITY


def _entries(value: Any) -> list[tuple[str, str | None, datetime | None]]:
    values = value if isinstance(value, list) else [value]
    result = []
    for item in values:
        if isinstance(item, dict):
            channel_value = item.get("value")
            source_url = item.get("source_url") or item.get("source")
            retrieved_at = item.get("retrieved_at")
        else:
            channel_value = item
            source_url = None
            retrieved_at = None
        if channel_value in (None, ""):
            continue
        parsed_at = None
        if isinstance(retrieved_at, str):
            try:
                parsed_at = datetime.fromisoformat(retrieved_at.replace("Z", "+00:00"))
            except ValueError:
                parsed_at = None
        result.append((str(channel_value), source_url, parsed_at))
    return result


def extract_deferred_channels(evidence: dict[str, Any]) -> list[dict[str, Any]]:
    channels = []
    for key, field_name in (("faxes", "fax"), ("fax", "fax")):
        raw = evidence.get(key)
        if raw in (None, [], ""):
            continue
        for value, source_url, retrieved_at in _entries(raw):
            channels.append(
                {
                    "field_name": field_name,
                    "value": value,
                    "source_url": source_url,
                    "retrieved_at": retrieved_at,
                }
            )
    social = evidence.get("social_profiles")
    if social not in (None, [], ""):
        values = social if isinstance(social, list) else [social]
        for item in values:
            platform = item.get("platform") if isinstance(item, dict) else None
            field_name = platform.lower() if platform in {"facebook", "instagram"} else "social_profiles"
            for value, source_url, retrieved_at in _entries(item):
                channels.append(
                    {
                        "field_name": field_name,
                        "value": value,
                        "source_url": source_url,
                        "retrieved_at": retrieved_at,
                    }
                )
    for key in ("facebook", "instagram"):
        for value, source_url, retrieved_at in _entries(evidence.get(key)):
            channels.append(
                {
                    "field_name": key,
                    "value": value,
                    "source_url": source_url,
                    "retrieved_at": retrieved_at,
                }
            )
    return channels


def record_deferred_channels(
    session,
    company: Company,
    evidence: dict[str, Any],
    data_source: str,
) -> None:
    for entry in extract_deferred_channels(evidence):
        existing = session.scalar(
            select(DeferredChannel).where(
                DeferredChannel.company_id == company.id,
                DeferredChannel.field_name == entry["field_name"],
                DeferredChannel.value == entry["value"],
            )
        )
        if existing is None:
            session.add(
                DeferredChannel(
                    company_id=company.id,
                    data_source=data_source,
                    status="waiting_for_x_core",
                    **entry,
                )
            )
            continue
        if (
            data_source == XDATA_NB_HIGH_QUALITY
            and existing.data_source == XDATA_GERMANY
        ):
            existing.data_source = data_source
        can_write = (
            data_source == existing.data_source
            or data_source == XDATA_NB_HIGH_QUALITY
            and existing.data_source == XDATA_GERMANY
        )
        if can_write:
            if entry["source_url"]:
                existing.source_url = entry["source_url"]
            if entry["retrieved_at"]:
                existing.retrieved_at = entry["retrieved_at"]
