import io

import fitz
from PIL import Image
from app.services.processor import (
    _add_candidate_without_nested_duplicates,
    extract_pdf_metadata,
    heuristic_ad_regions,
    render_ad_crop,
    render_and_extract,
)

def make_pdf():
    d=fitz.open(); p=d.new_page(); p.insert_text((72,72),'Beispiel GmbH Telefon 01234 567890 www.beispiel.de Werbung')
    return d.tobytes()

def test_render_extract():
    pages=render_and_extract(make_pdf(), dpi=72)
    assert len(pages)==1
    assert 'Beispiel GmbH' in pages[0]['text']
    assert pages[0]['ad_probability'] > 0.3

def test_extracts_pdf_metadata_and_title_typography():
    d = fitz.open()
    d.set_metadata({"title": "Amtsblatt Ausgabe Nr. 1", "subject": "Kommunale Bekanntmachungen"})
    page = d.new_page()
    page.insert_text((72, 72), "Amtsblatt für den Landkreis Beispiel", fontsize=24)
    pages = render_and_extract(d.tobytes(), dpi=72)
    metadata = extract_pdf_metadata(d.tobytes())
    assert metadata["title"] == "Amtsblatt Ausgabe Nr. 1"
    assert any("Amtsblatt für den Landkreis Beispiel" in item["text"] and item["size"] > 20
               for item in pages[0]["title_candidates"])


def layout(blocks, drawings=(), images=()):
    return {
        "page_width": 1000,
        "page_height": 1000,
        "blocks": blocks,
        "drawings": list(drawings),
        "images": list(images),
    }


def block(x0, y0, x1, y1, text, sizes=(10,), fonts=("Arial",)):
    return {
        "bbox": (x0, y0, x1, y1),
        "text": text,
        "font_sizes": list(sizes),
        "font_names": list(fonts),
        "lines": [{"bbox": (x0, y0, x1, y1), "text": text, "font_sizes": list(sizes), "font_names": list(fonts)}],
    }


def drawing(x0, y0, x1, y1, fill=(0.9, 0.9, 0.9)):
    return {
        "bbox": (x0, y0, x1, y1),
        "fill": fill,
        "color": None,
        "width": 1,
        "items": 5,
    }


def logo_drawing(x0=150, y0=150, x1=250, y1=210):
    return drawing(x0, y0, x1, y1, fill=(0.1, 0.3, 0.8))


def test_detects_multiple_bounded_ads_without_merging():
    result = heuristic_ad_regions(
        b"",
        "",
        layout([
            block(80, 80, 390, 250, "Taxi Weig Telefon 01234 567890 www.taxi-weig.de", (10, 22), ("Arial", "Bold")),
            block(610, 80, 920, 250, "LUGATO GmbH Angebot 20 EUR Telefon 01234 567891 www.lugato.de", (9, 18), ("Arial", "Bold")),
        ], [
            drawing(60, 60, 410, 270),
            drawing(590, 60, 940, 270),
            logo_drawing(120, 100, 180, 150),
            logo_drawing(680, 100, 740, 150),
        ]),
    )
    assert len(result) == 2
    evidence = {signal for item in result for signal in item["evidence"]}
    assert {"geometry", "advertiser", "contact"} <= evidence


def test_detects_ad_spanning_two_columns_as_one_candidate():
    result = heuristic_ad_regions(
        b"",
        "",
        layout([
            block(100, 300, 480, 420, "WoW Logistics GmbH Telefon 01234 567890", (10, 20), ("Arial", "Bold")),
            block(520, 300, 900, 420, "www.wow-logistics.de Angebot", (10, 16), ("Arial", "Regular")),
        ], [drawing(80, 280, 920, 440), logo_drawing(180, 320, 280, 370)]),
    )
    assert len(result) == 1
    assert result[0]["width"] > 0.75


def test_nested_overlaps_replace_all_only_when_new_box_is_larger_than_each():
    results = [
        {"_box": (0, 0, 100, 100)},
        {"_box": (10, 10, 210, 210)},
    ]
    _add_candidate_without_nested_duplicates(
        results,
        {"confidence": 0.9},
        (0, 0, 150, 150),
    )
    assert len(results) == 2
    assert {item["_box"] for item in results} == {
        (0, 0, 100, 100),
        (10, 10, 210, 210),
    }

    _add_candidate_without_nested_duplicates(
        results,
        {"confidence": 0.95},
        (0, 0, 300, 300),
    )
    assert len(results) == 1
    assert results[0]["_box"] == (0, 0, 300, 300)


def test_plain_editorial_page_has_no_ad_candidates():
    result = heuristic_ad_regions(
        b"",
        "",
        layout([block(100, 100, 900, 900, "Nachrichten und kommunale Informationen", (10,))]),
    )
    assert result == []


def test_contact_signal_without_material_geometry_is_not_a_candidate():
    result = heuristic_ad_regions(
        b"",
        "",
        layout([block(100, 100, 900, 300, "Muster GmbH Telefon 01234 567890 www.muster.de")]),
    )
    assert result == []


def test_bounded_ad_requires_logo_and_phone_not_legal_form():
    result = heuristic_ad_regions(
        b"",
        "",
        layout([
            block(180, 180, 820, 260, "WAT pflegt! Tel. 02327 9607571", (18, 28), ("Display", "Bold")),
        ], [
            drawing(120, 120, 880, 320),
            logo_drawing(220, 190, 320, 240),
        ]),
    )
    assert len(result) == 1
    assert {"geometry", "contact", "logo"} <= set(result[0]["evidence"])


def test_bounded_ad_without_logo_or_phone_is_not_a_candidate():
    result = heuristic_ad_regions(
        b"",
        "",
        layout([
            block(180, 180, 820, 260, "Pflegedienst Sonnenschein", (18, 28), ("Display", "Bold")),
        ], [drawing(120, 120, 880, 320)]),
    )
    assert result == []


def test_directory_entry_without_logo_or_material_is_not_a_candidate():
    result = heuristic_ad_regions(
        b"",
        "",
        layout([
            block(80, 100, 920, 180, "Pflegedienst WAT pflegt 02327 9607571", (10,)),
            block(80, 190, 920, 270, "INAs HD&S 0234 54 455 154", (10,)),
        ]),
    )
    assert result == []


def test_phone_labels_and_provenance_warning_are_preserved():
    result = heuristic_ad_regions(
        b"",
        "",
        layout([
            block(180, 180, 820, 260, "Gemeinnütziger Verein Pflegehilfe Tel.: 0234 - 54 45 51 54", (18, 28), ("Display", "Bold")),
        ], [drawing(120, 120, 880, 320), logo_drawing(220, 190, 320, 240)]),
    )
    assert len(result) == 1
    assert "provenance-uncertain" in result[0]["evidence"]


def test_directory_with_multiple_providers_is_not_an_ad():
    result = heuristic_ad_regions(
        b"",
        "",
        layout([
            block(100, 120, 900, 180, "Pflegedienst Alpha Straße 1 44801 Bochum Tel. 0234 111111", (10,)),
            block(100, 200, 900, 260, "Pflegedienst Beta Straße 2 44802 Bochum Tel. 0234 222222", (10,)),
            block(100, 280, 900, 340, "Pflegedienst Gamma Straße 3 44803 Bochum Tel. 0234 333333", (10,)),
        ], [
            drawing(60, 80, 940, 380),
            logo_drawing(150, 90, 240, 130),
        ]),
    )
    assert result == []


def test_numbered_map_overview_is_not_an_ad():
    result = heuristic_ad_regions(
        b"",
        "",
        layout([
            block(100, 100, 900, 180, "Fachbereich Altenhilfe Karte 1 2 3 4 5 6 7 8 9 10 Telefon 0234 91461021", (10,)),
        ], [
            drawing(60, 60, 940, 940),
            logo_drawing(200, 300, 300, 380),
        ]),
    )
    assert result == []


def test_strong_public_origin_is_excluded():
    for text in (
        "Gefördert von: Kontaktbüro Pflegehilfe Telefon 0234 3253523",
        "Ministerium für Gesundheit Telefon 0234 3253523",
        "Stadt Bochum Seniorenberatung Telefon 0234 3253523",
        "Kommunale Wohnungsgesellschaft Telefon 0234 3253523",
    ):
        result = heuristic_ad_regions(
            b"",
            "",
            layout([
                block(180, 180, 820, 260, text, (18, 28), ("Display", "Bold")),
            ], [drawing(120, 120, 880, 320), logo_drawing(220, 190, 320, 240)]),
        )
        assert result == []


def test_brand_name_alone_does_not_guess_public_origin():
    result = heuristic_ad_regions(
        b"",
        "",
        layout([
            block(180, 180, 820, 260, "VBW KundenCenter Bochum Telefon 0234 310-310", (18, 28), ("Display", "Bold")),
        ], [drawing(120, 120, 880, 320), logo_drawing(220, 190, 320, 240)]),
    )
    assert len(result) == 1


def test_publisher_marking_is_independent_evidence():
    result = heuristic_ad_regions(
        b"",
        "",
        layout([
            block(100, 100, 900, 300, "Erlebe die Oberlausitz www.oberlausitz.com", (18, 28), ("Display", "Bold")),
            block(40, 40, 55, 50, "Anzeige", (6,)),
        ], [
            drawing(60, 60, 940, 940),
            logo_drawing(200, 300, 300, 380),
        ]),
    )
    assert result == []


def test_marked_brand_ad_without_phone_is_not_a_candidate():
    result = heuristic_ad_regions(
        b"",
        "",
        layout([
            block(100, 100, 900, 220, "UTOPIA", (32,), ("Display",)),
            block(100, 700, 900, 760, "Anzeige", (6,)),
        ], [drawing(0, 0, 1000, 1000), logo_drawing(200, 300, 300, 380)]),
    )
    assert result == []


def test_marked_full_page_ad_is_detected_as_one_candidate():
    result = heuristic_ad_regions(
        b"",
        "",
        layout([
            block(10, 10, 40, 20, "Anzeige", (6,)),
        ], [drawing(0, 0, 1000, 1000), logo_drawing(200, 300, 300, 380)]),
    )
    assert result == []


def test_marked_image_ad_grows_to_include_header_and_contact_lines():
    result = heuristic_ad_regions(
        b"",
        "",
        layout([
            block(80, 20, 920, 60, "BRAUEREIFÜHRUNG", (28,), ("Display",)),
            block(80, 70, 920, 100, "Tägliche Führungen! Telefon 03581 4650", (12,), ("Arial",)),
            block(80, 110, 920, 140, "www.landskron.de/besuch", (12,), ("Arial",)),
            block(10, 10, 30, 20, "Anzeige", (6,)),
        ], [
            drawing(200, 300, 300, 380),
        ], images=[{"bbox": (0, 150, 1000, 1000)}]),
    )
    assert len(result) == 1
    assert result[0]["y"] == 0
    assert result[0]["height"] == 1


def test_tour_anzeigen_in_editorial_text_is_not_publisher_marking():
    result = heuristic_ad_regions(
        b"",
        "",
        layout([
            block(100, 100, 900, 300, "Tour anzeigen und weitere Informationen", (10,)),
        ]),
    )
    assert result == []


def test_editorial_impressum_and_table_are_not_ads():
    editorial = heuristic_ad_regions(
        b"",
        "",
        layout([
            block(80, 80, 920, 300, "Impressum Herausgeber Redaktion Verantwortlich Telefon 01234 567890 www.example.de " * 2, (10,)),
        ], [drawing(60, 60, 940, 320), logo_drawing(200, 120, 300, 180)]),
    )
    table = heuristic_ad_regions(
        b"",
        "",
        layout([
            block(100, 100, 900, 160, "Programm Telefon 01234 567890", (10,)),
            block(100, 170, 900, 230, "Anlage 1 www.example.de", (10,)),
            block(100, 240, 900, 300, "Anlage 2 Fax 01234 567890", (10,)),
            block(100, 310, 900, 370, "Anlage 3 Telefon 01234 567890", (10,)),
            block(100, 380, 900, 440, "Anlage 4 www.example.de", (10,)),
        ], [drawing(80, 80, 920, 470), logo_drawing(200, 120, 300, 180)]),
    )
    assert editorial == []
    assert table == []


def test_candidate_snaps_to_existing_frame_and_confidence_follows_evidence():
    result = heuristic_ad_regions(
        b"",
        "",
        layout([
            block(120, 130, 380, 250, "Haus Schleusberg GmbH Telefon 01234 567890", (10,)),
        ], [drawing(100, 100, 400, 280), logo_drawing(160, 150, 220, 190)]),
    )
    assert result[0]["x"] == 0.1
    assert result[0]["y"] == 0.1
    assert result[0]["width"] == 0.3
    assert result[0]["height"] == 0.18
    weak = heuristic_ad_regions(
        b"",
        "",
        layout([block(120, 130, 380, 250, "Haus Schleusberg GmbH Telefon 01234 567890", (10,))], [drawing(100, 100, 400, 280), logo_drawing(160, 150, 220, 190)]),
    )
    strong = heuristic_ad_regions(
        b"",
        "",
        layout([block(120, 130, 380, 250, "Haus Schleusberg GmbH Telefon 01234 567890 www.haus.de", (10, 20), ("Arial", "Bold"))], [drawing(100, 100, 400, 280), logo_drawing(160, 150, 220, 190)]),
    )
    assert strong[0]["confidence"] > weak[0]["confidence"]


def test_full_page_material_with_brand_and_contact_is_one_ad():
    result = heuristic_ad_regions(
        b"",
        "",
        layout([
            block(100, 100, 900, 180, "Private Information", (24,), ("Display",)),
            block(200, 300, 800, 420, "Souvenirs und Geschenkartikel im Onlineshop", (12,), ("Text",)),
            block(100, 700, 900, 820, "Private Information GmbH Telefon +49 3581 4757-0 www.example.de", (10,), ("Text",)),
        ], [drawing(200, 300, 300, 380)],
        images=[{"bbox": (0, 0, 1000, 1000)}]),
    )
    assert len(result) == 1
    assert result[0]["evidence"][:3] == ["geometry", "advertiser", "contact"]
    assert result[0]["width"] == 1


def test_frame_does_not_cut_a_touched_text_line():
    result = heuristic_ad_regions(
        b"",
        "",
        layout([
            block(120, 130, 380, 250, "Muster GmbH Telefon 01234 567890", (10,)),
        ], [drawing(100, 100, 300, 280), logo_drawing(160, 150, 220, 190)]),
    )
    assert result == []


def test_render_ad_crop_rerenders_pdf_region_at_high_resolution():
    document = fitz.open()
    page = document.new_page(width=400, height=300)
    page.insert_text((40, 80), "Ausschnitt", fontsize=24)
    pdf = document.tobytes()
    crop = render_ad_crop(pdf, 1, {"x": 0.1, "y": 0.1, "width": 0.5, "height": 0.5}, dpi=300)
    page_image = render_and_extract(pdf, dpi=72)[0]["image_bytes"]
    with Image.open(io.BytesIO(crop)) as crop_image, Image.open(io.BytesIO(page_image)) as full_image:
        assert crop_image.width > full_image.width * 0.4
        assert crop_image.height > full_image.height * 0.4
        assert crop_image.width < full_image.width * 3
