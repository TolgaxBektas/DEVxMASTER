import re
from app.schemas.pipeline import AdFields

EMAIL = re.compile(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}")
PHONE = re.compile(r"(?:\+49|0049|0)\s*(?:\(?\d{2,5}\)?[\s./-]*)\d[\d\s./-]{4,}")
DOMAIN = re.compile(
    r"\b(?:https?://)?(?:www\.)?[a-z0-9-]+\.(?:de|com|org|net|eu)\b", re.I
)
STREET_ADDRESS = re.compile(
    r"(?P<street>[\wÄÖÜäöüß.-]+(?:straße|str\.|gasse|weg|platz|allee|ring)\s+\d+[^\n]*?\b\d{5}\s+[A-Za-zÄÖÜäöüß-]+)",
    re.I,
)
STREET_LINE = re.compile(
    r"^[\wÄÖÜäöüß.-]+(?:straße|str\.|gasse|weg|platz|allee|ring)\s+\d+",
    re.I,
)


def normalize_phone(value: str) -> str:
    digits = re.sub(r"\D", "", value)
    if value.strip().startswith("+49"):
        return "+49" + digits[2:]
    if value.strip().startswith("0049"):
        return "+49" + digits[4:]
    return digits


def normalize_domain(value: str) -> str:
    return re.sub(r"^https?://", "", value.strip(), flags=re.I).rstrip("/").lower()


def normalize_address(value: str) -> str:
    value = re.sub(r"\s*[•·]\s*", ", ", value)
    value = re.sub(r"\s+", " ", value).strip(" ,")
    match = STREET_ADDRESS.search(value)
    return match.group("street").strip(" ,") if match else value


def extract_contact_fields(text: str, company: str | None = None) -> AdFields:
    email = EMAIL.search(text)
    phone = PHONE.search(text)
    domain_matches = DOMAIN.findall(EMAIL.sub("", text))
    domain = normalize_domain(domain_matches[-1]) if domain_matches else None
    lines = [x.strip() for x in text.splitlines() if x.strip()]
    address = None
    for index, line in enumerate(lines):
        if (
            re.search(r"\b\d{5}\b", line)
            and not PHONE.search(line)
            and re.search(r"[A-Za-zÄÖÜäöüß]", line)
        ):
            if index and STREET_LINE.match(lines[index - 1]):
                address = f"{lines[index - 1]} {line}"
            else:
                address = line
            break
    if address:
        address = normalize_address(address)
    raw_phone = phone.group(0).strip() if phone else None
    return AdFields(
        company=company,
        email=email.group(0) if email else None,
        phone=normalize_phone(raw_phone) if raw_phone else None,
        raw_phone=raw_phone,
        domain=domain if domain else None,
        address=address,
    )
