#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
from time import sleep
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
AREAS_PATH = ROOT / "modules/ingestion/src/data/areas.de.json"
OUTPUT_PATH = ROOT / "modules/ingestion/src/data/localities.de.json"
REPORT_PATH = Path("/home/ubuntu/pruefung/recherche-localities-generator-report.txt")
FEDERAL_STATES = tuple(f"{number:02d}" for number in range(1, 17))
API_BASE = "https://openplzapi.org/de/FederalStates"


def fetch_page(state_code: str, page: int) -> tuple[list[dict], int | None]:
    query = urlencode({"page": page, "pageSize": 50})
    url = f"{API_BASE}/{state_code}/Localities?{query}"
    request = Request(url, headers={"User-Agent": "DEVxMASTER-LocalityDataGenerator/1.0"})
    try:
        with urlopen(request, timeout=45) as response:
            payload = json.load(response)
            total_pages = response.headers.get("x-total-pages")
    except (HTTPError, URLError, TimeoutError) as error:
        raise RuntimeError(f"OpenPLZ-Anfrage fehlgeschlagen ({state_code}, Seite {page}): {error}") from error
    if not isinstance(payload, list):
        raise RuntimeError(f"Unerwartetes OpenPLZ-Antwortformat ({state_code}, Seite {page})")
    return payload, int(total_pages) if total_pages and total_pages.isdigit() else None


def generate() -> tuple[list[dict], list[dict]]:
    entries: dict[tuple[str, str, str], dict] = {}
    for state_code in FEDERAL_STATES:
        page = 1
        total_pages: int | None = None
        while total_pages is None or page <= total_pages:
            payload, reported_pages = fetch_page(state_code, page)
            if total_pages is None:
                total_pages = reported_pages
            if not payload:
                break
            for item in payload:
                postal_code = str(item.get("postalCode", "")).strip()
                name = str(item.get("name", "")).strip()
                municipality = item.get("municipality")
                municipality_key = str(
                    municipality.get("key", "") if isinstance(municipality, dict) else ""
                ).strip()
                if not postal_code or not name or len(municipality_key) < 5:
                    raise RuntimeError(
                        f"Unvollständiger OpenPLZ-Eintrag in Bundesland {state_code}, Seite {page}"
                    )
                row = {
                    "postalCode": postal_code,
                    "name": name,
                    "municipalityKey": municipality_key,
                }
                entries[(postal_code, name, municipality_key)] = row
            if total_pages is None and len(payload) < 50:
                break
            page += 1
            sleep(0.05)

    result = [
        entries[key]
        for key in sorted(entries, key=lambda item: (item[0], item[1].casefold(), item[2]))
    ]
    areas = json.loads(AREAS_PATH.read_text(encoding="utf-8"))
    known_districts = {area["ags"] for area in areas if area["level"] == "district"}
    missing = [
        {
            **entry,
            "districtAgs": entry["municipalityKey"][:5],
        }
        for entry in result
        if entry["municipalityKey"][:5] not in known_districts
    ]
    return result, missing


def main() -> None:
    parser = argparse.ArgumentParser(description="Generiert Orts- und PLZ-Daten aus der OpenPLZ API.")
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH)
    parser.add_argument("--report", type=Path, default=REPORT_PATH)
    args = parser.parse_args()

    entries, missing = generate()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(entries, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    lines = [
        f"Localities gesamt: {len(entries)}",
        f"Einträge mit fehlendem Kreisschlüssel in areas.de.json: {len(missing)}",
        "",
        "Fehlende Kreisschlüssel:",
    ]
    lines.extend(
        f"{entry['postalCode']} | {entry['name']} | {entry['municipalityKey']} | {entry['districtAgs']}"
        for entry in missing
    )
    args.report.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"localities={len(entries)}")
    print(f"missing_district_ags={len(missing)}")
    print(f"output={args.output}")
    print(f"report={args.report}")


if __name__ == "__main__":
    main()
