import io
import math
import re
from collections import Counter
from statistics import median
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
    r"(?<![@\w.])(?:"
    r"(?:https?://|www\.)[a-z0-9-]+(?:\.[a-z0-9-]+)+"
    r"|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:de|com|net|org|eu|info|at|ch)\b"
    r")(?:/[^\s<>,;)]*)?",
    re.I,
)
POSTCODE_LOCATION_SIGNAL = re.compile(
    r"\b(?P<postal_code>\d{5})\s+"
    r"(?P<city>[A-ZÄÖÜ][\wÄÖÜäöüß.-]*(?:\s+[A-ZÄÖÜ][\wÄÖÜäöüß.-]*){0,2})\b",
)
LOCATION_STOPWORDS = {
    "tel",
    "telefon",
    "fon",
    "fax",
    "foto",
    "e-mail",
    "mail",
    "öffnungszeiten",
    "internet",
    "web",
    "t",
    "f",
    "m",
    "ihr",
    "ihre",
    "unser",
    "unsere",
    "wir",
}
ADVERTISER_SIGNALS = re.compile(r'\b[\wÄÖÜäöüß&.-]+\s+(?:GmbH|AG|KG|e\.V\.)\b', re.I)
EDITORIAL_SIGNALS = re.compile(
    r'\b(?:impressum|herausgeber|verantwortlich|redaktion|bekanntmachung|anlage|amtliche\s+mitteilung|'
    r'bericht|rückblick|vorschau|einladung|lädt\s+ein|veranstaltung|veranstaltungsreihe|programm|'
    r'sprechstunde|tagesordnung|protokoll|jahreshauptversammlung|generalversammlung|kermversammlung|'
    r'wir\s+informieren|informationen\s+zu|satzung|datenschutz|anmeldung\s+erforderlich)\b',
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
COMMERCIAL_INDUSTRIES = (
    "Bäckerei", "Konditorei", "Metzgerei", "Gärtnerei", "Baumschule", "Hofladen",
    "Weingut", "Winzer", "Restaurant", "Gasthof", "Gaststätte", "Café", "Pension",
    "Hotel", "Dachdecker", "Spenglerei", "Bauspenglerei", "Flaschnerei", "Zimmerei", "Schreinerei", "Fliesen",
    "Maler", "Verputzer", "Stuckateur", "Elektro", "Sanitär", "Heizung", "Küchen",
    "Möbel", "Autohaus", "Kfz", "Reifen", "Tiefbau", "Erdbau", "Transporte",
    "Kiesgrube", "Entsorgung", "Naturstein", "Steinmetz", "Grabmal", "Grabmale", "Grabdenkmäler", "Bestattung",
    "Sanitätshaus",
    "Floristik", "Florist", "Blumen", "Pflanzen", "Gartenbau", "Gartengestaltung",
    "Photovoltaik", "Solar", "Stromspeicher", "Wallbox", "Elektrotechnik", "Energietechnik",
    "Getränke", "Brunnen", "Brauerei", "Pflegedienst", "Pflege zu Hause",
    "Seniorenbetreuung", "Tagespflege", "Pflegeheim", "Seniorenzentrum", "Physiotherapie", "Fußpflege",
    "Podologie", "Kosmetik", "Friseur", "Apotheke", "Optiker", "Hörgeräte",
    "Schuhhaus", "Orthopädie", "Direktvertrieb", "Küchenstudio", "Malerbetrieb",
    "Heizungsbau", "Bauunternehmen", "Getränkemarkt", "Hörakustik", "Zahntechnik", "Bauträger",
    "Garten- und Landschaftsbau", "Steuerberater", "Rechtsanwalt", "Notar", "Versicherung", "Sparkasse",
    "Volksbank", "Raiffeisenbank", "Stadtwerke", "Energieversorger", "Immobilien",
    "Reisedienst", "Busunternehmen", "Fahrschule", "Werbeagentur", "Druckerei",
    "Schlüsseldienst", "Kunstschmiede", "Meisterbetrieb", "Fachhandel", "Fachbetrieb",
    "Taxi", "Taxiunternehmen", "Mietwagen", "Autovermietung", "Reisen", "Rundfahrten",
    "Tours", "Omnibus", "Bäcker", "Metzger", "Gärtner", "Raumausstatter", "Polsterei",
    "Glaserei", "Schlosserei", "Landmaschinen", "Baustoffe", "Zahnarzt", "Tierarzt",
    "Heilpraktiker",
)
_LEGAL_FORM_PATTERN = re.compile(
    r"\b(?:GmbH|AG|KG|OHG|GbR|mbH|e\.K\.|UG)\b|&\s*Co\b",
    re.I,
)
_PUBLIC_SENDER_PATTERN = re.compile(
    r"\b(?:stadt|gemeinde|marktgemeinde|markt\s+\w+|verwaltungsgemeinschaft|landkreis|"
    r"landratsamt|bezirk|regierung\s+von|amt|amtsgericht|rathaus|bürgermeister|"
    r"bürgerservice|bürgerbüro|einwohnermeldeamt|ordnungsamt|standesamt|jugendamt|"
    r"sozialamt|beirat|ausländerbeirat|beratungsstelle|pflegestützpunkt|umweltstation|"
    r"stadtbücherei|stadtbibliothek|kreisjugendring|polizei|freiwillige\s+feuerwehr|"
    r"bauhof|kindergarten|kita|grundschule|mittelschule|realschule|gymnasium|"
    r"uniklinik|universitätsklinikum)\b",
    re.I,
)
_CHURCH_SENDER_PATTERN = re.compile(
    r"\b(?:pfarrei|pfarreiengemeinschaft|pfarrgemeinde|kirchengemeinde|pfarramt|pfarrer|"
    r"dekanat|wallfahrt|kath\.?|katholische|evang\.?|evangelische)\b",
    re.I,
)
_ASSOCIATION_PATTERN = re.compile(
    r"\b(?:e\.V\.|verein|fanclub|gesangverein|schützenverein|turnverein|sportverein|"
    r"(?-i:FC|TSV|SV|DJK|MGV)|landfrauen|kolping|vdk|jugendtreff)\b",
    re.I,
)
_PUBLISHER_PROMOTION_PATTERN = re.compile(
    r"\b(?:anzeigenschluss|anzeigenannahme|anzeigenauftrag|anzeigenpreisliste|mediadaten|"
    r"redaktionsschluss|nächste\s+ausgabe|erscheint\s+am|auflage|sepa[-\s]?lastschriftmandat)\b",
    re.I,
)
_DIRECTORY_LABELS = (
    "Kontaktdaten", "Kontaktzeiten", "Öffnungszeiten", "Sprechzeiten", "Sprechstunde",
    "Ansprechpartner", "Vorstand", "Vereinsziele", "Treffpunkt", "Homepage", "Angebote",
    "Förderschwerpunkte", "Hinweise", "Örtliche Einschränkung",
)
_DIRECTORY_LABEL_PATTERN = re.compile(
    r"^\s*(?:" + "|".join(re.escape(value) for value in _DIRECTORY_LABELS) + r")\s*:",
    re.I,
)
_JOB_PATTERN = re.compile(
    r"\(\s*m\s*/\s*w(?:\s*/\s*d)?\s*\)|\bsucht\s+zum\s+nächstmöglichen\b|"
    r"\bbewerbung\b|\bvollzeit\b|\bteilzeit\b|\btvöd\b|\bausbildungsplatz\b|"
    r"\bstellenangebot\b|\bwir\s+bilden\b",
    re.I,
)
_CHARITY_PATTERN = re.compile(
    r"\b(?:ggmbh|gemeinnützig\w*|caritas|diakonie|awo|rotes\s+kreuz|drk|malteser|"
    r"johanniter|stiftung)\b",
    re.I,
)
_AD_INTENT_PATTERN = re.compile(
    r"\b(?:wir\s+bieten|unser\s+angebot|angebot|aktion|rabatt|jetzt\s+wechseln|jetzt|"
    r"öffnungszeiten|verkauf|ausstellung|beratung|service|leistungen|meisterbetrieb|"
    r"fachhandel|seit\s+\d{4})\b|[%€]",
    re.I,
)
_GREETING_PATTERN = re.compile(
    r"\b(?:wir\s+wünschen|frohe\s+weihnachten|guten\s+rutsch|frohe\s+ostern|"
    r"danke\s+für\s+ihr\s+vertrauen)\b",
    re.I,
)


def sanitize_extracted_text(text: str) -> str:
    return "".join(
        character
        for character in text
        if character != "\x00" and not 0xD800 <= ord(character) <= 0xDFFF
    )


def _layout_for_page(page):
    blocks = []
    for block in page.get_text("dict").get("blocks", []):
        if block.get("type") != 0:
            continue
        lines = []
        for line in block.get("lines", []):
            spans = [span for span in line.get("spans", []) if str(span.get("text", "")).strip()]
            line_text = sanitize_extracted_text(
                " ".join(str(span.get("text", "")).strip() for span in spans).strip(),
            )
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
        text=sanitize_extracted_text(page.get_text('text') or '')
        title_candidates = []
        for block in page.get_text('dict').get('blocks', []):
            for line in block.get('lines', []):
                spans = line.get('spans', [])
                line_text = sanitize_extracted_text(
                    ' '.join(str(span.get('text', '')).strip() for span in spans).strip(),
                )
                if line_text:
                    title_candidates.append({
                        'text': line_text,
                        'size': max(float(span.get('size', 0)) for span in spans),
                    })
        pix=page.get_pixmap(matrix=mat, alpha=False)
        img_bytes=pix.tobytes('png')
        if len(text.strip()) < 20:
            try:
                text=sanitize_extracted_text(
                    pytesseract.image_to_string(
                        Image.open(io.BytesIO(img_bytes)), lang='deu+eng',
                    ),
                )
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


def _extract_location_candidate(match):
    city_words = []
    last_word_end = None
    for word_match in re.finditer(r"\S+", match.group("city")):
        word = word_match.group(0)
        normalized_word = word.strip(".,:;·|()[]{}").casefold()
        if normalized_word in LOCATION_STOPWORDS:
            break
        city_words.append(word)
        last_word_end = word_match.end()
    if not city_words or last_word_end is None:
        return None
    return {
        "postal_code": match.group("postal_code"),
        "city": " ".join(city_words),
        "span": (
            match.start("postal_code"),
            match.start("city") + last_word_end,
        ),
    }


def extract_contacts(text):
    phone_match = PHONE_SIGNALS.search(text)
    phone = phone_match.group(0).strip() if phone_match else None
    if phone:
        phone = re.sub(r"^(?:tel(?:efon)?|fon|ruf)\b\s*[:.]?\s*", "", phone, flags=re.I)
    email_matches = list(EMAIL_SIGNAL.finditer(text))
    email_match = email_matches[0] if email_matches else None
    email_spans = [match.span() for match in email_matches]
    website_match = next(
        (
            match
            for match in WEBSITE_SIGNAL.finditer(text)
            if not any(
                match.start() < end and match.end() > start
                for start, end in email_spans
            )
        ),
        None,
    )
    phone_spans = [match.span() for match in PHONE_SIGNALS.finditer(text)]
    location_match = None
    for raw_location_match in POSTCODE_LOCATION_SIGNAL.finditer(text):
        candidate = _extract_location_candidate(raw_location_match)
        if candidate is None:
            continue
        start, end = candidate["span"]
        if any(start < phone_end and end > phone_start for phone_start, phone_end in phone_spans):
            continue
        location_match = candidate
        break
    postal_code = location_match["postal_code"] if location_match else None
    city = location_match["city"] if location_match else None
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
    return numbered_overview


def _looks_editorial(text, blocks):
    if EDITORIAL_SIGNALS.search(text):
        return True
    words = text.split()
    lines = [line for block in blocks for line in _line_boxes(block)]
    sizes = [size for block in blocks for size in block["font_sizes"] if size > 0]
    uniform = bool(sizes) and max(sizes) / max(1, min(sizes)) < 1.3
    hyphenated = any(block["text"].rstrip().endswith(("-", "­")) for block in blocks)
    if len(words) > 130 and len(lines) >= 5:
        return True
    return len(words) > 80 and len(lines) >= 6 and uniform and hyphenated


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


def _candidate_lines(blocks, text):
    lines = [
        str(line.get("text", "")).strip()
        for block in blocks
        for line in block.get("lines", [])
        if str(line.get("text", "")).strip()
    ]
    return lines or [line.strip() for line in str(text).splitlines() if line.strip()]


def _normalize_spaced_letters(text):
    pattern = re.compile(
        r"(?<!\w)(?:[A-Za-zÄÖÜäöüß]\s+){3,}[A-Za-zÄÖÜäöüß](?!\w)"
    )
    return pattern.sub(lambda match: re.sub(r"\s+", "", match.group(0)), str(text))


def _prominent_sender_text(text, blocks, page_blocks=None):
    all_sizes = [
        size
        for block in (page_blocks or blocks)
        for size in block.get("font_sizes", [])
        if size > 0
    ]
    candidate_sizes = [
        size
        for block in blocks
        for size in block.get("font_sizes", [])
        if size > 0
    ]
    if not candidate_sizes:
        return _normalize_spaced_letters(text)
    if not all_sizes:
        return _normalize_spaced_letters(" ".join(
            block.get("text", "")
            for block in blocks
            if max(block.get("font_sizes", [0])) >= 1.2 * median(candidate_sizes)
        ) or text)
    threshold = 1.2 * median(all_sizes)
    prominent = " ".join(
        block.get("text", "")
        for block in blocks
        if max(block.get("font_sizes", [0])) >= threshold
    )
    return _normalize_spaced_letters(prominent or text)


def _has_named_sender(text):
    words = [
        word.strip(".,:;·|()[]{}")
        for word in str(text).split()
        if word.strip(".,:;·|()[]{}")[:1].isalpha()
    ]
    return sum(word[:1].isupper() or word.isupper() for word in words) >= 2


def _has_commercial_sender(text):
    normalized = _normalize_spaced_letters(text)
    return bool(_LEGAL_FORM_PATTERN.search(normalized) or _industry_match(normalized))


def _industry_match(text):
    normalized = _normalize_spaced_letters(text)
    tokens = [token.casefold() for token in normalized.split()]
    for industry in COMMERCIAL_INDUSTRIES:
        parts = industry.casefold().split()
        if len(parts) == 1 and any(parts[0] in token for token in tokens):
            return True
        if len(parts) > 1:
            for index in range(len(tokens) - len(parts) + 1):
                if all(part in tokens[index + offset] for offset, part in enumerate(parts)):
                    return True
    return False


def _p1_reason(text, blocks, page_blocks=None):
    normalized_text = _normalize_spaced_letters(text)
    prominent = _prominent_sender_text(normalized_text, blocks, page_blocks)
    if _LEGAL_FORM_PATTERN.search(prominent) or _LEGAL_FORM_PATTERN.search(normalized_text):
        return "p1a"
    if _industry_match(normalized_text):
        return "p1b"
    if not blocks:
        return None
    page_sizes = [
        size
        for block in (page_blocks or blocks)
        for size in block.get("font_sizes", [])
        if size > 0
    ]
    if not page_sizes:
        return None
    largest = max(
        blocks,
        key=lambda block: max(block.get("font_sizes", [0])),
        default=None,
    )
    if largest is None:
        return None
    largest_size = max(largest.get("font_sizes", [0]))
    sender = _normalize_spaced_letters(largest.get("text", ""))
    words = sender.split()
    veto_text = (
        _PUBLIC_SENDER_PATTERN.search(sender)
        or _CHURCH_SENDER_PATTERN.search(sender)
        or _ASSOCIATION_PATTERN.search(sender)
        or _PUBLISHER_PROMOTION_PATTERN.search(sender)
        or EDITORIAL_SIGNALS.search(sender)
        or _JOB_PATTERN.search(sender)
        or _CHARITY_PATTERN.search(sender)
    )
    if (
        largest_size >= 1.4 * median(page_sizes)
        and 1 <= len(words) <= 6
        and not veto_text
        and not PHONE_SIGNALS.search(sender)
        and not re.fullmatch(r"[\d\s./()+-]+", sender)
    ):
        return "p1c"
    return None


def _has_ad_intent(text):
    normalized = _normalize_spaced_letters(text)
    return bool(_AD_INTENT_PATTERN.search(normalized) or (
        _GREETING_PATTERN.search(normalized)
        and _has_commercial_sender(normalized)
    ))


def _directory_blocks(blocks):
    return sum(
        bool(PHONE_SIGNALS.search(block.get("text", "")) or EMAIL_SIGNAL.search(block.get("text", "")))
        and _has_named_sender(block.get("text", ""))
        for block in blocks
    )


def _domain_root(value):
    labels = value.casefold().strip(".").split(".")
    return ".".join(labels[-2:]) if len(labels) >= 2 else value.casefold()


def _sender_key(text, blocks, page_blocks=None):
    sender = _prominent_sender_text(text, blocks, page_blocks)
    sender = re.sub(
        r"(?:https?://)?(?:www\.)?[\w.-]+\.[a-z]{2,}",
        "",
        sender,
        flags=re.I,
    )
    sender = re.split(r"\b(?:telefon|tel\.?|fax|fon|mobil|www\.)\b", sender, maxsplit=1, flags=re.I)[0]
    return " ".join(sender.split()).casefold()


def _distinct_sender_count(blocks, page_blocks=None, candidate_text=""):
    if re.search(r"\b(?:unternehmensverbund|unternehmensgruppe|firmenverbund|verbund)\b", candidate_text, re.I):
        return 1
    senders = set()
    for block in blocks:
        text = _normalize_spaced_letters(block.get("text", ""))
        if not CONTACT_SIGNALS.search(text):
            continue
        reason = _p1_reason(text, [block], page_blocks)
        if not reason:
            continue
        domains = re.findall(
            r"(?:https?://)?(?:www\.)?([\w.-]+\.[a-z]{2,})",
            text,
            re.I,
        )
        sender = (
            _domain_root(domains[0])
            if domains
            else _sender_key(text, [block], page_blocks)
        )
        sender = re.sub(r"\b(?:telefon|tel\.?|fax|fon|www\.)\b.*$", "", sender, flags=re.I)
        sender = " ".join(sender.split()).casefold()
        if sender:
            senders.add(sender)
    return len(senders)


def _label_line_count(blocks, text):
    return sum(
        bool(_DIRECTORY_LABEL_PATTERN.match(line))
        for line in _candidate_lines(blocks, text)
    )


def _phone_count(text):
    return len(list(PHONE_SIGNALS.finditer(text)))


def _typography_satisfies(blocks, page_blocks=None):
    sizes = [size for block in blocks for size in block.get("font_sizes", []) if size > 0]
    page_sizes = [
        size
        for block in (page_blocks or blocks)
        for size in block.get("font_sizes", [])
        if size > 0
    ]
    return (
        len({round(size, 1) for size in sizes}) >= 2
        and bool(sizes)
        and bool(page_sizes)
        and max(sizes) >= 1.4 * median(page_sizes)
    )


def _classification_reasons(
    text,
    blocks,
    marked=False,
    page_dominant=False,
    logo=False,
    page_blocks=None,
    geometry_ratio=None,
    cluster_count=1,
):
    prominent = _prominent_sender_text(text, blocks, page_blocks)
    public_sender = bool(_PUBLIC_SENDER_PATTERN.search(prominent))
    church_sender = bool(_CHURCH_SENDER_PATTERN.search(prominent))
    association_sender = bool(_ASSOCIATION_PATTERN.search(prominent))
    charity_sender = bool(_CHARITY_PATTERN.search(prominent))
    job_signal = bool(_JOB_PATTERN.search(text))
    p1_reason = _p1_reason(text, blocks, page_blocks)
    p1a_or_b = p1_reason in {"p1a", "p1b"}
    p1 = bool(p1_reason)
    p2 = _has_ad_intent(text)
    p3 = bool(CONTACT_SIGNALS.search(text))
    p4 = bool(logo or _typography_satisfies(blocks, page_blocks))
    normalized_text = _normalize_spaced_letters(text)

    if geometry_ratio is not None and geometry_ratio >= 0.55:
        allowed = marked and len(text.split()) <= 120 and cluster_count == 1
        if not allowed:
            return "non_commercial", ["veto:ganzseite"]
    if cluster_count >= 2:
        return "non_commercial", ["veto:mehrfachschnitt"]
    if _PUBLISHER_PROMOTION_PATTERN.search(text):
        return "non_commercial", ["veto:verlag"]
    if public_sender or _has_strong_public_origin(normalized_text) or PUBLIC_ORIGIN_SIGNALS.search(prominent):
        if job_signal:
            return "non_commercial", ["veto:behoerde", "veto:stellenanzeige"]
        return "non_commercial", ["veto:behoerde"]
    if church_sender:
        if job_signal:
            return "non_commercial", ["veto:kirche", "veto:stellenanzeige"]
        return "non_commercial", ["veto:kirche"]
    if association_sender and not (p1 and p2):
        return "non_commercial", ["veto:verein"]
    distinct_senders = _distinct_sender_count(blocks, page_blocks, normalized_text)
    if distinct_senders >= 3 or (
        _label_line_count(blocks, normalized_text) >= 3
        and not p1a_or_b
    ):
        return "non_commercial", ["veto:verzeichnis"]
    hard_editorial = bool(EDITORIAL_SIGNALS.search(normalized_text))
    prose_editorial = _looks_editorial(normalized_text, blocks)
    if hard_editorial or (
        prose_editorial
        and not (
            p1a_or_b
            and p3
            and logo
        )
    ):
        return "non_commercial", ["veto:redaktion"]
    if job_signal:
        return "unclear", ["unclear:stellenanzeige"]
    if charity_sender:
        return "unclear", ["unclear:traeger"]
    if not p1:
        return "non_commercial", ["fehlend:absender"]
    if p1_reason == "p1c" and not p2:
        return "non_commercial", ["fehlend:werbeabsicht"]
    for value, reason in (
        (p3, "fehlend:kontakt"),
        (p4, "fehlend:gestaltung"),
    ):
        if not value:
            return "non_commercial", [reason]
    if association_sender:
        return "unclear", ["unclear:verein"]
    return "company_ad", [
        f"positiv:{p1_reason}",
        *([] if p1_reason != "p1c" else ["positiv:p2"]),
        "positiv:p3",
        "positiv:p4",
    ]


def classify_ad_candidate(
    text,
    blocks,
    marked=False,
    page_dominant=False,
    logo=False,
    page_blocks=None,
    geometry_ratio=None,
    cluster_count=1,
):
    """Classify a bounded candidate as a commercial ad or non-ad content."""
    classification, reasons = _classification_reasons(
        text,
        blocks,
        marked=marked,
        page_dominant=page_dominant,
        logo=logo,
        page_blocks=page_blocks,
        geometry_ratio=geometry_ratio,
        cluster_count=cluster_count,
    )
    return {"classification": classification, "reasons": reasons}


def _blocks_are_clustered(first, second, max_gap=8):
    a, b = first["bbox"], second["bbox"]
    horizontal_overlap = min(a[2], b[2]) - max(a[0], b[0])
    vertical_overlap = min(a[3], b[3]) - max(a[1], b[1])
    vertical_gap = max(a[1], b[1]) - min(a[3], b[3])
    horizontal_gap = max(a[0], b[0]) - min(a[2], b[2])
    return (
        horizontal_overlap > 0 and vertical_gap < max_gap
    ) or (
        vertical_overlap > 0 and horizontal_gap < max_gap
    ) or _intersection(a, b) > 0


def _sender_clusters(box, blocks, page_blocks=None):
    if len(blocks) < 2:
        return []
    all_text = _normalize_spaced_letters(" ".join(block.get("text", "") for block in blocks))
    if re.search(r"\b(?:unternehmensverbund|unternehmensgruppe|firmenverbund|verbund)\b", all_text, re.I):
        return []
    domains = [
        _domain_root(domain)
        for domain in re.findall(
            r"(?:https?://)?(?:www\.)?([\w.-]+\.[a-z]{2,})",
            all_text,
            re.I,
        )
    ]
    if domains and len(set(domains)) == 1:
        return []
    groups = []
    remaining = set(range(len(blocks)))
    while remaining:
        index = remaining.pop()
        group = {index}
        changed = True
        while changed:
            changed = False
            for other in list(remaining):
                if any(_blocks_are_clustered(blocks[member], blocks[other]) for member in group):
                    group.add(other)
                    remaining.remove(other)
                    changed = True
        grouped_blocks = [blocks[index] for index in sorted(group)]
        grouped_text = " ".join(block.get("text", "") for block in grouped_blocks)
        prominent = _prominent_sender_text(grouped_text, grouped_blocks, page_blocks)
        if _has_commercial_sender(prominent) and bool(CONTACT_SIGNALS.search(grouped_text)):
            grouped_box = _union([block["bbox"] for block in grouped_blocks])
            clipped_box = (
                max(box[0], grouped_box[0]),
                max(box[1], grouped_box[1]),
                min(box[2], grouped_box[2]),
                min(box[3], grouped_box[3]),
            )
            if clipped_box[2] > clipped_box[0] and clipped_box[3] > clipped_box[1]:
                groups.append((clipped_box, grouped_blocks))
    return groups


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
        clusters = _sender_clusters(box, contained, blocks)
        if len(clusters) >= 2:
            for cluster_box, cluster_blocks in clusters:
                cluster_text = " ".join(item["text"] for item in cluster_blocks)
                cluster_marked = marked_box(cluster_box)
                cluster_logo = _candidate_has_logo(
                    layout, cluster_box, cluster_text, cluster_blocks, "cluster", False, ocr_neighbors,
                )
                classification = classify_ad_candidate(
                    cluster_text,
                    cluster_blocks,
                    marked=cluster_marked,
                    logo=cluster_logo,
                    page_blocks=blocks,
                    geometry_ratio=(
                        (cluster_box[2] - cluster_box[0]) * (cluster_box[3] - cluster_box[1])
                        / (width * height)
                    ),
                )
                if classification["classification"] == "company_ad":
                    candidates.append({
                        "bbox": cluster_box,
                        "geometry": "cluster",
                        "blocks": cluster_blocks,
                        "page_dominant": False,
                        "marked": cluster_marked,
                        "text": cluster_text,
                        "ocr_neighbors": ocr_neighbors,
                    })
        else:
            page_box = (0, 0, width, height) if marked else box
            classification = classify_ad_candidate(
                candidate_text,
                contained,
                marked=marked,
                page_dominant=True,
                logo=_candidate_has_logo(layout, page_box, candidate_text, contained),
                page_blocks=blocks,
                geometry_ratio=(
                    (box[2] - box[0]) * (box[3] - box[1]) / (width * height)
                ),
            )
            if classification["classification"] == "company_ad":
                candidates.append({
                    "bbox": page_box,
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
        clusters = _sender_clusters(box, contained, blocks)
        if len(clusters) >= 2:
            for cluster_box, cluster_blocks in clusters:
                cluster_text = " ".join(item["text"] for item in cluster_blocks)
                cluster_marked = marked_box(cluster_box)
                cluster_logo = _candidate_has_logo(
                    layout, cluster_box, cluster_text, cluster_blocks, "cluster", False, ocr_neighbors,
                )
                classification = classify_ad_candidate(
                    cluster_text,
                    cluster_blocks,
                    marked=cluster_marked,
                    logo=cluster_logo,
                    page_blocks=blocks,
                    geometry_ratio=(
                        (cluster_box[2] - cluster_box[0]) * (cluster_box[3] - cluster_box[1])
                        / (width * height)
                    ),
                )
                if classification["classification"] != "company_ad":
                    continue
                candidates.append({
                    "bbox": cluster_box,
                    "geometry": "cluster",
                    "blocks": cluster_blocks,
                    "page_dominant": False,
                    "marked": cluster_marked,
                    "text": cluster_text,
                    "ocr_neighbors": ocr_neighbors,
                })
            continue
        logo = _candidate_has_logo(
            layout,
            box,
            candidate_text,
            contained,
            geometry_kind,
            page_dominant,
            ocr_neighbors,
        )
        classification = classify_ad_candidate(
            candidate_text,
            contained,
            marked=marked,
            page_dominant=page_dominant,
            logo=logo,
            page_blocks=blocks,
            geometry_ratio=(
                (box[2] - box[0]) * (box[3] - box[1]) / (width * height)
            ),
        )
        if classification["classification"] != "company_ad":
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
        logo = _candidate_has_logo(
            layout,
            box,
            text_value,
            candidate["blocks"],
            candidate["geometry"],
            candidate["page_dominant"],
            candidate.get("ocr_neighbors", False),
        )
        classification = classify_ad_candidate(
            text_value,
            candidate["blocks"],
            marked=candidate["marked"],
            page_dominant=candidate["page_dominant"],
            logo=logo,
            page_blocks=blocks,
            geometry_ratio=(
                (box[2] - box[0]) * (box[3] - box[1]) / (width * height)
            ),
        )
        if classification["classification"] != "company_ad":
            continue
        advertiser, contact = _advertiser_and_contact(text_value, candidate["blocks"])
        evidence = ["geometry"]
        if advertiser:
            evidence.append("advertiser")
        if contact:
            evidence.append("contact")
        if logo:
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
