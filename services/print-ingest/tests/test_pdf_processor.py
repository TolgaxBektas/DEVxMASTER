import fitz
from app.services.processor import render_and_extract

def make_pdf():
    d=fitz.open(); p=d.new_page(); p.insert_text((72,72),'Beispiel GmbH Telefon 01234 567890 www.beispiel.de Werbung')
    return d.tobytes()

def test_render_extract():
    pages=render_and_extract(make_pdf(), dpi=72)
    assert len(pages)==1
    assert 'Beispiel GmbH' in pages[0]['text']
    assert pages[0]['ad_probability'] > 0.3
