#!/usr/bin/env python3
import argparse
import json
import random
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from openpyxl import load_workbook


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = Path(
    "/home/ubuntu/attachments/c3822988-c901-40e6-918f-eda360c86c78/"
    "Judith_Winkler_Gemeinden_PLZ_9_bis_0.xlsx"
)
LOCALITIES_PATH = ROOT / "modules/ingestion/src/data/localities.de.json"
AREAS_PATH = ROOT / "modules/ingestion/src/data/areas.de.json"
OUTPUT_PATH = ROOT / "modules/ingestion/src/data/verwaltungen.de.json"
REPORT_PATH = Path("/home/ubuntu/pruefung/recherche-verwaltungen-generator-report.txt")

EXCLUDED_TYPES = {"landkreis", "kreis", "regionalverband"}
EXCLUDED_PREFIXES = (
    "hessische staatskanzlei",
    "landratsamt",
    "kreisverwaltung",
    "kreisausschuss",
    "landkreis",
    "kreis ",
    "regierung",
    "regierungspräsidium",
    "regierungsbezirk",
    "landesdirektion",
    "landesregierung",
    "staatskanzlei",
)
SCOPE_PREFIXES = (
    "Gemeindevorstand der Gemeinde ",
    "Magistrat der Stadt ",
    "Magistrat der Gemeinde ",
    "Gemeindeverwaltung ",
    "Stadtverwaltung ",
    "Große Kreisstadt ",
    "Kreisfreie Stadt ",
    "Landeshauptstadt ",
    "Gemeinde ",
    "Stadt ",
    "Markt ",
    "Flecken ",
    "EG ",
)


def clean_name(value: Any) -> str:
    return "" if value is None else " ".join(str(value).split())


def normalize_postal_code(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if text.endswith(".0") and text[:-2].isdigit():
        text = text[:-2]
    if text.isdigit():
        return text.zfill(5)
    return text


def exclusion_reason(name: str, typ: str) -> str | None:
    if not name:
        return "leerer Name"
    normalized_type = typ.casefold().strip()
    if normalized_type in EXCLUDED_TYPES:
        return f"Typ {typ.strip()}"
    folded_name = name.casefold()
    if any(folded_name.startswith(prefix) for prefix in EXCLUDED_PREFIXES):
        return "ausgeschlossener Name-Präfix"
    if not normalized_type and folded_name.endswith(("kreis", "-kreis")):
        return "Typ leer, Name endet auf Kreis"
    return None


def normalize_scope(name: str) -> str:
    value = clean_name(name)
    folded = value.casefold()
    if folded.startswith("vereinbarte verwaltungsgemeinschaft "):
        value = "Verwaltungsgemeinschaft " + value[len("Vereinbarte Verwaltungsgemeinschaft "):]
    elif folded.startswith("verwaltungsgemeinschaft der stadt "):
        value = "Verwaltungsgemeinschaft " + value[len("Verwaltungsgemeinschaft der Stadt "):]
    elif folded.startswith("verbandsgemeindeverwaltung "):
        value = "Verbandsgemeinde " + value[len("Verbandsgemeindeverwaltung "):]
    elif folded.startswith("vg "):
        value = "Verwaltungsgemeinschaft " + value[3:]
    else:
        for prefix in SCOPE_PREFIXES:
            if value.casefold().startswith(prefix.casefold()):
                value = value[len(prefix):]
                break
    value = re.sub(r",\s*(?:Stadt|Gemeinde)\s*$", "", value, flags=re.IGNORECASE)
    return clean_name(value)


def locality_aggs(localities: list[dict]) -> tuple[dict, dict]:
    exact: dict[tuple[str, str], Counter[str]] = defaultdict(Counter)
    postal: dict[str, Counter[str]] = defaultdict(Counter)
    for locality in localities:
        postal_code = normalize_postal_code(locality.get("postalCode"))
        name = clean_name(locality.get("name"))
        municipality_key = clean_name(locality.get("municipalityKey"))
        if len(municipality_key) < 5:
            continue
        ags = municipality_key[:5]
        postal[postal_code][ags] += 1
        exact[(postal_code, name)][ags] += 1
    return exact, postal


def select_ags(counts: Counter[str]) -> str | None:
    if not counts:
        return None
    return min(counts, key=lambda ags: (-counts[ags], ags))


def map_district(
    postal_code: str,
    ort: str,
    exact: dict[tuple[str, str], Counter[str]],
    postal: dict[str, Counter[str]],
) -> str | None:
    return select_ags(exact.get((postal_code, ort), Counter())) or select_ags(
        postal.get(postal_code, Counter())
    )


def generate(input_path: Path) -> tuple[list[dict], list[str]]:
    localities = json.loads(LOCALITIES_PATH.read_text(encoding="utf-8"))
    areas = json.loads(AREAS_PATH.read_text(encoding="utf-8"))
    area_by_ags = {
        area["ags"]: area
        for area in areas
        if area["level"] == "district"
    }
    exact_aggs, postal_aggs = locality_aggs(localities)
    workbook = load_workbook(input_path, read_only=True, data_only=True)
    worksheet = workbook["Tabelle1"]
    headers = next(worksheet.iter_rows(min_row=1, max_row=1, values_only=True))
    required = ("Bundesland", "Kreis", "Verwaltung", "Postleitzahl", "Ort")
    positions = {name: headers.index(name) for name in required}
    candidates: list[dict] = []
    exclusions: Counter[str] = Counter()
    excluded_names: dict[str, Counter[str]] = defaultdict(Counter)
    source_name_counts: Counter[str] = Counter()
    for row in worksheet.iter_rows(min_row=2, max_col=6, values_only=True):
        state_name = clean_name(row[positions["Bundesland"]])
        typ = clean_name(row[positions["Kreis"]])
        name = clean_name(row[positions["Verwaltung"]])
        postal_code = normalize_postal_code(row[positions["Postleitzahl"]])
        ort = clean_name(row[positions["Ort"]])
        if not any((state_name, typ, name, postal_code, ort)):
            continue
        if name:
            source_name_counts[name] += 1
        reason = exclusion_reason(name, typ)
        if reason:
            exclusions[reason] += 1
            excluded_names[reason][name or "<leer>"] += 1
            continue
        candidates.append({
            "name": name,
            "scope": normalize_scope(name),
            "typ": typ,
            "postalCode": postal_code,
            "ort": ort,
            "stateName": state_name,
        })
    workbook.close()

    candidates.sort(key=lambda item: (
        item["name"].casefold(),
        item["stateName"].casefold(),
        item["typ"].casefold(),
        item["postalCode"],
        item["ort"].casefold(),
    ))
    unique: dict[str, dict] = {}
    duplicate_names: Counter[str] = Counter()
    duplicate_values: dict[str, list[dict]] = defaultdict(list)
    for candidate in candidates:
        name = candidate["name"]
        if name in unique:
            duplicate_names[name] += 1
            duplicate_values[name].append(candidate)
            continue
        unique[name] = candidate

    mapped: list[dict] = []
    unmapped: list[str] = []
    ambiguous_exact = 0
    for candidate in unique.values():
        postal_code = candidate["postalCode"]
        ort = candidate["ort"]
        exact_counts = exact_aggs.get((postal_code, ort), Counter())
        district_ags = select_ags(exact_counts)
        if district_ags is None:
            district_ags = select_ags(postal_aggs.get(postal_code, Counter()))
        if district_ags is None or district_ags not in area_by_ags:
            unmapped.append(
                f"{candidate['name']} | {postal_code or '<leer>'} | {ort or '<leer>'}"
            )
            continue
        if len(exact_counts) > 1:
            ambiguous_exact += 1
        mapped.append({
            **candidate,
            "districtAgs": district_ags,
        })

    mapped.sort(key=lambda item: (
        item["districtAgs"],
        item["postalCode"],
        item["scope"].casefold(),
        item["name"].casefold(),
    ))
    lines = [
        f"Quellzeilen mit Daten in den Nicht-Personenspalten: {len(candidates) + sum(exclusions.values())}",
        f"Ausgeschlossen gesamt: {sum(exclusions.values())}",
        "Doppelte Verwaltung-Namen in der Quelle: "
        f"{sum(count - 1 for count in source_name_counts.values() if count > 1)} Zusatzzeilen / "
        f"{sum(1 for count in source_name_counts.values() if count > 1)} Namen",
    ]
    for reason in sorted(exclusions):
        lines.append(f"  {reason}: {exclusions[reason]}")
        lines.extend(
            f"    {name}" + (f" (×{count})" if count > 1 else "")
            for name, count in sorted(excluded_names[reason].items(), key=lambda item: item[0].casefold())
        )
    lines.extend([
        f"Doppelte Namen nach Ausschlüssen zusammengeführt: {sum(duplicate_names.values())} Zusatzzeilen / {len(duplicate_names)} Namen",
        f"Eindeutige Verwaltungen nach Ausschlüssen: {len(unique)}",
        f"Mehrdeutige exakte (PLZ, Ort)-Zuordnungen, Mehrheit/AGS-Gleichstand angewandt: {ambiguous_exact}",
        f"Unmapped: {len(unmapped)}",
    ])
    if duplicate_names:
        lines.append("Zusammengeführte Doppelnamen:")
        lines.extend(
            f"  {name} (zusätzliche Zeilen: {count})"
            for name, count in sorted(duplicate_names.items(), key=lambda item: item[0].casefold())
        )
    lines.append("Nicht zuordenbare Verwaltungen (Name | PLZ | Ort):")
    lines.extend(f"  {row}" for row in sorted(unmapped, key=str.casefold))
    sample = random.Random(20261011).sample(mapped, min(40, len(mapped)))
    lines.append("Deterministische Zufallsstichprobe (Seed 20261011), Name → scope → districtAgs / Kreis:")
    lines.extend(
        f"  {row['name']} → {row['scope']} → {row['districtAgs']} / {area_by_ags[row['districtAgs']]['name']}"
        for row in sample
    )
    return mapped, lines


def main() -> None:
    parser = argparse.ArgumentParser(description="Generiert bereinigte Verwaltungssuchbereiche.")
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH)
    parser.add_argument("--report", type=Path, default=REPORT_PATH)
    args = parser.parse_args()
    mapped, report_lines = generate(args.input)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(mapped, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    args.report.write_text("\n".join([f"Verwaltungen übernommen: {len(mapped)}", *report_lines]) + "\n", encoding="utf-8")
    print(f"verwaltungen_kept={len(mapped)}")
    print(f"report={args.report}")
    print(f"output={args.output}")


if __name__ == "__main__":
    main()
