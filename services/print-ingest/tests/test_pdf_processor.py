import fitz
from app.services.processor import extract_pdf_metadata, render_and_extract

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
