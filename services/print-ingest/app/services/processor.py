import io
import math
import re
from collections import Counter
import fitz
from PIL import Image
import pytesseract

AD_SIGNALS = re.compile(r'(www\.|https?://|@|telefon|tel\.?|fax|€|eur|angebot|rabatt|aktion|gmbh|kg\b|e\.v\.|\.de\b)', re.I)
CONTACT_SIGNALS = re.compile(r'(?:\+?\d[\d\s()./-]{6,}\d|www\.|https?://|[\w.+-]+@[\w.-]+\.[a-z]{2,}|telefon|tel\.?|fax)', re.I)
PHONE_SIGNALS = re.compile(
    r'(?:\b(?:tel(?:efon)?|fon|ruf)\b\s*[:.]?\s*(?:\+49|0)?[\d\s()./-]{6,}\d'
    r'|(?<!\d)(?:\+49|0)\s*(?:\(?\d{2,5}\)?[\s./-]*)\d(?:[\d\s./-]{3,}\d)(?!\d))',
    re.I,
)
EMAIL_SIGNAL = re.compile(r"\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b", re.I)
WEBSITE_SIGNAL = re.compile(
    r"(?<![@\w])(?:"
    r"(?:https?://|www\.)[a-z0-9-]+(?:\.[a-z0-9-]+)+"
    r"|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:de|com|net|org|eu|info|at|ch)"
    r")(?:/[^\s<>,;)]*)?",
    re.I,
)
POSTCODE_LOCATION_SIGNAL = re.compile(
    r"\b(?P<postal_code>\d{5})\s+"
    r"(?P<city>[A-ZÄÖÜ][\wÄÖÜäöüß.-]*(?:\s+[A-ZÄÖÜ][\wÄÖÜäöüß.-]*){0,3})\b",
)
ADVERTISER_SIGNALS = re.compile(r'\b[\wÄÖÜäöüß&.-]+\s+(?:GmbH|AG|KG|e\.V\.)\b', re.I)
EDITORIAL_SIGNALS = re.compile(
    r'\b(?:impressum|herausgeber|verantwortlich|redaktion|bekanntmachung|anlage|amtliche\s+mitteilung)\b',
    re.I,
)
PUBLIC_ORIGIN_SIGNALS = re.compile(
    r'(?:\b(?:kreisverwaltung|ministerium|landesregierung|bezirksamt|'
    r'landesbehörde)\b|'
    r'\bgefördert\s+(?:von|durch)\b|'
    r'\blandes(?:mittel|verband|wappen)\b)',
    re.I,
)
DIRECTORY_SIGNALS = re.compile(
    r'\b(?:übersicht|verzeichnis|legende|stadtplan|karte|karte\s+der)\b',
    re.I,
)
MAX_ADS_PER_PAGE = 24
MAX_CROP_PIXELS = 18_000_000
MAX_OCR_REGIONS_PER_PAGE = 12


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
    if not advertiser and contact:
        title_words = [
            word.strip(".,:;·|()[]{}")
            for word in text[:contact.start()].split()
            if word.strip(".,:;·|()[]{}")[:1].isalpha()
        ]
        advertiser = sum(word[:1].isupper() for word in title_words) >= 2
    return bool(advertiser), bool(contact)


def _has_phone(text):
    return bool(PHONE_SIGNALS.search(text))


def extract_contacts(text):
    phone_match = PHONE_SIGNALS.search(text)
    phone = phone_match.group(0).strip() if phone_match else None
    if phone:
        phone = re.sub(r"^(?:tel(?:efon)?|fon|ruf)\b\s*[:.]?\s*", "", phone, flags=re.I)
    email_match = EMAIL_SIGNAL.search(text)
    website_match = WEBSITE_SIGNAL.search(text)
    location_match = POSTCODE_LOCATION_SIGNAL.search(text)
    postal_code = location_match.group("postal_code") if location_match else None
    city = location_match.group("city") if location_match else None
    return {
        "phone": phone,
        "email": email_match.group(0) if email_match else None,
        "website": website_match.group(0).rstrip(".,;:") if website_match else None,
        "postal_code": postal_code,
        "city": city,
    }


def _ocr_region_text(page_image, box, width, height):
    if not page_image:
        return ""
    try:
        with Image.open(io.BytesIO(page_image)) as image:
            x0 = max(0, min(image.width, round(box[0] / width * image.width)))
            y0 = max(0, min(image.height, round(box[1] / height * image.height)))
            x1 = max(0, min(image.width, round(box[2] / width * image.width)))
            y1 = max(0, min(image.height, round(box[3] / height * image.height)))
            if x1 <= x0 or y1 <= y0:
                return ""
            crop = image.crop((x0, y0, x1, y1))
            crop = crop.resize((crop.width * 2, crop.height * 2))
            return pytesseract.image_to_string(crop, lang="deu+eng")
    except Exception:
        return ""


def _provenance_warnings(text):
    warnings = []
    if re.search(
        r'\b(?:stadt|gemeinde|landkreis|kreisverwaltung|tourismus|tourist(?:ik)?|'
        r'bürgermeister|gemeinnützig\w*|gGmbH|e\.V\.|verein|stiftung|'
        r'rotes\s+kreuz|caritas|diakonie|awo)\b',
        text,
        re.I,
    ):
        warnings.append("provenance-uncertain")
    return warnings


def _has_strong_public_origin(text):
    return bool(re.search(r'\bgefördert\s+(?:von|durch)\b', text, re.I))


def _sender_has_strong_public_origin(text, blocks):
    if _has_strong_public_origin(text):
        return True
    prominent = " ".join(
        block.get("text", "")
        for block in blocks
        if max(block.get("font_sizes", [0])) >= 14
    )
    if not blocks:
        prominent = text
    if PUBLIC_ORIGIN_SIGNALS.search(prominent):
        return True
    return bool(re.search(
        r'\b(?:stadt|gemeinde)\b[^.]{0,60}\b(?:amt|verwaltung|behörde|seniorenberatung|kontaktbüro)\b',
        prominent,
        re.I,
    ))


def _looks_directory_or_overview(text, blocks, page_dominant=False, logo=False):
    marker_blocks = []
    for block in blocks:
        block_text = " ".join(str(block.get("text", "")).split())
        if not re.fullmatch(r"\d{1,3}(?:\s+\d{1,3})*", block_text):
            continue
        if _has_phone(block_text) or any(len(value) >= 4 for value in re.findall(r"\d+", block_text)):
            continue
        marker_blocks.append(block)
    provider_blocks = sum(
        bool(PHONE_SIGNALS.search(block.get("text", "")))
        and bool(
            re.search(
                r'\b\d{5}\s+[A-ZÄÖÜ][\wÄÖÜäöüß.-]+|'
                r'\b(?:straße|str\.|weg|platz)\b',
                block.get("text", ""),
                re.I,
            )
        )
        for block in blocks
    )
    domains = [
        domain.casefold().removeprefix("www.")
        for domain in re.findall(
            r'(?:https?://)?(?:www\.)?([\w.-]+\.[a-z]{2,})',
            text,
            re.I,
        )
    ]
    repeated_domains = {domain for domain, count in Counter(domains).items() if count >= 2}
    grouped_advertiser = (
        logo
        and (
            len(repeated_domains) == 1
            or bool(re.search(r'\b(?:unternehmensverbund|verbund)\b', text, re.I))
        )
    )
    numbered_overview = (
        len(marker_blocks) >= 6
        and (
            len(marker_blocks) >= 8
            or bool(DIRECTORY_SIGNALS.search(text))
        )
    )
    provider_list = provider_blocks >= 4 and not grouped_advertiser
    return numbered_overview or provider_list


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
        raw_box = drawing["bbox"]
        box = (
            max(0, min(width, raw_box[0])),
            max(0, min(height, raw_box[1])),
            max(0, min(width, raw_box[2])),
            max(0, min(height, raw_box[3])),
        )
        if box[2] <= box[0] or box[3] <= box[1]:
            continue
        area = (box[2] - box[0]) * (box[3] - box[1])
        if area >= page_area * 0.015 and (drawing["fill"] or drawing["color"] or drawing["width"] > 0):
            items.append((box, "frame"))
    for image in layout.get("images", []):
        raw_box = image["bbox"]
        box = (
            max(0, min(width, raw_box[0])),
            max(0, min(height, raw_box[1])),
            max(0, min(width, raw_box[2])),
            max(0, min(height, raw_box[3])),
        )
        if box[2] <= box[0] or box[3] <= box[1]:
            continue
        area = (box[2] - box[0]) * (box[3] - box[1])
        if area >= page_area * 0.02:
            items.append((box, "image"))
    return items


def _has_logo_evidence(layout, box):
    area = max(1, (box[2] - box[0]) * (box[3] - box[1]))
    for image in layout.get("images", []):
        image_box = image["bbox"]
        overlap = _intersection(box, image_box)
        image_area = max(1, (image_box[2] - image_box[0]) * (image_box[3] - image_box[1]))
        if overlap / image_area >= 0.8 and 0.005 <= image_area / area < 0.85:
            return True
    for drawing in layout.get("drawings", []):
        drawing_box = drawing["bbox"]
        if all(abs(drawing_box[index] - box[index]) <= 1 for index in range(4)):
            continue
        overlap = _intersection(box, drawing_box)
        drawing_area = max(
            1,
            (drawing_box[2] - drawing_box[0]) * (drawing_box[3] - drawing_box[1]),
        )
        if overlap / drawing_area >= 0.8 and 0.002 <= drawing_area / area < 0.85:
            return True
    return False


def _candidate_has_logo(
    layout,
    box,
    text,
    blocks,
    geometry_kind=None,
    page_dominant=False,
    allow_image_inference=False,
):
    if _has_logo_evidence(layout, box):
        return True
    advertiser, contact = _advertiser_and_contact(text, blocks)
    area = (box[2] - box[0]) * (box[3] - box[1])
    page_area = layout["page_width"] * layout["page_height"]
    return (
        allow_image_inference
        and geometry_kind == "image"
        and not page_dominant
        and area < page_area * 0.75
        and advertiser
        and contact
    )


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


def _candidate_is_ad(
    text,
    blocks,
    marked,
    page_dominant,
    max_words=None,
    logo=False,
):
    advertiser, contact = _advertiser_and_contact(text, blocks)
    standard_evidence = (
        logo
        and _has_phone(text)
        and (max_words is None or len(text.split()) <= max_words)
    )
    editorial = _looks_editorial(text, blocks, page_dominant)
    editorial_ok = (
        not editorial
        or (
            marked
            and not EDITORIAL_SIGNALS.search(text)
            and logo
            and advertiser
            and contact
        )
    )
    accepted = (
        standard_evidence
        and not _sender_has_strong_public_origin(text, blocks)
        and not _looks_directory_or_overview(text, blocks, page_dominant, logo)
        and editorial_ok
    )
    return accepted, advertiser, contact


def _add_candidate_without_nested_duplicates(results, normalized, box):
    overlapping = [
        other
        for other in results
        if _intersection(box, other["_box"]) / max(1, min(
            (box[2] - box[0]) * (box[3] - box[1]),
            (other["_box"][2] - other["_box"][0]) * (other["_box"][3] - other["_box"][1]),
        )) > 0.75
    ]
    if not overlapping:
        normalized["_box"] = box
        results.append(normalized)
        return
    new_area = (box[2] - box[0]) * (box[3] - box[1])
    if all(
        new_area > (other["_box"][2] - other["_box"][0]) * (other["_box"][3] - other["_box"][1])
        for other in overlapping
    ):
        results[:] = [other for other in results if other not in overlapping]
        normalized["_box"] = box
        results.append(normalized)


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
                if marker_box[0] <= box[0] + 40 and marker_box[1] <= box[1] + 40:
                    return True
            left_gap = box[0] - marker_box[2]
            vertical_gap = max(marker_box[1] - box[3], box[1] - marker_box[3], 0)
            if (
                0 <= left_gap <= 40
                and vertical_gap <= 40
                and marker_box[1] <= box[1] + 40
            ):
                return True
        return False

    candidates = []
    ocr_cache = {}
    ocr_calls = 0

    def enrich_with_ocr(candidate_text, box):
        nonlocal ocr_calls
        if not ocr_neighbors or len(candidate_text.split()) >= 4:
            return candidate_text
        key = tuple(round(value, 2) for value in box)
        if key not in ocr_cache:
            if ocr_calls >= MAX_OCR_REGIONS_PER_PAGE:
                return candidate_text
            ocr_calls += 1
            try:
                ocr_cache[key] = _ocr_region_text(page_image, box, width, height)
            except Exception:
                ocr_cache[key] = ""
        ocr_text = ocr_cache[key]
        if len(ocr_text.split()) > len(candidate_text.split()):
            return ocr_text
        if not _has_phone(candidate_text) and _has_phone(ocr_text):
            return ocr_text
        return candidate_text

    material = _material_geometry(layout, width, height)
    coverage = _material_coverage(material, width, height)
    large_material = [
        box
        for box, _kind in material
        if (box[2] - box[0]) * (box[3] - box[1]) >= width * height * 0.08
    ]
    ocr_neighbors = (
        bool(marking_blocks)
        and len(large_material) >= 3
        and all(
            box[0] > 5 and box[1] > 5 and box[2] < width - 5 and box[3] < height - 5
            for box in large_material
        )
    )
    dominant_material = any(
        (box[2] - box[0]) * (box[3] - box[1]) >= width * height * 0.75
        for box, _kind in material
    )
    if coverage >= 0.65 and dominant_material:
        box = _union([item[0] for item in material])
        box = (max(0, box[0]), max(0, box[1]), min(width, box[2]), min(height, box[3]))
        contained = list(blocks)
        candidate_text = " ".join(block["text"] for block in contained)
        candidate_text = enrich_with_ocr(candidate_text, box)
        if len(candidate_text.split()) < 10 and len((text or "").split()) > len(candidate_text.split()):
            candidate_text = text
        marked = bool(marking_blocks)
        accepted, _advertiser, _contact = _candidate_is_ad(
            candidate_text,
            contained,
            marked,
            True,
            max_words=180,
            logo=_candidate_has_logo(layout, box, candidate_text, contained),
        )
        if accepted:
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
        candidate_text = enrich_with_ocr(candidate_text, box)
        advertiser, contact = _advertiser_and_contact(candidate_text, contained)
        marked = marked_box(box)
        page_dominant = geometry_kind == "image" and (
            (box[2] - box[0]) * (box[3] - box[1]) >= width * height * 0.75
        )
        accepted, _advertiser, _contact = _candidate_is_ad(
            candidate_text,
            contained,
            marked,
            page_dominant,
            logo=_candidate_has_logo(
                layout,
                box,
                candidate_text,
                contained,
                geometry_kind,
                page_dominant,
                ocr_neighbors,
            ),
        )
        if not accepted:
            continue
        if not _contains_complete_lines(box, contained):
            continue
        candidates.append({
            "bbox": box,
            "geometry": geometry_kind,
            "blocks": contained,
            "page_dominant": page_dominant,
            "marked": marked,
            "text": candidate_text,
            "ocr_neighbors": ocr_neighbors,
        })
    results = []
    for candidate in candidates:
        box = candidate["bbox"]
        if not _contains_complete_lines(box, blocks):
            continue
        if not _plausible(box, width, height):
            continue
        text_value = candidate["text"]
        accepted, advertiser, contact = _candidate_is_ad(
            text_value,
            candidate["blocks"],
            candidate["marked"],
            candidate["page_dominant"],
            logo=_candidate_has_logo(
                layout,
                box,
                text_value,
                candidate["blocks"],
                candidate["geometry"],
                candidate["page_dominant"],
                candidate.get("ocr_neighbors", False),
            ),
        )
        if not accepted:
            continue
        evidence = ["geometry"]
        if advertiser:
            evidence.append("advertiser")
        if contact:
            evidence.append("contact")
        if _candidate_has_logo(
            layout,
            box,
            text_value,
            candidate["blocks"],
            candidate["geometry"],
            candidate["page_dominant"],
            candidate.get("ocr_neighbors", False),
        ):
            evidence.append("logo")
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
        evidence.extend(_provenance_warnings(text_value))
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
        _add_candidate_without_nested_duplicates(results, normalized, box)
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
