import io

import fitz
from PIL import Image
from app.services.processor import (
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


def test_detects_multiple_bounded_ads_without_merging():
    result = heuristic_ad_regions(
        b"",
        "",
        layout([
            block(80, 80, 390, 250, "Taxi Weig Telefon 01234 567890 www.taxi-weig.de", (10, 22), ("Arial", "Bold")),
            block(610, 80, 920, 250, "LUGATO GmbH Angebot 20 EUR www.lugato.de", (9, 18), ("Arial", "Bold")),
        ], [
            drawing(60, 60, 410, 270),
            drawing(590, 60, 940, 270),
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
        ], [drawing(80, 280, 920, 440)]),
    )
    assert len(result) == 1
    assert result[0]["width"] > 0.75


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


def test_editorial_impressum_and_table_are_not_ads():
    editorial = heuristic_ad_regions(
        b"",
        "",
        layout([
            block(80, 80, 920, 300, "Impressum Herausgeber Redaktion Verantwortlich Telefon 01234 567890 www.example.de " * 2, (10,)),
        ], [drawing(60, 60, 940, 320)]),
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
        ], [drawing(80, 80, 920, 470)]),
    )
    assert editorial == []
    assert table == []


def test_candidate_snaps_to_existing_frame_and_confidence_follows_evidence():
    result = heuristic_ad_regions(
        b"",
        "",
        layout([
            block(120, 130, 380, 250, "Haus Schleusberg GmbH Telefon 01234 567890", (10,)),
        ], [drawing(100, 100, 400, 280)]),
    )
    assert result[0]["x"] == 0.1
    assert result[0]["y"] == 0.1
    assert result[0]["width"] == 0.3
    assert result[0]["height"] == 0.18
    weak = heuristic_ad_regions(
        b"",
        "",
        layout([block(120, 130, 380, 250, "Haus Schleusberg GmbH Telefon 01234 567890", (10,))], [drawing(100, 100, 400, 280)]),
    )
    strong = heuristic_ad_regions(
        b"",
        "",
        layout([block(120, 130, 380, 250, "Haus Schleusberg GmbH Telefon 01234 567890 www.haus.de", (10, 20), ("Arial", "Bold"))], [drawing(100, 100, 400, 280)]),
    )
    assert strong[0]["confidence"] > weak[0]["confidence"]


def test_full_page_material_with_brand_and_contact_is_one_ad():
    result = heuristic_ad_regions(
        b"",
        "",
        layout([
            block(100, 100, 900, 180, "Görlitz Information", (24,), ("Display",)),
            block(200, 300, 800, 420, "Souvenirs und Geschenkartikel im Onlineshop", (12,), ("Text",)),
            block(100, 700, 900, 820, "Görlitz-Information GmbH Telefon +49 3581 4757-0 www.goerlitz.de", (10,), ("Text",)),
        ], [],
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
        ], [drawing(100, 100, 300, 280)]),
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
