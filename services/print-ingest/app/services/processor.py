import io, math, re
import fitz
from PIL import Image
import pytesseract

AD_SIGNALS = re.compile(r'(www\.|https?://|@|telefon|tel\.?|fax|€|eur|angebot|rabatt|aktion|gmbh|kg\b|e\.v\.|\.de\b)', re.I)
CONTACT_SIGNALS = re.compile(r'(?:\+?\d[\d\s()./-]{6,}\d|www\.|https?://|[\w.+-]+@[\w.-]+\.[a-z]{2,}|telefon|tel\.?|fax)', re.I)
ADVERTISER_SIGNALS = re.compile(r'\b[\wÄÖÜäöüß&.-]+\s+(?:GmbH|AG|KG|e\.V\.)\b', re.I)
EDITORIAL_SIGNALS = re.compile(
    r'\b(?:impressum|herausgeber|verantwortlich|redaktion|bekanntmachung|anlage|amtliche\s+mitteilung)\b',
    re.I,
)
COMMERCIAL_SIGNALS = re.compile(
    r'\b(?:hotel|shop|taxi|ticket|verleih|mieten|übernacht\w*|ferien\w*|restaurant|'
    r'öffnungszeiten|onlineshop|online-shop|buchung|reserv\w*)\b',
    re.I,
)
DIRECT_CONTACT_SIGNALS = re.compile(
    r'(?:\+?\d[\d\s()./-]{6,}\d|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b\d{5}\b|\b(?:straße|str\.|weg|platz)\b)',
    re.I,
)
MAX_ADS_PER_PAGE = 24
MAX_CROP_PIXELS = 18_000_000
CONNECTOR_GAP = 72


def _layout_for_page(page):
    blocks = []
    for block in page.get_text("dict").get("blocks", []):
        if block.get("type") != 0:
            continue
        lines = []
        for line in block.get("lines", []):
            spans = [span for span in line.get("spans", []) if str(span.get("text", "")).strip()]
            line_text = " ".join(str(span.get("text", "")).strip() for span in spans).strip()
            if line_text:
                lines.append({
                    "bbox": tuple(float(value) for value in line["bbox"]),
                    "text": line_text,
                    "font_sizes": [float(span.get("size", 0)) for span in spans],
                    "font_names": [str(span.get("font", "")) for span in spans],
                })
        spans = [span for line in lines for span in line.get("spans", [])]
        text = " ".join(str(span.get("text", "")).strip() for span in spans).strip()
        if lines:
            blocks.append({
                "bbox": tuple(float(value) for value in block["bbox"]),
                "text": " ".join(line["text"] for line in lines),
                "font_sizes": [size for line in lines for size in line["font_sizes"]],
                "font_names": [name for line in lines for name in line["font_names"]],
                "lines": lines,
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
    images = [
        {"bbox": tuple(float(value) for value in block["bbox"])}
        for block in page.get_text("dict").get("blocks", [])
        if block.get("type") == 1 and block.get("bbox")
    ]
    for image in page.get_images(full=True):
        for rect in page.get_image_rects(image[0]):
            bbox = (float(rect.x0), float(rect.y0), float(rect.x1), float(rect.y1))
            if bbox not in [item["bbox"] for item in images]:
                images.append({"bbox": bbox})
    return {
        "page_width": float(page.rect.width),
        "page_height": float(page.rect.height),
        "blocks": blocks,
        "drawings": drawings,
        "images": images,
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


def _line_boxes(block):
    return [line["bbox"] for line in block.get("lines", [])] or [block["bbox"]]


def _is_publisher_marking(text):
    return str(text).strip().casefold() in {
        "anzeige",
        "anzeigen",
        "werbeanzeige",
        "werbeanzeigen",
    }


def _contains_complete_lines(box, blocks):
    return all(
        line[0] >= box[0] - 1 and line[1] >= box[1] - 1
        and line[2] <= box[2] + 1 and line[3] <= box[3] + 1
        for block in blocks
        for line in _line_boxes(block)
        if _intersection(box, line) > 0
    )


def _advertiser_and_contact(text, blocks):
    contact = CONTACT_SIGNALS.search(text)
    advertiser = ADVERTISER_SIGNALS.search(text)
    if not advertiser and contact:
        before_contact = text[:contact.start()].split()
        advertiser = len(before_contact) >= 2 and all(
            word[:1].isupper() or word.isupper()
            for word in before_contact[:2]
            if word[:1].isalpha()
        )
    if not advertiser:
        for block in blocks:
            words = block["text"].split()
            if 1 < len(words) <= 6 and all(
                word[:1].isupper() or word.isupper() for word in words if word[:1].isalpha()
            ):
                advertiser = True
                break
    if not advertiser and contact:
        title_words = [
            word.strip(".,:;·|()[]{}")
            for word in text.split()
            if word.strip(".,:;·|()[]{}")[:1].isupper()
        ]
        advertiser = len(title_words) >= 2 and len(text.split()) <= 24
    return bool(advertiser), bool(contact)


def _has_commercial_identity(text):
    return bool(ADVERTISER_SIGNALS.search(text) or COMMERCIAL_SIGNALS.search(text))


def _has_direct_contact(text):
    return bool(DIRECT_CONTACT_SIGNALS.search(text))


def _looks_editorial(text, blocks, page_dominant=False):
    if EDITORIAL_SIGNALS.search(text):
        return True
    words = text.split()
    lines = [line for block in blocks for line in _line_boxes(block)]
    sizes = [size for block in blocks for size in block["font_sizes"] if size > 0]
    uniform = bool(sizes) and max(sizes) / max(1, min(sizes)) < 1.3
    hyphenated = any(block["text"].rstrip().endswith(("-", "­")) for block in blocks)
    if not page_dominant and len(words) > 80 and len(lines) >= 6:
        return True
    return not page_dominant and len(words) > 55 and len(lines) >= 5 and uniform and hyphenated


def _material_geometry(layout, width, height):
    page_area = width * height
    items = []
    for drawing in layout["drawings"]:
        box = drawing["bbox"]
        area = (box[2] - box[0]) * (box[3] - box[1])
        if area >= page_area * 0.015 and (drawing["fill"] or drawing["color"] or drawing["width"] > 0):
            items.append((box, "frame"))
    for image in layout.get("images", []):
        box = image["bbox"]
        area = (box[2] - box[0]) * (box[3] - box[1])
        if area >= page_area * 0.02:
            items.append((box, "image"))
    return items


def _material_coverage(items, width, height):
    if not items:
        return 0
    covered = 0
    columns = rows = 20
    for row in range(rows):
        for column in range(columns):
            cell = (
                width * column / columns,
                height * row / rows,
                width * (column + 1) / columns,
                height * (row + 1) / rows,
            )
            if any(_intersection(cell, box) >= (cell[2] - cell[0]) * (cell[3] - cell[1]) * 0.25
                   for box, _kind in items):
                covered += 1
    return covered / (rows * columns)


def _plausible(box, width, height):
    area = max(0, box[2] - box[0]) * max(0, box[3] - box[1])
    page_area = width * height
    ratio = (box[2] - box[0]) / max(1, box[3] - box[1])
    return area >= page_area * 0.003 and area <= page_area and 0.08 <= ratio <= 12


def heuristic_ad_regions(page_image: bytes, text: str, layout: dict | None = None):
    """Find bounded advertisement candidates from PDF geometry and text evidence.

    The image argument remains part of the old interface; detection intentionally
    uses PDF geometry supplied by ``render_and_extract`` when available.
    """
    if not layout:
        return []
    width, height = layout["page_width"], layout["page_height"]
    blocks = layout["blocks"]
    marking_blocks = [block for block in blocks if _is_publisher_marking(block["text"])]

    def marked_box(box):
        for marker in marking_blocks:
            marker_box = marker["bbox"]
            if _intersection(box, marker_box) > 0:
                return True
            left_gap = box[0] - marker_box[2]
            if 0 <= left_gap <= 16 and marker_box[1] < box[3] and marker_box[3] > box[1]:
                return True
        return False

    candidates = []
    material = _material_geometry(layout, width, height)
    coverage = _material_coverage(material, width, height)
    dominant_material = any(
        (box[2] - box[0]) * (box[3] - box[1]) >= width * height * 0.75
        for box, _kind in material
    )
    if coverage >= 0.65 and (dominant_material or (marking_blocks and len(blocks) <= 12)):
        box = _union([item[0] for item in material])
        box = (max(0, box[0]), max(0, box[1]), min(width, box[2]), min(height, box[3]))
        contained = list(blocks)
        candidate_text = " ".join(block["text"] for block in contained)
        if len(candidate_text.split()) < 10 and len((text or "").split()) > len(candidate_text.split()):
            candidate_text = text
        advertiser, contact = _advertiser_and_contact(candidate_text, contained)
        marked = bool(marking_blocks)
        if (marked or (
            advertiser and contact and _has_commercial_identity(candidate_text)
            and (ADVERTISER_SIGNALS.search(candidate_text) or _has_direct_contact(candidate_text))
            and len(candidate_text.split()) <= 180
        )) and (marked or advertiser) and (marked or not _looks_editorial(candidate_text, contained, True)):
            if marked:
                box = (0, 0, width, height)
            candidates.append({
                "bbox": box,
                "geometry": "page",
                "blocks": contained,
                "page_dominant": True,
                "marked": marked,
                "text": candidate_text,
            })
    for box, geometry_kind in material:
        if not _plausible(box, width, height):
            continue
        contained = [block for block in blocks if _intersection(box, block["bbox"]) >= 0.5 * (
            (block["bbox"][2] - block["bbox"][0]) * (block["bbox"][3] - block["bbox"][1])
        )]
        candidate_text = " ".join(block["text"] for block in contained)
        advertiser, contact = _advertiser_and_contact(candidate_text, contained)
        marked = marked_box(box)
        page_dominant = geometry_kind == "image" and (
            (box[2] - box[0]) * (box[3] - box[1]) >= width * height * 0.75
        )
        material_area = (box[2] - box[0]) * (box[3] - box[1])
        marked_only = marked and material_area >= width * height * 0.03
        if not marked_only and (
            not advertiser or not contact or not _has_commercial_identity(candidate_text)
            or (not ADVERTISER_SIGNALS.search(candidate_text) and not _has_direct_contact(candidate_text))
        ):
            continue
        if not _contains_complete_lines(box, contained):
            continue
        if not marked_only and _looks_editorial(candidate_text, contained, page_dominant):
            continue
        candidates.append({
            "bbox": box,
            "geometry": geometry_kind,
            "blocks": contained,
            "page_dominant": page_dominant,
            "marked": marked,
            "text": candidate_text,
        })
    results = []
    for candidate in candidates:
        box = candidate["bbox"]
        if not _contains_complete_lines(box, blocks):
            continue
        if not _plausible(box, width, height):
            continue
        text_value = candidate["text"]
        advertiser, contact = _advertiser_and_contact(text_value, candidate["blocks"])
        if not candidate["marked"] and (
            not advertiser or not contact or not _has_commercial_identity(text_value)
            or (not ADVERTISER_SIGNALS.search(text_value) and not _has_direct_contact(text_value))
        ):
            continue
        evidence = ["geometry"]
        if advertiser:
            evidence.append("advertiser")
        if contact:
            evidence.append("contact")
        if candidate["marked"]:
            evidence.append("publisher-marking")
        if candidate["page_dominant"]:
            evidence.append("page-dominant")
        sizes = [size for block in candidate["blocks"] for size in block["font_sizes"] if size > 0]
        typography = len({round(size, 1) for size in sizes}) >= 2 or len({name for block in candidate["blocks"] for name in block["font_names"]}) >= 2
        if typography:
            evidence.append("typography")
        whitespace = box[0] > 5 and box[1] > 5 and box[2] < width - 5 and box[3] < height - 5
        if whitespace:
            evidence.append("whitespace")
        confidence = min(0.98, 0.45 + len(evidence) * 0.1)
        normalized = {
            "x": box[0] / width,
            "y": box[1] / height,
            "width": (box[2] - box[0]) / width,
            "height": (box[3] - box[1]) / height,
            "confidence": round(confidence, 3),
            "evidence": evidence,
            "preview": " ".join(text_value.split())[:240],
        }
        duplicate = next((other for other in results if _intersection(box, other["_box"]) / max(1, min(
            (box[2] - box[0]) * (box[3] - box[1]),
            (other["_box"][2] - other["_box"][0]) * (other["_box"][3] - other["_box"][1]),
        )) > 0.75), None)
        if duplicate is None:
            normalized["_box"] = box
            results.append(normalized)
        elif (box[2] - box[0]) * (box[3] - box[1]) > (
            duplicate["_box"][2] - duplicate["_box"][0]
        ) * (duplicate["_box"][3] - duplicate["_box"][1]):
            results.remove(duplicate)
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
