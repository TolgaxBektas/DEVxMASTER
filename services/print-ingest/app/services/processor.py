import io, math, re
import fitz
from PIL import Image
import pytesseract

AD_SIGNALS = re.compile(r'(www\.|https?://|@|telefon|tel\.?|fax|€|eur|angebot|rabatt|aktion|gmbh|kg\b|e\.v\.|\.de\b)', re.I)
MAX_ADS_PER_PAGE = 24
MAX_CROP_PIXELS = 18_000_000
CONNECTOR_GAP = 72


def _layout_for_page(page):
    blocks = []
    for block in page.get_text("dict").get("blocks", []):
        if block.get("type") != 0:
            continue
        spans = [
            span
            for line in block.get("lines", [])
            for span in line.get("spans", [])
            if str(span.get("text", "")).strip()
        ]
        text = " ".join(str(span.get("text", "")).strip() for span in spans).strip()
        if text:
            blocks.append({
                "bbox": tuple(float(value) for value in block["bbox"]),
                "text": text,
                "font_sizes": [float(span.get("size", 0)) for span in spans],
                "font_names": [str(span.get("font", "")) for span in spans],
            })
    drawings = []
    for drawing in page.get_drawings():
        rect = drawing.get("rect")
        if rect and rect.width > 1 and rect.height > 1:
            drawings.append({
                "bbox": (float(rect.x0), float(rect.y0), float(rect.x1), float(rect.y1)),
                "fill": drawing.get("fill"),
                "color": drawing.get("color"),
                "width": float(drawing.get("width") or 0),
                "items": len(drawing.get("items", [])),
            })
    return {
        "page_width": float(page.rect.width),
        "page_height": float(page.rect.height),
        "blocks": blocks,
        "drawings": drawings,
    }

def render_and_extract(pdf_bytes: bytes, dpi: int = 180):
    doc=fitz.open(stream=pdf_bytes, filetype='pdf')
    out=[]
    zoom=dpi/72
    mat=fitz.Matrix(zoom,zoom)
    for idx,page in enumerate(doc):
        text=page.get_text('text') or ''
        title_candidates = []
        for block in page.get_text('dict').get('blocks', []):
            for line in block.get('lines', []):
                spans = line.get('spans', [])
                line_text = ' '.join(str(span.get('text', '')).strip() for span in spans).strip()
                if line_text:
                    title_candidates.append({
                        'text': line_text,
                        'size': max(float(span.get('size', 0)) for span in spans),
                    })
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
        out.append({
            'page_number':idx+1,
            'text':text,
            'image_bytes':img_bytes,
            'ad_probability':probability,
            'classification':classification,
            'title_candidates': sorted(title_candidates, key=lambda item: item['size'], reverse=True)[:20],
            'layout': _layout_for_page(page),
        })
    return out

def extract_pdf_metadata(pdf_bytes: bytes):
    try:
        doc = fitz.open(stream=pdf_bytes, filetype='pdf')
    except Exception:
        return {'title': None, 'subject': None, 'creation_date': None}
    metadata = doc.metadata or {}
    return {
        'title': metadata.get('title') or None,
        'subject': metadata.get('subject') or None,
        'creation_date': metadata.get('creationDate') or None,
    }

def _intersection(a, b):
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[2], b[2]), min(a[3], b[3])
    return max(0, x1 - x0) * max(0, y1 - y0)


def _union(boxes):
    return (
        min(box[0] for box in boxes),
        min(box[1] for box in boxes),
        max(box[2] for box in boxes),
        max(box[3] for box in boxes),
    )


def _expand(box, amount, width, height):
    return (
        max(0, box[0] - amount),
        max(0, box[1] - amount),
        min(width, box[2] + amount),
        min(height, box[3] + amount),
    )


def _signals(text):
    return sorted(set(match.group(0).lower() for match in AD_SIGNALS.finditer(text or "")))


def _plausible(box, width, height):
    area = max(0, box[2] - box[0]) * max(0, box[3] - box[1])
    page_area = width * height
    ratio = (box[2] - box[0]) / max(1, box[3] - box[1])
    return area >= page_area * 0.003 and area <= page_area * 0.98 and 0.08 <= ratio <= 12


def heuristic_ad_regions(page_image: bytes, text: str, layout: dict | None = None):
    """Find bounded advertisement candidates from PDF geometry and text evidence.

    The image argument remains part of the old interface; detection intentionally
    uses PDF geometry supplied by ``render_and_extract`` when available.
    """
    if not layout:
        return []
    width, height = layout["page_width"], layout["page_height"]
    blocks = layout["blocks"]
    candidates = []
    for drawing in layout["drawings"]:
        box = drawing["bbox"]
        if not _plausible(box, width, height):
            continue
        contained = [block for block in blocks if _intersection(box, block["bbox"]) >= 0.5 * (
            (block["bbox"][2] - block["bbox"][0]) * (block["bbox"][3] - block["bbox"][1])
        )]
        candidate_text = " ".join(block["text"] for block in contained)
        evidence = _signals(candidate_text)
        if not evidence:
            continue
        candidates.append({
            "bbox": box,
            "evidence": evidence + ["frame" if drawing["color"] or drawing["fill"] else "border"],
            "blocks": contained,
        })
    signal_blocks = [block for block in blocks if _signals(block["text"])]
    for block in signal_blocks:
        box = _expand(block["bbox"], 10, width, height)
        nearby = [
            other for other in signal_blocks
            if other is not block
            and (
                (
                    abs(other["bbox"][0] - block["bbox"][2]) <= CONNECTOR_GAP
                    and _intersection(
                        (block["bbox"][0], block["bbox"][1], block["bbox"][2], block["bbox"][3]),
                        (block["bbox"][0], other["bbox"][1], block["bbox"][2], other["bbox"][3]),
                    ) > 0
                )
                or (
                    abs(other["bbox"][1] - block["bbox"][3]) <= CONNECTOR_GAP
                    and _intersection(
                        (block["bbox"][0], block["bbox"][1], block["bbox"][2], block["bbox"][3]),
                        (other["bbox"][0], block["bbox"][1], other["bbox"][2], block["bbox"][3]),
                    ) > 0
                )
            )
        ]
        if nearby:
            box = _union([box] + [_expand(other["bbox"], 10, width, height) for other in nearby])
        candidates.append({"bbox": box, "evidence": _signals(" ".join([block["text"]] + [item["text"] for item in nearby])), "blocks": [block] + nearby})
    results = []
    for candidate in candidates:
        box = candidate["bbox"]
        if not _plausible(box, width, height):
            continue
        evidence = list(dict.fromkeys(candidate["evidence"]))
        text_value = " ".join(block["text"] for block in candidate["blocks"])
        sizes = [size for block in candidate["blocks"] for size in block["font_sizes"] if size > 0]
        typography = len({round(size, 1) for size in sizes}) >= 2 or len({name for block in candidate["blocks"] for name in block["font_names"]}) >= 2
        if typography:
            evidence.append("typography")
        if len(evidence) == 0:
            continue
        confidence = min(0.98, 0.25 + len(evidence) * 0.12 + (0.12 if typography else 0))
        normalized = {
            "x": box[0] / width,
            "y": box[1] / height,
            "width": (box[2] - box[0]) / width,
            "height": (box[3] - box[1]) / height,
            "confidence": round(confidence, 3),
            "evidence": evidence,
            "preview": " ".join(text_value.split())[:240],
        }
        if not any(_intersection(box, other["_box"]) / max(1, min(
            (box[2] - box[0]) * (box[3] - box[1]),
            (other["_box"][2] - other["_box"][0]) * (other["_box"][3] - other["_box"][1]),
        )) > 0.85 for other in results):
            normalized["_box"] = box
            results.append(normalized)
    results.sort(key=lambda item: item["confidence"], reverse=True)
    for item in results:
        item.pop("_box", None)
    return results[:MAX_ADS_PER_PAGE]


def render_ad_crop(pdf_bytes: bytes, page_number: int, bbox: dict, dpi: int = 300, max_pixels: int = MAX_CROP_PIXELS):
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        page = doc[page_number - 1]
        rect = fitz.Rect(
            bbox["x"] * page.rect.width,
            bbox["y"] * page.rect.height,
            (bbox["x"] + bbox["width"]) * page.rect.width,
            (bbox["y"] + bbox["height"]) * page.rect.height,
        ) & page.rect
        scale = dpi / 72
        pixels = max(1, rect.width * scale) * max(1, rect.height * scale)
        if pixels > max_pixels:
            scale *= math.sqrt(max_pixels / pixels)
        pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), clip=rect, alpha=False)
        return pix.tobytes("png")
    finally:
        doc.close()
