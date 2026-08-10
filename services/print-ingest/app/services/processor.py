import io, re
import fitz
from PIL import Image
import pytesseract

AD_SIGNALS = re.compile(r'(www\.|https?://|@|telefon|tel\.?|fax|€|eur|angebot|rabatt|aktion|gmbh|kg\b|e\.v\.|\.de\b)', re.I)

def render_and_extract(pdf_bytes: bytes, dpi: int = 180):
    doc=fitz.open(stream=pdf_bytes, filetype='pdf')
    out=[]
    zoom=dpi/72
    mat=fitz.Matrix(zoom,zoom)
    for idx,page in enumerate(doc):
        text=page.get_text('text') or ''
        pix=page.get_pixmap(matrix=mat, alpha=False)
        img_bytes=pix.tobytes('png')
        if len(text.strip()) < 20:
            try:
                text=pytesseract.image_to_string(Image.open(io.BytesIO(img_bytes)), lang='deu+eng')
            except Exception:
                text=text or ''
        signals=len(AD_SIGNALS.findall(text))
        probability=min(0.98, 0.08 + signals*0.08)
        classification='MIXED_CONTENT' if probability>=0.4 else 'EDITORIAL_ONLY'
        out.append({'page_number':idx+1,'text':text,'image_bytes':img_bytes,'ad_probability':probability,'classification':classification})
    return out

def heuristic_ad_regions(page_image: bytes, text: str):
    # MVP baseline: if ad-like signals exist, retain the full page as a review candidate.
    # Future detector replaces this with bounding boxes from a trained CV model.
    signals=len(AD_SIGNALS.findall(text or ''))
    if signals < 4: return []
    return [{'x':0.0,'y':0.0,'width':1.0,'height':1.0,'confidence':min(0.9,0.45+signals*0.04)}]
