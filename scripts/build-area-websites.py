#!/usr/bin/env python3
"""Build the committed German municipal website register from supplied results."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_KREIS_FILE = Path("/home/ubuntu/discovery-queries/kreis-websites.json")
DEFAULT_GEMEINDE_FILE = Path("/home/ubuntu/discovery-queries/gemeinde-websites.json")
OUTPUT_FILE = ROOT / "modules/ingestion/src/data/websites.de.json"


def binding_value(binding: dict, key: str) -> str:
    try:
        return str(binding[key]["value"]).strip()
    except (KeyError, TypeError):
        raise ValueError(f"Missing {key} in SPARQL binding") from None


def load_bindings(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    try:
        return payload["results"]["bindings"]
    except (KeyError, TypeError):
        raise ValueError(f"Expected SPARQL JSON results in {path}") from None


def normalize_url(value: str) -> str:
    parsed = urlsplit(value.strip())
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise ValueError(f"Unsupported website URL: {value}")
    hostname = parsed.hostname.lower()
    netloc = hostname
    if parsed.port is not None:
        netloc += f":{parsed.port}"
    path = parsed.path or "/"
    if path != "/":
        path = path.rstrip("/")
    return urlunsplit((parsed.scheme.lower(), netloc, path, parsed.query, ""))


def source_date(*paths: Path) -> str:
    timestamp = max(path.stat().st_mtime for path in paths)
    return datetime.fromtimestamp(timestamp, timezone.utc).date().isoformat()


def build(kreis_file: Path, gemeinde_file: Path) -> dict:
    rows: dict[tuple[str, str, str], dict] = {}
    for binding in load_bindings(kreis_file):
        ags = binding_value(binding, "kreisKey")
        if len(ags) != 5 or not ags.isdigit():
            raise ValueError(f"Expected five-digit Kreis-AGS, got {ags!r}")
        url = normalize_url(binding_value(binding, "website"))
        key = ("kreis", ags, url)
        rows[key] = {"ags": ags, "level": "kreis", "name": binding_value(binding, "itemLabel"), "url": url}
    for binding in load_bindings(gemeinde_file):
        gemeinde_ags = binding_value(binding, "ags")
        if len(gemeinde_ags) < 5 or not gemeinde_ags[:5].isdigit():
            raise ValueError(f"Expected eight-digit Gemeinde-AGS, got {gemeinde_ags!r}")
        ags = gemeinde_ags[:5]
        url = normalize_url(binding_value(binding, "website"))
        key = ("gemeinde", ags, url)
        rows[key] = {"ags": ags, "level": "gemeinde", "name": binding_value(binding, "itemLabel"), "url": url}

    websites = sorted(
        rows.values(),
        key=lambda row: (row["ags"], row["level"], row["name"].casefold(), row["url"]),
    )
    queried_at = source_date(kreis_file, gemeinde_file)
    return {
        "metadata": {
            "source": [
                "discovery-queries/kreis-websites.json",
                "discovery-queries/gemeinde-websites.json",
            ],
            "queryFiles": [
                "discovery-queries/kreis-websites.sparql",
                "discovery-queries/gemeinde-websites.sparql",
            ],
            "queriedAt": queried_at,
            "generatedAt": queried_at,
        },
        "websites": websites,
    }


def main(argv: list[str]) -> int:
    kreis_file = Path(argv[1]) if len(argv) > 1 else DEFAULT_KREIS_FILE
    gemeinde_file = Path(argv[2]) if len(argv) > 2 else DEFAULT_GEMEINDE_FILE
    result = build(kreis_file, gemeinde_file)
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(result['websites'])} website records to {OUTPUT_FILE}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
