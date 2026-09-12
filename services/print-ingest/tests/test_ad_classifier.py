import random
import time

from app.services.processor import (
    _blocks_are_clustered,
    _p1_reason,
    _sender_clusters,
    _typography_satisfies,
    classify_ad_candidate,
    heuristic_ad_regions,
)


def block(x0, y0, x1, y1, text, sizes=(10,)):
    return {
        "bbox": (x0, y0, x1, y1),
        "text": text,
        "font_sizes": list(sizes),
        "font_names": ["Arial"] * len(sizes),
        "lines": [{"bbox": (x0, y0, x1, y1), "text": text, "font_sizes": list(sizes)}],
    }


def layout(blocks, drawings=(), images=()):
    return {
        "page_width": 1000,
        "page_height": 1000,
        "blocks": blocks,
        "drawings": list(drawings),
        "images": list(images),
    }


def drawing(x0, y0, x1, y1, fill=(0.2, 0.4, 0.8)):
    return {
        "bbox": (x0, y0, x1, y1),
        "fill": fill,
        "color": None,
        "width": 1,
        "items": 5,
    }


def classify(text, blocks=None, **kwargs):
    blocks = blocks or [block(100, 100, 900, 300, text, (10, 20))]
    kwargs.setdefault("logo", True)
    return classify_ad_candidate(text, blocks, **kwargs)


def test_official_sender_is_non_commercial():
    result = classify("Stadtbücherei Musterstadt Telefon 01234 567890 Angebot")
    assert result["classification"] == "non_commercial"
    assert "veto:behoerde" in result["reasons"]


def test_church_sender_is_non_commercial():
    result = classify("Katholische Pfarrgemeinde Telefon 01234 567890 Angebot")
    assert result["classification"] == "non_commercial"
    assert "veto:kirche" in result["reasons"]


def test_association_with_commercial_signals_is_unclear():
    result = classify("Sportverein GmbH Telefon 01234 567890 Angebot")
    assert result["classification"] == "unclear"
    assert "unclear:verein" in result["reasons"]


def test_association_abbreviations_require_uppercase():
    uppercase = classify("SV Service GmbH Telefon 01234 567890 Angebot")
    lowercase = classify("sv Service GmbH Telefon 01234 567890 Angebot")
    assert "unclear:verein" in uppercase["reasons"]
    assert "veto:verein" not in lowercase["reasons"]


def test_publisher_self_promotion_is_non_commercial():
    result = classify("Anzeigenauftrag und Anzeigenschluss Telefon 01234 567890")
    assert result["classification"] == "non_commercial"
    assert "veto:verlag" in result["reasons"]


def test_three_contact_name_blocks_are_directory_content():
    blocks = [
        block(100, 100, 900, 140, "Alpha Pflegedienst Telefon 01234 111111"),
        block(100, 150, 900, 190, "Beta Pflegedienst Telefon 01234 222222"),
        block(100, 200, 900, 240, "Gamma Pflegedienst Telefon 01234 333333"),
    ]
    result = classify(" ".join(item["text"] for item in blocks), blocks)
    assert result["classification"] == "non_commercial"
    assert "veto:verzeichnis" in result["reasons"]


def test_font_size_stats_cache_is_identity_safe():
    candidate = block(100, 100, 900, 140, "KREATIVWERK", (20,))
    small_page = [block(0, 0, 1000, 1000, "Grundtext", (10,))]
    large_page = [block(0, 0, 1000, 1000, "Grundtext", (20,))]
    same_length_different_sizes = [block(0, 0, 1000, 1000, "Grundtext", (100,))]

    assert _p1_reason("KREATIVWERK Telefon 01234 567890", [candidate], small_page) == "p1c"
    assert _p1_reason("KREATIVWERK Telefon 01234 567890", [candidate], large_page) is None
    assert _typography_satisfies([block(100, 100, 900, 140, "KREATIVWERK", (20, 27))], small_page)
    assert not _typography_satisfies(
        [block(100, 100, 900, 140, "KREATIVWERK", (20, 27))],
        large_page,
    )
    assert _p1_reason(
        "KREATIVWERK Telefon 01234 567890",
        [candidate],
        same_length_different_sizes,
    ) is None


def test_sender_clusters_use_y_window_for_large_ocr_raster():
    blocks = []
    for row in range(60):
        for column in range(58):
            x0, y0 = column * 18, row * 24
            blocks.append(block(x0, y0, x0 + 12, y0 + 10, "Taxi Huber Telefon 01234 567890"))

    started = time.perf_counter()
    result = _sender_clusters((0, 0, 1100, 1500), blocks)
    elapsed = time.perf_counter() - started
    block_indexes = {id(item): index for index, item in enumerate(blocks)}

    assert len(blocks) == 3480
    assert len(result) == 60
    assert all(len(grouped_blocks) == 58 for _, grouped_blocks in result)
    assert all(
        [block_indexes[id(item)] for item in grouped_blocks]
        == sorted(block_indexes[id(item)] for item in grouped_blocks)
        for _, grouped_blocks in result
    )
    assert elapsed < 2


def test_sender_clusters_match_all_pair_reference():
    rng = random.Random(1907)
    blocks = []
    for index in range(300):
        row, column = divmod(index, 20)
        x0 = column * 60 + rng.randint(-5, 5)
        y0 = row * 45 + rng.randint(-5, 5)
        width = rng.randint(25, 70)
        height = rng.randint(20, 55)
        blocks.append(block(x0, y0, x0 + width, y0 + height, "Taxi Huber Telefon 01234 567890"))

    assert any(
        _blocks_are_clustered(blocks[first], blocks[second])
        for first in range(len(blocks))
        for second in range(first + 1, len(blocks))
    )
    assert any(
        not _blocks_are_clustered(blocks[first], blocks[second])
        for first in range(len(blocks))
        for second in range(first + 1, len(blocks))
    )

    parent = list(range(len(blocks)))

    def find(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    for first in range(len(blocks)):
        for second in range(first + 1, len(blocks)):
            if _blocks_are_clustered(blocks[first], blocks[second]):
                parent[find(second)] = find(first)

    expected = {}
    for index in range(len(blocks)):
        expected.setdefault(find(index), set()).add(index)

    actual = []
    block_indexes = {id(item): index for index, item in enumerate(blocks)}
    for _, grouped_blocks in _sender_clusters((0, 0, 1300, 800), blocks):
        actual.append({block_indexes[id(item)] for item in grouped_blocks})

    assert actual == list(expected.values())


def test_three_label_lines_are_directory_content():
    text = "Kontaktdaten: Alpha\nÖffnungszeiten: Montag\nAnsprechpartner: Frau Muster"
    result = classify(text, [block(100, 100, 900, 140, line) for line in text.splitlines()])
    assert result["classification"] == "non_commercial"
    assert "veto:verzeichnis" in result["reasons"]


def test_long_prose_is_editorial_even_for_full_page_candidate():
    text = " ".join(["Bericht über kommunale Informationen und den weiteren Verlauf."] * 12)
    result = classify(text, [block(100, 100 + index * 50, 900, 130 + index * 50, text) for index in range(5)], geometry_ratio=0.5, page_dominant=True)
    assert result["classification"] == "non_commercial"
    assert "veto:redaktion" in result["reasons"]


def test_municipal_job_ad_is_non_commercial():
    result = classify("Gemeinde Muster sucht zum nächstmöglichen Termin (m/w/d) Bewerbung")
    assert result["classification"] == "non_commercial"
    assert "veto:stellenanzeige" in result["reasons"]


def test_charitable_service_provider_is_unclear():
    result = classify("Caritas Pflegedienst GmbH Angebot Telefon 01234 567890")
    assert result["classification"] == "unclear"
    assert "unclear:traeger" in result["reasons"]


def test_missing_positive_conditions_are_reported():
    assert "fehlend:absender" in classify("Muster Telefon 01234 567890 Angebot")["reasons"]
    assert classify("Bäckerei Muster Telefon 01234 567890")["classification"] == "company_ad"
    assert "fehlend:kontakt" in classify("Bäckerei Muster Angebot")["reasons"]
    assert "fehlend:gestaltung" in classify(
        "Bäckerei Muster Angebot Telefon 01234 567890",
        [block(100, 100, 900, 140, "Bäckerei Muster Angebot Telefon 01234 567890", (10,))],
        logo=False,
    )["reasons"]


def test_weak_prominent_sender_requires_ad_intent():
    result = classify(
        "KREATIVWERK Telefon 01234 567890",
        [block(100, 100, 900, 140, "KREATIVWERK", (10, 20))],
        page_blocks=[block(0, 0, 1000, 1000, "Grundtext", (10,))],
    )
    assert result["classification"] == "non_commercial"
    assert "fehlend:werbeabsicht" in result["reasons"]


def test_spaced_letter_sender_is_normalized():
    result = classify("B A U S P E N G L E R E I Andreas Schwaiger Telefon 01234 567890")
    assert result["classification"] == "company_ad"
    assert "positiv:p1b" in result["reasons"]


def test_business_card_ad_does_not_require_ad_intent():
    result = classify("Bäckerei Muster, Hauptstraße 1, 01234 Musterstadt, Telefon 01234 567890")
    assert result["classification"] == "company_ad"


def test_industry_word_in_domain_is_commercial_sender():
    result = classify("frankenaturstein.de Telefon 01234 567890")
    assert result["classification"] == "company_ad"
    assert "positiv:p1b" in result["reasons"]


def test_ordinary_word_preis_does_not_match_reisen():
    result = classify("Wir liefern zu fairen Preisen Telefon 01234 567890")
    assert result["classification"] == "non_commercial"
    assert "fehlend:absender" in result["reasons"]


def test_ordinary_word_begreifen_does_not_match_reifen():
    result = classify("Das lässt sich leicht begreifen Telefon 01234 567890")
    assert result["classification"] == "non_commercial"
    assert "fehlend:absender" in result["reasons"]


def test_industry_prefix_matches_reifenservice():
    result = classify("Reifenservice Huber Telefon 01234 567890")
    assert result["classification"] == "company_ad"
    assert "positiv:p1b" in result["reasons"]


def test_compound_head_matches_meisterbetrieb():
    result = classify("Kfz-Meisterbetrieb Huber Telefon 01234 567890")
    assert result["classification"] == "company_ad"
    assert "positiv:p1b" in result["reasons"]


def test_industry_head_matches_domain_subtoken():
    result = classify("info@frankenaturstein.de Telefon 01234 567890")
    assert result["classification"] == "company_ad"
    assert "positiv:p1b" in result["reasons"]


def test_logo_commercial_ad_with_seventy_words_is_not_editorial():
    text = (
        "Naturstein Muster Telefon 01234 567890 "
        + " ".join(["Wir bieten hochwertige Beratung und individuelle Leistungen."] * 11)
    )
    blocks = [
        block(100, 100 + index * 40, 900, 130 + index * 40, line)
        for index, line in enumerate(text.split(" "))
    ][:5]
    result = classify(text, blocks)
    assert result["classification"] == "company_ad"
    assert "veto:redaktion" not in result["reasons"]


def test_amtsblatt_prose_without_commercial_sender_is_editorial():
    text = " ".join(["Kommunale Informationen werden hier ausführlich bekannt gegeben."] * 25)
    blocks = [
        block(100, 100 + index * 30, 900, 125 + index * 30, line)
        for index, line in enumerate(text.split(" "))
    ][:5]
    result = classify(text, blocks)
    assert result["classification"] == "non_commercial"
    assert "veto:redaktion" in result["reasons"]


def test_many_contact_lines_for_one_sender_are_not_directory_content():
    text = (
        "Pflegedienst Muster Telefon 01234 111111 Mobil 0170 222222 "
        "Fax 01234 333333 Telefon 01234 444444"
    )
    result = classify(text)
    assert result["classification"] == "company_ad"
    assert "veto:verzeichnis" not in result["reasons"]


def test_full_page_candidate_requires_marking_exception():
    text = "Bäckerei Muster Angebot Telefon 01234 567890"
    rejected = classify(text, geometry_ratio=0.6, marked=False)
    accepted = classify(text, geometry_ratio=0.6, marked=True)
    assert rejected["classification"] == "non_commercial"
    assert "veto:ganzseite" in rejected["reasons"]
    assert accepted["classification"] == "company_ad"


def test_three_ad_strip_is_split_into_three_candidates():
    blocks = [
        block(100, 100, 900, 140, "Bäckerei Alpha Angebot Telefon 01234 111111", (18, 24)),
        block(100, 400, 900, 440, "Hotel Beta Angebot Telefon 01234 222222", (18, 24)),
        block(100, 700, 900, 740, "Elektro Gamma Angebot Telefon 01234 333333", (18, 24)),
    ]
    result = heuristic_ad_regions(
        b"",
        "Anzeigen",
        layout(blocks, [
            drawing(50, 50, 950, 950),
            drawing(80, 80, 920, 200),
            drawing(80, 380, 920, 500),
            drawing(80, 680, 920, 800),
            drawing(180, 100, 260, 125),
            drawing(180, 400, 260, 425),
            drawing(180, 700, 260, 725),
        ]),
    )
    assert len(result) == 3
    assert all(item["height"] < 0.2 for item in result)
