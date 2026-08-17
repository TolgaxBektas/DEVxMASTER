import json
import hashlib
import re
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select

from app.models import Company
from app.services.dedupe import contact_key, normalize_name

XDATA_NB_HIGH_QUALITY = "xdata_nb_high_quality"
XDATA_GERMANY = "xdata_germany"


def _digits(value: Any) -> str:
    return re.sub(r"\D", "", str(value or ""))


def _contact_values(fields: dict[str, Any]) -> tuple[str, set[str], set[str], set[str]]:
    key = contact_key(fields)
    if not key.replace("|", ""):
        key = ""
    domains: set[str] = set()
    phones: set[str] = set()
    emails: set[str] = set()

    def visit(name: str, value: Any) -> None:
        lowered = name.lower()
        if lowered in {"phone", "phones", "telephone", "tel", "mobile"}:
            if isinstance(value, list):
                for item in value:
                    visit(name, item)
            elif isinstance(value, dict):
                visit(name, value.get("value"))
            elif _digits(value):
                phones.add(_digits(value))
        if lowered in {"email", "emails", "mail"}:
            if isinstance(value, list):
                for item in value:
                    visit(name, item)
            elif isinstance(value, dict):
                visit(name, value.get("value"))
            elif value:
                emails.add(str(value).strip().lower())
        if lowered in {"domain", "website", "website_domain", "url"}:
            if isinstance(value, list):
                for item in value:
                    visit(name, item)
            elif isinstance(value, dict):
                visit(name, value.get("value"))
            elif value:
                domains.add(str(value).lower().removeprefix("www.").rstrip("/"))
        if isinstance(value, dict):
            for nested_name, nested_value in value.items():
                visit(nested_name, nested_value)

    for name, value in fields.items():
        visit(name, value)
    return key, domains, phones, emails


def _stored_values(company: Company) -> tuple[str, set[str], set[str], set[str]]:
    try:
        fields = json.loads(company.canonical_fields_json or "{}")
    except (TypeError, json.JSONDecodeError):
        fields = {}
    return _contact_values(fields if isinstance(fields, dict) else {})


def _matches(
    company: Company,
    key: str,
    domains: set[str],
    phones: set[str],
    emails: set[str],
    source: str,
) -> bool:
    stored_key, stored_domains, stored_phones, stored_emails = _stored_values(company)
    if company.data_source == source and (
        (key.startswith("weak:")) or stored_key == key
    ):
        return True
    return bool(
        (not key.startswith("weak:") and company.contact_key and key == company.contact_key)
        or domains & stored_domains
        or phones & stored_phones
        or emails & stored_emails
    )


def _append_secondary_finding(company: Company, source: str, fields: dict[str, Any]) -> None:
    try:
        findings = json.loads(company.secondary_findings_json or "[]")
    except (TypeError, json.JSONDecodeError):
        findings = []
    if not isinstance(findings, list):
        findings = []
    findings.append(
        {"source": source, "fields": fields, "recorded_at": datetime.now(timezone.utc).isoformat()}
    )
    company.secondary_findings_json = json.dumps(findings[-20:], ensure_ascii=False)


def resolve_company(
    session,
    name: str,
    fields: dict[str, Any],
    source: str,
) -> Company:
    normalized = normalize_name(name)
    key, domains, phones, _emails = _contact_values(fields)
    if not key:
        digest = hashlib.sha256(
            json.dumps(fields, ensure_ascii=False, sort_keys=True).encode()
        ).hexdigest()
        key = f"weak:{source}:{digest}"
    candidates = session.scalars(
        select(Company).where(Company.normalized_name == normalized)
    ).all()
    company = next(
        (
            candidate
            for candidate in candidates
            if _matches(candidate, key, domains, phones, _emails, source)
        ),
        None,
    )
    now = datetime.now(timezone.utc)
    if company is None:
        company = Company(
            name=name,
            normalized_name=normalized,
            contact_key=key,
            data_source=source,
            canonical_fields_json=json.dumps(fields, ensure_ascii=False),
            secondary_findings_json="[]",
            canonical_updated_at=now,
        )
        session.add(company)
        session.flush()
        return company
    if source == XDATA_GERMANY and company.data_source == XDATA_NB_HIGH_QUALITY:
        _append_secondary_finding(company, source, fields)
        return company
    company.name = name
    company.contact_key = key
    company.canonical_fields_json = json.dumps(fields, ensure_ascii=False)
    company.data_source = source
    company.canonical_updated_at = now
    return company
