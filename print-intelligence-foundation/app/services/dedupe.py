import re
import unicodedata


def normalize_name(value: str) -> str:
    value = (
        unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode().lower()
    )
    return re.sub(r"[^a-z0-9]+", " ", value).strip()


def contact_key(fields: dict) -> str:
    return "|".join(
        (fields.get(k) or "").strip().lower() for k in ("phone", "email", "domain")
    )
