"""repair company normalization and merge safe hard-feature duplicates."""

import json
from datetime import datetime, timezone

from alembic import op
import sqlalchemy as sa

from app.services.companies import (
    XDATA_NB_HIGH_QUALITY,
    _contact_values,
)
from app.services.dedupe import normalize_name


revision = "0010_repair_company_normalization"
down_revision = "0009_deferred_channels"
branch_labels = None
depends_on = None


def _json_object(value):
    try:
        parsed = json.loads(value or "{}")
    except (TypeError, json.JSONDecodeError):
        parsed = {}
    return parsed if isinstance(parsed, dict) else {}


def _json_list(value):
    try:
        parsed = json.loads(value or "[]")
    except (TypeError, json.JSONDecodeError):
        parsed = []
    return parsed if isinstance(parsed, list) else []


def _company_features(row):
    fields = _json_object(row["canonical_fields_json"])
    _key, domains, phones, emails = _contact_values(fields)
    return fields, domains, phones, emails


def _source_rank(source):
    return 1 if source == XDATA_NB_HIGH_QUALITY else 0


def _components(rows):
    remaining = {row["id"]: row for row in rows}
    components = []
    while remaining:
        first_id = min(remaining)
        component = {first_id}
        pending = [first_id]
        while pending:
            current = remaining[pending.pop()]
            for other_id, other in remaining.items():
                if other_id in component:
                    continue
                if (
                    current["domains"] & other["domains"]
                    or current["phones"] & other["phones"]
                    or current["emails"] & other["emails"]
                ):
                    component.add(other_id)
                    pending.append(other_id)
        components.append([remaining.pop(company_id) for company_id in component])
    return components


def _merge_deferred_channels(connection, winner_id, loser_id):
    loser_channels = connection.execute(
        sa.text(
            "SELECT id, field_name, value, source_url, retrieved_at, "
            "data_source, status FROM deferred_channels "
            "WHERE company_id = :company_id ORDER BY id"
        ),
        {"company_id": loser_id},
    ).mappings()
    for loser in loser_channels:
        winner = connection.execute(
            sa.text(
                "SELECT id, source_url, retrieved_at, data_source, status "
                "FROM deferred_channels "
                "WHERE company_id = :company_id "
                "AND field_name = :field_name AND value = :value"
            ),
            {
                "company_id": winner_id,
                "field_name": loser["field_name"],
                "value": loser["value"],
            },
        ).mappings().first()
        if winner is None:
            connection.execute(
                sa.text(
                    "UPDATE deferred_channels SET company_id = :winner_id "
                    "WHERE id = :channel_id"
                ),
                {"winner_id": winner_id, "channel_id": loser["id"]},
            )
            continue

        winner_is_hq = winner["data_source"] == XDATA_NB_HIGH_QUALITY
        loser_is_hq = loser["data_source"] == XDATA_NB_HIGH_QUALITY
        updates = {}
        if loser_is_hq and not winner_is_hq:
            updates.update(
                data_source=loser["data_source"],
                source_url=loser["source_url"] or winner["source_url"],
                retrieved_at=loser["retrieved_at"] or winner["retrieved_at"],
            )
        else:
            if not winner["source_url"] and loser["source_url"]:
                updates["source_url"] = loser["source_url"]
            if not winner["retrieved_at"] and loser["retrieved_at"]:
                updates["retrieved_at"] = loser["retrieved_at"]
        if winner["status"] != "waiting_for_x_core" and loser["status"] == "waiting_for_x_core":
            updates["status"] = "waiting_for_x_core"
        if updates:
            assignments = ", ".join(f"{key} = :{key}" for key in updates)
            updates["channel_id"] = winner["id"]
            connection.execute(
                sa.text(
                    f"UPDATE deferred_channels SET {assignments} "
                    "WHERE id = :channel_id"
                ),
                updates,
            )
        connection.execute(
            sa.text("DELETE FROM deferred_channels WHERE id = :channel_id"),
            {"channel_id": loser["id"]},
        )


def _merge_company(connection, winner, loser):
    loser_fields = _json_object(loser["canonical_fields_json"])
    findings = _json_list(winner["secondary_findings_json"])
    findings.extend(_json_list(loser["secondary_findings_json"]))
    findings.append(
        {
            "source": loser["data_source"],
            "fields": loser_fields,
            "recorded_at": datetime.now(timezone.utc).isoformat(),
        }
    )
    connection.execute(
        sa.text(
            "UPDATE companies SET secondary_findings_json = :findings "
            "WHERE id = :company_id"
        ),
        {
            "findings": json.dumps(findings, ensure_ascii=False),
            "company_id": winner["id"],
        },
    )
    connection.execute(
        sa.text(
            "UPDATE ad_occurrences SET company_id = :winner_id "
            "WHERE company_id = :loser_id"
        ),
        {"winner_id": winner["id"], "loser_id": loser["id"]},
    )
    _merge_deferred_channels(connection, winner["id"], loser["id"])
    connection.execute(
        sa.text("DELETE FROM companies WHERE id = :company_id"),
        {"company_id": loser["id"]},
    )


def upgrade():
    connection = op.get_bind()
    raw_rows = list(
        connection.execute(
            sa.text(
                "SELECT id, name, normalized_name, data_source, "
                "canonical_fields_json, secondary_findings_json "
                "FROM companies ORDER BY id"
            )
        ).mappings()
    )
    rows = []
    for raw in raw_rows:
        fields, domains, phones, emails = _company_features(raw)
        rows.append(
            {
                **dict(raw),
                "new_normalized_name": normalize_name(raw["name"]),
                "fields": fields,
                "domains": domains,
                "phones": phones,
                "emails": emails,
            }
        )

    grouped = {}
    for row in rows:
        if row["new_normalized_name"]:
            grouped.setdefault(row["new_normalized_name"], []).append(row)

    merged_ids = set()
    for group in grouped.values():
        for component in _components(group):
            if len(component) < 2:
                continue
            winner = min(
                component,
                key=lambda row: (
                    -_source_rank(row["data_source"]),
                    -bool(row["fields"]),
                    row["id"],
                ),
            )
            for loser in sorted(component, key=lambda row: row["id"]):
                if loser["id"] == winner["id"]:
                    continue
                _merge_company(connection, winner, loser)
                merged_ids.add(loser["id"])

    for row in rows:
        if row["id"] in merged_ids:
            continue
        connection.execute(
            sa.text(
                "UPDATE companies SET normalized_name = :normalized_name "
                "WHERE id = :company_id"
            ),
            {
                "normalized_name": row["new_normalized_name"],
                "company_id": row["id"],
            },
        )


def downgrade():
    raise NotImplementedError("company normalization repair is not reversible")
