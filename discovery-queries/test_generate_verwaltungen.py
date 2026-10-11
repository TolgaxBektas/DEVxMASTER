import importlib.util
from pathlib import Path

import pytest


MODULE_PATH = Path(__file__).with_name("generate-verwaltungen.py")
SPEC = importlib.util.spec_from_file_location("generate_verwaltungen", MODULE_PATH)
assert SPEC and SPEC.loader
generate_verwaltungen = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(generate_verwaltungen)


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("Gemeindevorstand der Gemeinde Willingen (Upland)", "Willingen (Upland)"),
        ("VG Straußfurt", "Verwaltungsgemeinschaft Straußfurt"),
        ("Bad Bramstedt, Stadt", "Bad Bramstedt"),
        ("Verbandsgemeindeverwaltung Südeifel", "Verbandsgemeinde Südeifel"),
    ],
)
def test_normalizes_administration_scopes(source, expected):
    assert generate_verwaltungen.normalize_scope(source) == expected


@pytest.mark.parametrize(
    ("name", "typ", "reason"),
    [
        ("Landkreis Freising", "Landkreis", "Typ Landkreis"),
        ("Landratsamt Freising", "Stadt", "ausgeschlossener Name-Präfix"),
        ("Bundesministerium", "", None),
        ("Freising-Kreis", "", "Typ leer, Name endet auf Kreis"),
    ],
)
def test_exclusion_rules(name, typ, reason):
    assert generate_verwaltungen.exclusion_reason(name, typ) == reason


def test_maps_exact_postal_and_locality_before_postal_majority():
    exact, postal = generate_verwaltungen.locality_aggs([
        {"postalCode": "12345", "name": "A", "municipalityKey": "01002001"},
        {"postalCode": "12345", "name": "B", "municipalityKey": "01002002"},
        {"postalCode": "12345", "name": "C", "municipalityKey": "01001001"},
    ])
    assert generate_verwaltungen.map_district("12345", "C", exact, postal) == "01001"
    assert generate_verwaltungen.map_district("12345", "unbekannt", exact, postal) == "01002"
