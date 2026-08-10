import json
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

import pypdfium2 as pdfium

from app.schemas.pipeline import AdFields
from app.services.extraction import normalize_address, normalize_domain, normalize_phone


# Aliases are data so new publisher spellings can be added without changing
# extraction logic.
LABEL_VOCABULARY = {
    "company": ("firma",),
    "street": ("strasse", "straße", "strasse hausnr", "straße-hausnr"),
    "postal_city": ("plz/ort", "plz ort", "plz-ort"),
    "contact_person": ("asp", "asp.", "ansprechpartner"),
    "phone": ("tel", "tel.", "telefon"),
    "fax": ("fax",),
    "email": ("e-mail", "e-mail:", "email"),
    "date": ("datum",),
    "process": ("vorgang",),
    "advisor": ("berater",),
    "employee": ("mitarbeiter",),
}

FORM_MARKERS = (
    "bürgerinfo-broschüre",
    "buergerinfo-broschuere",
    "publikationsvorschlag",
    "kundendaten",
    "anzeigenauftrag",
    "auftraggeber",
    "annahmeformular",
)
STRONG_FORM_MARKERS = frozenset(FORM_MARKERS)
EXCLUDED_CONTEXT = (
    "antwort",
    "per e-mail an",
    "rücksendung an",
    "auftragnehmer",
)

# Defence in depth only. Region and label context remain the primary filter.
PUBLISHER_BLOCKLIST = {
    "emails": {
        "info@pr-media.org",
        "info@concept-media.org",
        "druckabteilungmedien@gmail.com",
    },
    "domains": {"pr-media.org", "concept-media.org", "mediendruckltd.com"},
    "companies": {
        "pr mediahouse",
        "conceptmedia studio",
        "conceptmedia studio llc",
        "medien druck ltd",
        "mediendruck ltd",
    },
}


@dataclass(frozen=True)
class _Character:
    value: str
    left: float
    right: float
    top: float
    bottom: float
    index: int


@dataclass
class FormParseResult:
    is_order_form: bool
    fields: dict[str, str] = field(default_factory=dict)
    labels: set[str] = field(default_factory=set)
    metadata: dict[str, str] = field(default_factory=dict)
    conflicts: dict[str, dict[str, str]] = field(default_factory=dict)

    @property
    def complete(self) -> bool:
        contact = any(self.fields.get(key) for key in ("phone", "fax", "email"))
        return bool(
            self.fields.get("company")
            and self.fields.get("address")
            and contact
        )

    def as_json(self) -> str:
        return json.dumps(
            {
                "fields": self.fields,
                "metadata": self.metadata,
                "labels": sorted(self.labels),
                "complete": self.complete,
            },
            ensure_ascii=False,
        )


def _normalized(value: str) -> str:
    value = unicodedata.normalize("NFKD", value).casefold()
    return re.sub(r"[^a-z0-9]+", "", value)


def _display_clean(value: str) -> str:
    value = re.sub(r"^[\s:;|,.\-]+|[\s:;|,.\-]+$", "", value)
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def _blocked(value: str, field_name: str) -> bool:
    folded = _normalized(value)
    if field_name == "email" and value.casefold() in PUBLISHER_BLOCKLIST["emails"]:
        return True
    if any(domain in value.casefold() for domain in PUBLISHER_BLOCKLIST["domains"]):
        return True
    return any(company.replace(" ", "") in folded for company in PUBLISHER_BLOCKLIST["companies"])


def _page_characters(page) -> list[_Character]:
    text_page = page.get_textpage()
    text = text_page.get_text_range()
    characters = []
    for index in range(min(text_page.count_chars(), len(text))):
        if text[index] in "\r\n":
            continue
        left, bottom, right, top = text_page.get_charbox(index)
        characters.append(
            _Character(
                text[index],
                left,
                right,
                page.get_size()[1] - top,
                page.get_size()[1] - bottom,
                index,
            )
        )
    return characters


def _rows(characters: list[_Character]) -> list[list[_Character]]:
    rows: list[list[_Character]] = []
    for character in sorted(
        characters, key=lambda item: ((item.top + item.bottom) / 2, item.left)
    ):
        center = (character.top + character.bottom) / 2
        row = next(
            (
                row
                for row in rows
                if abs((row[0].top + row[0].bottom) / 2 - center) <= 4
            ),
            None,
        )
        if row is None:
            rows.append([character])
        else:
            row.append(character)
    for row in rows:
        row.sort(key=lambda item: item.left)
    return sorted(rows, key=lambda row: (row[0].top + row[0].bottom) / 2)


def _aliases() -> list[tuple[str, str]]:
    return [
        (alias, canonical)
        for canonical, aliases in LABEL_VOCABULARY.items()
        for alias in aliases
    ]


_ALIAS_INDEX = tuple(
    sorted(_aliases(), key=lambda item: len(_normalized(item[0])), reverse=True)
)


def _extract_row_value(row: list[_Character], canonical: str) -> str | None:
    normalized_chars = "".join(_normalized(character.value) for character in row)
    for alias, alias_canonical in _ALIAS_INDEX:
        if alias_canonical != canonical:
            continue
        needle = _normalized(alias)
        start = normalized_chars.find(needle)
        if start < 0:
            continue
        # Map normalized character positions back to row characters.
        positions = []
        for row_index, character in enumerate(row):
            positions.extend([row_index] * len(_normalized(character.value)))
        if start >= len(positions):
            continue
        end = min(len(positions) - 1, start + len(needle) - 1)
        label_right = row[positions[end]].right
        value = "".join(
            character.value
            for character in row
            if character.left >= label_right
        )
        value = _display_clean(value)
        value = re.sub(
            rf"^(?:{'|'.join(re.escape(item[0]) for item in _ALIAS_INDEX if item[1] == canonical)})"
            r"\s*[:;|,\-]?\s*",
            "",
            value,
            flags=re.IGNORECASE,
        )
        if value and not _blocked(value, canonical):
            return value
    return None


def _looks_like_marker(text: str) -> bool:
    normalized = _normalized(text)
    return any(_normalized(marker) in normalized for marker in FORM_MARKERS)


def _parse_order_form_page(page) -> FormParseResult:
    characters = _page_characters(page)
    page_text = "".join(character.value for character in characters)
    rows = _rows(characters)
    fields: dict[str, str] = {}
    metadata: dict[str, str] = {}
    labels: set[str] = set()
    for row in rows:
        row_text = "".join(character.value for character in row)
        context = row_text.casefold()
        if any(token in context for token in EXCLUDED_CONTEXT):
            continue
        for canonical, _ in LABEL_VOCABULARY.items():
            value = _extract_row_value(row, canonical)
            if value:
                labels.add(canonical)
                if canonical in {"date", "process", "advisor", "employee"}:
                    metadata[
                        {
                            "date": "datum",
                            "process": "vorgang",
                            "advisor": "berater",
                            "employee": "mitarbeiter",
                        }[canonical]
                    ] = value
                elif canonical not in fields:
                    fields[canonical] = value
    postal_city = fields.pop("postal_city", "")
    postal_match = re.match(r"^(\d{5})\s+(.+)$", postal_city)
    if postal_match:
        fields["postal_code"], fields["city"] = postal_match.groups()
    elif postal_city:
        fields["city"] = postal_city
    address_parts = [
        fields.get("street"),
        " ".join(
            value for value in (fields.get("postal_code"), fields.get("city")) if value
        ),
    ]
    if any(address_parts):
        fields["address"] = ", ".join(part for part in address_parts if part)
    matched_markers = {
        marker
        for marker in FORM_MARKERS
        if _normalized(marker) in _normalized(page_text)
    }
    # Strong publisher boilerplate is enough to flag a form-looking page even
    # when its customer header is missing; ordinary markers need two labels.
    is_order_form = bool(matched_markers) and (
        len(labels) >= 2
        or any(marker in STRONG_FORM_MARKERS for marker in matched_markers)
    )
    return FormParseResult(
        is_order_form=is_order_form,
        fields=fields,
        labels=labels,
        metadata=metadata,
    )


def parse_order_forms(pdf_path: str | Path) -> dict[int, FormParseResult]:
    pdf = pdfium.PdfDocument(str(pdf_path))
    return {
        page_number: _parse_order_form_page(pdf[page_number - 1])
        for page_number in range(1, len(pdf) + 1)
    }


def parse_order_form(pdf_path: str | Path, page_number: int) -> FormParseResult:
    return parse_order_forms(pdf_path)[page_number]


def merge_form_and_ad_fields(
    header: dict[str, str], advert: dict[str, str]
) -> tuple[dict[str, str], dict[str, dict[str, str]]]:
    def comparable(key: str, value: str) -> str:
        if key == "phone" or key == "fax":
            return normalize_phone(value)
        if key == "domain":
            return normalize_domain(value)
        if key == "email":
            return value.strip().casefold()
        if key == "address":
            return re.sub(r"[\s,]+", " ", normalize_address(value)).casefold()
        return re.sub(r"\s+", " ", value).strip().casefold()

    merged = dict(advert)
    conflicts: dict[str, dict[str, str]] = {}
    for key, value in header.items():
        if not value:
            continue
        if advert.get(key) and comparable(key, advert[key]) != comparable(key, value):
            conflicts[key] = {"header": value, "advert": advert[key]}
        merged[key] = value
    return merged, conflicts


def fields_model(fields: dict[str, str]) -> AdFields:
    return AdFields.model_validate(fields)
