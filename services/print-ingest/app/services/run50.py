import base64
import hashlib
import io
import json
import math
import re
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path

import fitz
import httpx
import pytesseract
from PIL import Image

from app.services.processor import (
    PUBLIC_ORIGIN_SIGNALS,
    _ASSOCIATION_PATTERN,
    _CHARITY_PATTERN,
    _CHURCH_SENDER_PATTERN,
    _LEGAL_FORM_PATTERN,
    _PUBLIC_SENDER_PATTERN,
    _PUBLISHER_PROMOTION_PATTERN,
    _has_strong_public_origin,
    _industry_match,
    load_page_gray,
    render_ad_crop_with_margin,
)

PHONE_RE = re.compile(
    r"(?:\+49|0049|0)\s*(?:\(?\d{2,5}\)?[\s./-]*)\d[\d\s./-]{4,}"
)
EMAIL_RE = re.compile(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}")
DOMAIN_RE = re.compile(
    r"(?:https?://)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+", re.I
)
_RUN50_ASSOCIATION_PATTERN = re.compile(
    r"(?<!\w)e\.\s?V\.(?!\w)|\beingetragener\s+verein\b|"
    r"\b(?:förderverein|hilfsdienst|hilfe[-\s]?ring|kreisverband|ortsverband|ortsverein|partei)\b|"
    r"\b(?:freie\s+wähler|bündnis\s*90|die\s+grünen|die\s+linke)\b|"
    r"(?-i:\b(?:CSU|CDU|SPD|FDP|AfD|ÖDP)\b)",
    re.I,
)
_RUN50_WELFARE_PATTERN = re.compile(
    r"\b(?:johanniter|malteser|rotes\s+kreuz|arbeiter[-\s]samariter|lebenshilfe)\b|"
    r"(?-i:\b(?:DRK|BRK|ASB)\b)",
    re.I,
)
_RUN50_PUBLIC_COMPANY_PATTERN = re.compile(r"(?-i:\bVG\b)")
_RUN50_PUBLIC_TEXT_PATTERN = re.compile(
    r"(?i:\b(?:markt)?gemeinde)\s+(?-i:[A-ZÄÖÜ])|"
    r"(?i:\b(?:zweckverband|verwaltungsgemeinschaft|personalverwaltung|bürgermeister(?:in)?)\b)|"
    r"(?i:\bwir\s+gemeinden\b)"
)
_RUN50_PUBLISHER_COMPANY_PATTERN = re.compile(
    r"\b(?:verlag\w*|mediengruppe|journal|amtsblatt|mitteilungsblatt|gemeindeblatt|anzeiger)\b",
    re.I,
)
_RUN50_PUBLISHER_ANY_PATTERN = re.compile(
    r"\bwittich\b|\blw-flyerdruck\b|\bnussbaum\s+medien\b|"
    r"\beine\s+veröffentlichung\s+der\b|\banzeigen\s+schalten\b",
    re.I,
)

PROMPTS_DIR = Path(__file__).resolve().parents[1] / "prompts"
DETECTOR_PROMPT_FILE = PROMPTS_DIR / "run50_detector_prompt.md"
CROP_CHECK_PROMPT_FILE = PROMPTS_DIR / "run50_crop_check_prompt.md"
DETECTOR_PROMPT_TEXT = DETECTOR_PROMPT_FILE.read_text(encoding="utf-8")
DETECTOR_PROMPT = re.search(
    r"```(?:text)?\n(.*?)\n```", DETECTOR_PROMPT_TEXT, re.S
).group(1)
CROP_CHECK_PROMPT = CROP_CHECK_PROMPT_FILE.read_text(encoding="utf-8")
DETECTOR_PROMPT_SHA256 = hashlib.sha256(DETECTOR_PROMPT_FILE.read_bytes()).hexdigest()
CROP_CHECK_PROMPT_SHA256 = hashlib.sha256(
    CROP_CHECK_PROMPT_FILE.read_bytes()
).hexdigest()
MODEL = "gpt-5.1"
API_URL = "https://api.openai.com/v1/responses"
RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}
FORM_MARKERS = (
    "bürgerinfo-broschüre",
    "buergerinfo-broschuere",
    "publikationsvorschlag",
    "kundendaten",
    "anzeigenauftrag",
    "auftraggeber",
    "annahmeformular",
)
LABEL_VOCABULARY = {
    "company": ("firma",),
    "street": ("strasse", "straße", "strasse hausnr", "straße-hausnr"),
    "postal_city": ("plz/ort", "plz ort", "plz-ort"),
    "contact_person": ("asp", "asp.", "ansprechpartner"),
    "phone": ("tel", "tel.", "telefon"),
    "fax": ("fax",),
    "email": ("e-mail", "e-mail:", "email"),
    "date": ("datum",),
    "process": ("vorgang",),
    "advisor": ("berater",),
    "employee": ("mitarbeiter",),
}
_GLYPH_GROWTH_SIDES = ("left", "right", "top", "bottom")


@dataclass
class Run50Ad:
    region: dict
    company: str
    crop_png: bytes
    crop_info: dict
    text: str
    run50: dict


@dataclass
class Run50Rejection:
    page_number: int
    region: dict | None
    company: str
    stage: str
    reason: str
    run50: dict


@dataclass
class Run50PageResult:
    page_number: int
    accepted: list[Run50Ad]
    rejected: list[Run50Rejection]
    usage: list[dict]


class ResponsesClient:
    def __init__(
        self,
        api_key: str,
        model: str = "gpt-5.1",
        timeout: float = 600,
        sleep=time.sleep,
    ):
        self.api_key = api_key
        self.model = model
        self.timeout = timeout
        self.sleep = sleep

    def ask(self, prompt: str, png: bytes, max_edge: int) -> tuple[dict | None, dict]:
        with Image.open(io.BytesIO(png)) as source:
            image = source.convert("RGB")
            image.thumbnail(
                (max_edge, max_edge),
                Image.Resampling.LANCZOS,
            )
            buffer = io.BytesIO()
            image.save(buffer, format="PNG", optimize=False)
        data_url = "data:image/png;base64," + base64.b64encode(
            buffer.getvalue()
        ).decode("ascii")
        payload = {
            "model": self.model,
            "input": [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": prompt},
                        {
                            "type": "input_image",
                            "image_url": data_url,
                            "detail": "high",
                        },
                    ],
                }
            ],
        }
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        for attempt in range(3):
            try:
                response = httpx.post(
                    API_URL,
                    headers=headers,
                    json=payload,
                    timeout=self.timeout,
                )
            except (httpx.TransportError, httpx.TimeoutException):
                if attempt == 2:
                    raise
                self.sleep(2**attempt)
                continue
            if response.status_code in RETRYABLE_STATUS_CODES:
                if attempt == 2:
                    response.raise_for_status()
                self.sleep(2**attempt)
                continue
            response.raise_for_status()
            raw = response.json()
            if not isinstance(raw, dict):
                return None, {}
            return _parse_response(raw), raw
        raise RuntimeError("Responses API retry loop ended unexpectedly")


def _parse_response(response: dict) -> dict | None:
    text = response.get("output_text") or ""
    if not text:
        chunks = []
        for output in response.get("output", []):
            for content in output.get("content", []):
                if content.get("type") in {"output_text", "text"}:
                    chunks.append(content.get("text", ""))
        text = "\n".join(chunks)
    text = text.strip()
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.S)
        if not match:
            return None
        try:
            value = json.loads(match.group(0))
        except json.JSONDecodeError:
            return None
    return value if isinstance(value, dict) else None


def _normalized(value: str) -> str:
    value = unicodedata.normalize("NFKD", value).casefold()
    return re.sub(r"[^a-z0-9]+", "", value)


def is_order_form_page(text: str) -> bool:
    normalized_text = _normalized(text or "")
    has_marker = any(_normalized(marker) in normalized_text for marker in FORM_MARKERS)
    if not has_marker:
        return False
    labels = set()
    for line in (text or "").splitlines():
        match = re.match(r"^\s*([^:.]+?)\s*[:.]", line)
        if not match:
            continue
        label = _normalized(match.group(1))
        for canonical, aliases in LABEL_VOCABULARY.items():
            if label in {_normalized(alias) for alias in aliases}:
                labels.add(canonical)
    return len(labels) >= 2


def _usage(raw: dict | None) -> dict:
    value = raw.get("usage") if isinstance(raw, dict) else None
    return dict(value) if isinstance(value, dict) else {}


def _provenance(
    detector_ad: dict | None,
    usage: list[dict],
    first: dict | None = None,
    second: dict | None = None,
    action: str = "none",
) -> dict:
    return {
        "model": MODEL,
        "detector_prompt_sha256": DETECTOR_PROMPT_SHA256,
        "crop_check_prompt_sha256": CROP_CHECK_PROMPT_SHA256,
        "detector_ad": detector_ad,
        "crop_check_first": first,
        "crop_check_second": second,
        "action": action,
        "usage": [dict(item) for item in usage],
    }


def _region_from_rect(rect, page_rect, confidence, company=""):
    x0, y0, x1, y1 = rect
    return {
        "x": (x0 - page_rect.x0) / page_rect.width,
        "y": (y0 - page_rect.y0) / page_rect.height,
        "width": (x1 - x0) / page_rect.width,
        "height": (y1 - y0) / page_rect.height,
        "confidence": confidence,
        "evidence": [],
        "preview": company,
    }


def _bbox_from_detector(value, page_rect):
    if (
        not isinstance(value, list)
        or len(value) < 4
        or any(
            isinstance(item, bool)
            or not isinstance(item, (int, float))
            or not math.isfinite(float(item))
            for item in value
        )
    ):
        return None, "bbox_ungueltig"
    numbers = [float(item) for item in value]
    if max(numbers) > 100:
        return None, "bbox_werte_ueber_100"
    unit_scale = 1.0 if max(numbers) <= 1 else 0.01
    x0 = page_rect.x0 + numbers[0] * unit_scale * page_rect.width
    y0 = page_rect.y0 + numbers[1] * unit_scale * page_rect.height
    x1 = page_rect.x0 + numbers[2] * unit_scale * page_rect.width
    y1 = page_rect.y0 + numbers[3] * unit_scale * page_rect.height
    rect = (
        max(page_rect.x0, min(page_rect.x1, x0)),
        max(page_rect.y0, min(page_rect.y1, y0)),
        max(page_rect.x0, min(page_rect.x1, x1)),
        max(page_rect.y0, min(page_rect.y1, y1)),
    )
    if rect[2] <= rect[0] or rect[3] <= rect[1]:
        return None, "bbox_ungueltig"
    return rect, None


def _glyph_boxes(page):
    boxes = []
    for block in page.get_text("rawdict").get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                for char in span.get("chars", []):
                    bbox = char.get("bbox")
                    if bbox and len(bbox) == 4:
                        box = tuple(float(value) for value in bbox)
                        if box[2] > box[0] and box[3] > box[1]:
                            boxes.append(box)
    return boxes


def _intersects(a, b):
    return a[2] > b[0] and a[0] < b[2] and a[3] > b[1] and a[1] < b[3]


def _glyph_growth(before, glyphs, page_rect):
    left, top, right, bottom = before
    initial_width = right - left
    initial_height = bottom - top
    limits = {
        "left": initial_width * 0.12,
        "right": initial_width * 0.12,
        "top": initial_height * 0.12,
        "bottom": initial_height * 0.12,
    }
    growth = {side: 0.0 for side in limits}
    while True:
        changed = False
        for side in _GLYPH_GROWTH_SIDES:
            crossing = []
            for box in glyphs:
                if side == "left" and box[0] < left < box[2] and box[3] > top and box[1] < bottom:
                    crossing.append(box[0])
                elif side == "right" and box[0] < right < box[2] and box[3] > top and box[1] < bottom:
                    crossing.append(box[2])
                elif side == "top" and box[1] < top < box[3] and box[2] > left and box[0] < right:
                    crossing.append(box[1])
                elif side == "bottom" and box[1] < bottom < box[3] and box[2] > left and box[0] < right:
                    crossing.append(box[3])
            if not crossing:
                continue
            target = min(crossing) if side == "left" else max(crossing)
            amount = (
                left - target
                if side == "left"
                else target - right
                if side == "right"
                else top - target
                if side == "top"
                else target - bottom
            )
            if amount <= 0:
                continue
            if growth[side] + amount > limits[side]:
                return (left, top, right, bottom), growth, [side]
            if side == "left":
                left = max(page_rect.x0, target)
            elif side == "right":
                right = min(page_rect.x1, target)
            elif side == "top":
                top = max(page_rect.y0, target)
            else:
                bottom = min(page_rect.y1, target)
            growth[side] += amount
            changed = True
        if not changed:
            break
    return (left, top, right, bottom), growth, []


def _is_full_page(rect, page_rect):
    x0, y0, x1, y1 = rect
    return (
        x0 <= page_rect.x0 + page_rect.width * 0.05
        and y0 <= page_rect.y0 + page_rect.height * 0.05
        and x1 >= page_rect.x1 - page_rect.width * 0.05
        and y1 >= page_rect.y1 - page_rect.height * 0.05
    )


def _page_bbox_points(crop_info, page_rect):
    crop = crop_info["crop_bbox"]
    return (
        page_rect.x0 + crop["x"] * page_rect.width,
        page_rect.y0 + crop["y"] * page_rect.height,
        page_rect.x0 + (crop["x"] + crop["width"]) * page_rect.width,
        page_rect.y0 + (crop["y"] + crop["height"]) * page_rect.height,
    )


def _crop_check_rect(verdict, crop_info, page_rect):
    bbox = verdict.get("tight_bbox")
    if (
        not isinstance(bbox, list)
        or len(bbox) < 4
        or any(
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(float(value))
            for value in bbox[:4]
        )
    ):
        return None
    values = [max(0.0, min(100.0, float(value))) for value in bbox[:4]]
    crop = _page_bbox_points(crop_info, page_rect)
    width, height = crop[2] - crop[0], crop[3] - crop[1]
    rect = (
        crop[0] + width * values[0] / 100,
        crop[1] + height * values[1] / 100,
        crop[0] + width * values[2] / 100,
        crop[1] + height * values[3] / 100,
    )
    rect = (
        max(page_rect.x0, min(page_rect.x1, rect[0])),
        max(page_rect.y0, min(page_rect.y1, rect[1])),
        max(page_rect.x0, min(page_rect.x1, rect[2])),
        max(page_rect.y0, min(page_rect.y1, rect[3])),
    )
    return rect if rect[2] > rect[0] and rect[3] > rect[1] else None


def _grow_checked_rect(verdict, crop_info, page_rect):
    rect = list(_page_bbox_points(crop_info, page_rect))
    width, height = rect[2] - rect[0], rect[3] - rect[1]
    sides = set(verdict.get("cut_off_sides") or [])
    if "left" in sides:
        rect[0] -= width * 0.12
    if "top" in sides:
        rect[1] -= height * 0.12
    if "right" in sides:
        rect[2] += width * 0.12
    if "bottom" in sides:
        rect[3] += height * 0.12
    rect[0] = max(page_rect.x0, rect[0])
    rect[1] = max(page_rect.y0, rect[1])
    rect[2] = min(page_rect.x1, rect[2])
    rect[3] = min(page_rect.y1, rect[3])
    return tuple(rect) if rect[2] > rect[0] and rect[3] > rect[1] else None


def _crop_size(png: bytes):
    with Image.open(io.BytesIO(png)) as image:
        return image.size


def _crop_text(page, png, crop_info):
    rect = fitz.Rect(*_page_bbox_points(crop_info, page.rect))
    text = page.get_text("text", clip=rect) or ""
    if len(re.sub(r"\s", "", text)) < 20:
        with Image.open(io.BytesIO(png)) as image:
            text = pytesseract.image_to_string(
                image,
                lang="deu",
                config="--psm 6",
            )
    return text


def _has_contact(text):
    return bool(PHONE_RE.search(text) or EMAIL_RE.search(text) or DOMAIN_RE.search(text))


def customer_exclusion(company: str, text: str) -> str | None:
    commercially_identified = bool(
        _LEGAL_FORM_PATTERN.search(company) or _industry_match(company)
    )
    if _ASSOCIATION_PATTERN.search(company) or _RUN50_ASSOCIATION_PATTERN.search(company):
        return "veto:verein"
    if (
        _RUN50_WELFARE_PATTERN.search(company)
        and not _LEGAL_FORM_PATTERN.search(company)
        and not re.search(r"\bggmbh\b", company, re.I)
    ):
        return "veto:verein"
    if (
        _PUBLIC_SENDER_PATTERN.search(company)
        or PUBLIC_ORIGIN_SIGNALS.search(company)
        or _RUN50_PUBLIC_COMPANY_PATTERN.search(company)
        or _RUN50_PUBLIC_TEXT_PATTERN.search(text)
        or _has_strong_public_origin(text)
    ) and not commercially_identified:
        return "veto:behoerde"
    if _CHURCH_SENDER_PATTERN.search(company) and not commercially_identified:
        return "veto:kirche"
    if (
        _PUBLISHER_PROMOTION_PATTERN.search(text)
        or _RUN50_PUBLISHER_COMPANY_PATTERN.search(company)
        or _RUN50_PUBLISHER_ANY_PATTERN.search(company)
        or _RUN50_PUBLISHER_ANY_PATTERN.search(text)
    ):
        return "veto:verlag"
    return None


def _crop_area(png):
    width, height = _crop_size(png)
    return width * height


def _iou(first, second):
    left = max(first[0], second[0])
    top = max(first[1], second[1])
    right = min(first[2], second[2])
    bottom = min(first[3], second[3])
    intersection = max(0.0, right - left) * max(0.0, bottom - top)
    area_first = (first[2] - first[0]) * (first[3] - first[1])
    area_second = (second[2] - second[0]) * (second[3] - second[1])
    union = area_first + area_second - intersection
    return intersection / union if union else 0.0


def _contained(candidate, kept):
    return (
        candidate[0] >= kept[0]
        and candidate[1] >= kept[1]
        and candidate[2] <= kept[2]
        and candidate[3] <= kept[3]
    )


def _norm_name(name):
    value = unicodedata.normalize("NFC", (name or "")).lower()
    value = value.replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss")
    value = unicodedata.normalize("NFKD", value)
    value = value.encode("ascii", "ignore").decode()
    value = re.sub(r"[^a-z0-9 ]+", " ", value)
    tokens = [
        token
        for token in value.split()
        if token not in {"ag", "gmbh", "kg", "ev", "e", "v", "co", "kreisverband", "wetzlar"}
    ]
    return " ".join(tokens)


def _same_name(first, second):
    normalized_first, normalized_second = _norm_name(first), _norm_name(second)
    if not normalized_first or not normalized_second:
        return False
    tokens_first, tokens_second = set(normalized_first.split()), set(
        normalized_second.split()
    )
    return (
        normalized_first == normalized_second
        or tokens_first <= tokens_second
        or tokens_second <= tokens_first
        or SequenceMatcher(None, normalized_first, normalized_second).ratio() >= 0.85
    )


def _ad_metadata(candidate, usage, first=None, second=None, action="none"):
    return _provenance(candidate["detector_ad"], usage, first, second, action)


def _rejection(page_number, candidate, stage, reason, usage, company=None, first=None, second=None, action="none"):
    return Run50Rejection(
        page_number=page_number,
        region=candidate.get("region") if candidate else None,
        company=company if company is not None else (candidate.get("company", "") if candidate else ""),
        stage=stage,
        reason=reason,
        run50=_ad_metadata(candidate, usage, first, second, action)
        if candidate
        else _provenance(None, usage, first, second, action),
    )


def detect_page(
    pdf_bytes: bytes,
    page_number: int,
    layout: dict | None,
    client,
) -> Run50PageResult:
    document = fitz.open(stream=pdf_bytes, filetype="pdf")
    page_image = None
    try:
        page = document[page_number - 1]
        pixmap = page.get_pixmap(
            matrix=fitz.Matrix(300 / 72, 300 / 72),
            alpha=False,
        )
        page_png = pixmap.tobytes("png")
        page_image = load_page_gray(page_png)
        parsed, detector_raw = client.ask(DETECTOR_PROMPT, page_png, 2000)
        detector_usage = _usage(detector_raw)
        page_usage = [detector_usage]
        result = Run50PageResult(page_number, [], [], page_usage)
        if (
            not isinstance(parsed, dict)
            or not isinstance(parsed.get("advertisements"), list)
        ):
            result.rejected.append(
                _rejection(page_number, None, "detector", "antwort_unlesbar", page_usage)
            )
            return result

        glyphs = _glyph_boxes(page)
        prepared = []
        for detector_ad in parsed["advertisements"]:
            ad = detector_ad if isinstance(detector_ad, dict) else {}
            try:
                confidence = float(ad.get("confidence", 0))
            except (TypeError, ValueError):
                confidence = 0.0
            if not math.isfinite(confidence) or confidence < 0.5:
                result.rejected.append(
                    _rejection(
                        page_number,
                        {"detector_ad": ad, "company": str(ad.get("company_name") or ""), "region": None},
                        "postprocess",
                        "konfidenz_unter_0_5",
                        page_usage,
                    )
                )
                continue
            before, error = _bbox_from_detector(ad.get("bbox"), page.rect)
            if error:
                result.rejected.append(
                    _rejection(
                        page_number,
                        {"detector_ad": ad, "company": str(ad.get("company_name") or ""), "region": None},
                        "postprocess",
                        error,
                        page_usage,
                    )
                )
                continue
            has_text_layer = any(_intersects(glyph, before) for glyph in glyphs)
            if has_text_layer:
                grown, _growth, growth_failures = _glyph_growth(before, glyphs, page.rect)
            else:
                grown, growth_failures = before, []
            if growth_failures and not _is_full_page(before, page.rect):
                result.rejected.append(
                    _rejection(
                        page_number,
                        {
                            "detector_ad": ad,
                            "company": str(ad.get("company_name") or ""),
                            "region": _region_from_rect(
                                grown, page.rect, confidence, str(ad.get("company_name") or "")
                            ),
                        },
                        "postprocess",
                        "randschnitt_nicht_behebbar",
                        page_usage,
                    )
                )
                continue
            if not has_text_layer:
                grown = before
            region = _region_from_rect(
                grown, page.rect, confidence, str(ad.get("company_name") or "")
            )
            prepared.append(
                {
                    "detector_ad": ad,
                    "company": str(ad.get("company_name") or ""),
                    "region": region,
                    "rect": grown,
                }
            )

        page_regions = [candidate["region"] for candidate in prepared]
        rendered = []
        for candidate in prepared:
            png, crop_info = render_ad_crop_with_margin(
                pdf_bytes,
                page_number,
                candidate["region"],
                layout,
                page_regions,
                page_image=page_image,
            )
            candidate["crop_png"] = png
            candidate["crop_info"] = crop_info
            candidate["crop_area"] = _crop_area(png)
            width, height = _crop_size(png)
            if min(width, height) < 200 or max(width, height) < 350:
                result.rejected.append(
                    _rejection(
                        page_number,
                        candidate,
                        "postprocess",
                        "zuschnitt_zu_klein",
                        page_usage,
                    )
                )
                continue
            candidate["text"] = _crop_text(page, png, crop_info)
            if not _has_contact(candidate["text"]):
                result.rejected.append(
                    _rejection(
                        page_number,
                        candidate,
                        "postprocess",
                        "kein_kontaktwert",
                        page_usage,
                    )
                )
                continue
            rendered.append(candidate)

        nonoverlap = []
        for candidate in sorted(rendered, key=lambda item: -item["crop_area"]):
            if any(
                _contained(candidate["rect"], old["rect"])
                or _iou(candidate["rect"], old["rect"]) > 0.4
                for old in nonoverlap
            ):
                result.rejected.append(
                    _rejection(
                        page_number,
                        candidate,
                        "overlap",
                        "ueberlappung",
                        page_usage,
                    )
                )
            else:
                nonoverlap.append(candidate)

        def render_region(candidate, region):
            regions = list(page_regions)
            original_index = next(
                index
                for index, existing in enumerate(regions)
                if existing is candidate["region"]
            )
            regions[original_index] = region
            return render_ad_crop_with_margin(
                pdf_bytes,
                page_number,
                region,
                layout,
                regions,
                page_image=page_image,
            )

        for candidate in nonoverlap:
            call_usage = [detector_usage]
            first, first_raw = client.ask(
                CROP_CHECK_PROMPT,
                candidate["crop_png"],
                1600,
            )
            first_usage = _usage(first_raw)
            page_usage.append(first_usage)
            call_usage.append(first_usage)
            action = "none"
            second = None
            current_png = candidate["crop_png"]
            current_info = candidate["crop_info"]
            current_region = candidate["region"]

            if not isinstance(first, dict):
                result.rejected.append(
                    _rejection(
                        page_number,
                        candidate,
                        "crop_check",
                        "crop_check_antwort_unlesbar",
                        call_usage,
                    )
                )
                continue
            content = first.get("content")
            if content in {"editorial", "other"}:
                result.rejected.append(
                    _rejection(
                        page_number,
                        candidate,
                        "crop_check",
                        "redaktionell_keine_anzeige",
                        call_usage,
                        first=first,
                    )
                )
                continue

            has_foreign = bool(first.get("foreign_content_sides"))
            if content == "multiple_advertisements" or has_foreign:
                action = "tight_bbox"
                repaired_rect = _crop_check_rect(first, current_info, page.rect)
                if repaired_rect is None:
                    result.rejected.append(
                        _rejection(
                            page_number,
                            candidate,
                            "crop_check",
                            "mehrere_anzeigen_nicht_trennbar",
                            call_usage,
                            first=first,
                            action=action,
                        )
                    )
                    continue
                current_region = _region_from_rect(
                    repaired_rect, page.rect, candidate["region"]["confidence"], candidate["company"]
                )
                current_png, current_info = render_region(candidate, current_region)
            elif content == "partial_advertisement" or first.get("cut_off_sides"):
                action = "grow"
                repaired_rect = _grow_checked_rect(first, current_info, page.rect)
                if repaired_rect is None:
                    result.rejected.append(
                        _rejection(
                            page_number,
                            candidate,
                            "crop_check",
                            "randschnitt_nicht_behebbar",
                            call_usage,
                            first=first,
                            action=action,
                        )
                    )
                    continue
                current_region = _region_from_rect(
                    repaired_rect, page.rect, candidate["region"]["confidence"], candidate["company"]
                )
                current_png, current_info = render_region(candidate, current_region)

            if action != "none":
                final_candidate = {**candidate, "region": current_region}
                width, height = _crop_size(current_png)
                if min(width, height) < 200 or max(width, height) < 350:
                    result.rejected.append(
                        _rejection(
                            page_number,
                            final_candidate,
                            "postprocess",
                            "zuschnitt_zu_klein",
                            call_usage,
                            first=first,
                            action=action,
                        )
                    )
                    continue
                second, second_raw = client.ask(CROP_CHECK_PROMPT, current_png, 1600)
                second_usage = _usage(second_raw)
                page_usage.append(second_usage)
                call_usage.append(second_usage)
                if not isinstance(second, dict):
                    result.rejected.append(
                        _rejection(
                            page_number,
                            final_candidate,
                            "crop_check",
                            "crop_check_antwort_unlesbar",
                            call_usage,
                            first=first,
                            second=second,
                            action=action,
                        )
                    )
                    continue
                final_verdict = second
            else:
                final_verdict = first
                final_candidate = candidate

            if final_verdict.get("content") in {"editorial", "other"}:
                result.rejected.append(
                    _rejection(
                        page_number,
                        final_candidate,
                        "crop_check",
                        "redaktionell_keine_anzeige",
                        call_usage,
                        first=first,
                        second=second,
                        action=action,
                    )
                )
                continue
            try:
                crop_confidence = float(final_verdict.get("confidence", 0))
            except (TypeError, ValueError):
                crop_confidence = 0.0
            valid = (
                final_verdict.get("content") == "single_advertisement"
                and not final_verdict.get("foreign_content_sides")
                and not final_verdict.get("cut_off_sides")
                and math.isfinite(crop_confidence)
                and crop_confidence >= 0.7
            )
            if not valid:
                reason = (
                    "mehrere_anzeigen_nicht_trennbar"
                    if action == "tight_bbox"
                    else "randschnitt_nicht_behebbar"
                    if action == "grow"
                    else "crop_check_nicht_bestanden"
                )
                result.rejected.append(
                    _rejection(
                        page_number,
                        final_candidate,
                        "crop_check",
                        reason,
                        call_usage,
                        company=str(final_verdict.get("advertiser") or ""),
                        first=first,
                        second=second,
                        action=action,
                    )
                )
                continue

            final_text = (
                _crop_text(page, current_png, current_info)
                if action != "none"
                else candidate["text"]
            )
            if not _has_contact(final_text):
                result.rejected.append(
                    _rejection(
                        page_number,
                        {
                            **candidate,
                            "region": current_region,
                        },
                        "postprocess",
                        "kein_kontaktwert",
                        call_usage,
                        company=str(final_verdict.get("advertiser") or ""),
                        first=first,
                        second=second,
                        action=action,
                    )
                )
                continue

            company = str(final_verdict.get("advertiser") or "")
            exclusion = customer_exclusion(company, final_text)
            provenance = _ad_metadata(
                candidate,
                call_usage,
                first,
                second,
                action,
            )
            if exclusion:
                result.rejected.append(
                    Run50Rejection(
                        page_number,
                        current_region,
                        company,
                        "exclusion",
                        exclusion,
                        provenance,
                    )
                )
                continue

            evidence = ["positiv:run50", "positiv:p3"]
            if _CHARITY_PATTERN.search(company):
                evidence.append("hinweis:traeger")
            if current_info.get("shortfall"):
                evidence.append("crop:shortfall")
            preview = " ".join(final_text.split())[:240]
            current_region["confidence"] = crop_confidence
            current_region["evidence"] = evidence
            current_region["preview"] = preview
            result.accepted.append(
                Run50Ad(
                    region=current_region,
                    company=company,
                    crop_png=current_png,
                    crop_info=current_info,
                    text=final_text,
                    run50=provenance,
                )
            )
        return result
    finally:
        if page_image is not None:
            page_image.close()
        document.close()


def detect_document(
    pdf_bytes: bytes,
    pages: list[dict],
    client,
    concurrency: int = 4,
) -> list[Run50PageResult]:
    page_results = {}
    ordered_pages = sorted(pages, key=lambda page: page["page_number"])
    pages_to_detect = []
    for page in ordered_pages:
        number = page["page_number"]
        if is_order_form_page(page.get("text", "")):
            page_results[number] = Run50PageResult(number, [], [], [])
        else:
            pages_to_detect.append(page)
    if pages_to_detect:
        with ThreadPoolExecutor(max_workers=max(1, int(concurrency))) as executor:
            futures = {
                executor.submit(
                    detect_page,
                    pdf_bytes,
                    page["page_number"],
                    page.get("layout"),
                    client,
                ): page["page_number"]
                for page in pages_to_detect
            }
            for future, number in futures.items():
                page_results[number] = future.result()

    ordered_results = [page_results[page["page_number"]] for page in ordered_pages]
    accepted = [
        (result, ad)
        for result in ordered_results
        for ad in result.accepted
    ]
    retained = []
    rejected = set()
    for result, ad in sorted(accepted, key=lambda item: -_crop_area(item[1].crop_png)):
        duplicate = any(_same_name(ad.company, old.company) for _, old in retained)
        if duplicate:
            result.rejected.append(
                Run50Rejection(
                    result.page_number,
                    ad.region,
                    ad.company,
                    "dedupe",
                    "kunde_doppelt",
                    ad.run50,
                )
            )
            rejected.add(id(ad))
        else:
            retained.append((result, ad))
    for result in ordered_results:
        result.accepted = [ad for ad in result.accepted if id(ad) not in rejected]
    return ordered_results
