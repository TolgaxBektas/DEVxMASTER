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
    ("name", "reason"),
    [
        ("Stadt Essen", None),
        ("Gemeinde Anröchte", None),
        ("Ennepe-Ruhr-Kreis", "Name endet auf Kreis"),
        ("Landratsamt Freising", "Name-Präfix landratsamt"),
        ("Regierungsbezirk Köln", "Name-Präfix regierungsbezirk"),
        ("Bundesministerium", None),
    ],
)
def test_exclusion_rules(name, reason):
    assert generate_verwaltungen.exclusion_reason(name) == reason


def make_mapping_indexes(localities, state_name="Testland"):
    area_by_ags = {
        locality["municipalityKey"][:5]: {
            "ags": locality["municipalityKey"][:5],
            "stateName": state_name,
        }
        for locality in localities
    }
    return generate_verwaltungen.build_mapping_indexes(localities, area_by_ags)


def test_maps_exact_postal_and_locality_first():
    localities = [
        {"postalCode": "12345", "name": "A", "municipalityKey": "01002001"},
        {"postalCode": "12345", "name": "B", "municipalityKey": "01002002"},
        {"postalCode": "12345", "name": "C", "municipalityKey": "01001001"},
    ]
    indexes = make_mapping_indexes(localities)
    assert generate_verwaltungen.map_district(
        "12345", "C", "C", "Testland", indexes,
    ) == ("01001", "a")


def test_maps_unique_locality_name_in_the_same_state():
    indexes = make_mapping_indexes([
        {"postalCode": "85530", "name": "Haar", "municipalityKey": "09184123"},
    ], "Bayern")
    assert generate_verwaltungen.map_district(
        "99999", "Haar", "Haar", "Bayern", indexes,
    ) == ("09184", "b")


def test_maps_normalized_abbreviation_and_cleaned_scope():
    indexes = make_mapping_indexes([
        {"postalCode": "83352", "name": "Altenmarkt an der Alz", "municipalityKey": "09189123"},
        {"postalCode": "34508", "name": "Willingen", "municipalityKey": "06635123"},
    ], "Testland")
    assert generate_verwaltungen.map_district(
        "99999", "Altenmarkt a.d.Alz", "", "Testland", indexes,
    ) == ("09189", "c")
    assert generate_verwaltungen.map_district(
        "99998", "unbekannt", "Willingen (Upland)", "Testland", indexes,
    ) == ("06635", "c")
    assert generate_verwaltungen.normalize_comparison_name("St. Egidien") == "sankt egidien"


def test_ambiguous_names_use_a_unique_three_digit_postal_prefix():
    indexes = make_mapping_indexes([
        {"postalCode": "11111", "name": "Neustadt", "municipalityKey": "01001123"},
        {"postalCode": "87440", "name": "Neustadt", "municipalityKey": "01002123"},
    ])
    assert generate_verwaltungen.map_district(
        "87499", "Neustadt", "", "Testland", indexes,
    ) == ("01002", "d")


def test_postal_majority_is_the_last_mapping_step():
    indexes = make_mapping_indexes([
        {"postalCode": "12345", "name": "A", "municipalityKey": "01002001"},
        {"postalCode": "12345", "name": "B", "municipalityKey": "01002002"},
        {"postalCode": "12345", "name": "C", "municipalityKey": "01001001"},
    ])
    assert generate_verwaltungen.map_district(
        "12345", "unbekannt", "", "Testland", indexes,
    ) == ("01002", "e")


def test_name_matching_is_limited_to_the_file_state():
    indexes = make_mapping_indexes([
        {"postalCode": "85530", "name": "Haar", "municipalityKey": "09184123"},
    ], "Bayern")
    assert generate_verwaltungen.map_district(
        "99999", "Haar", "", "Hessen", indexes,
    ) == (None, None)
