from collections import Counter, deque
from dataclasses import dataclass
import re
from pathlib import Path
from typing import Iterable

from PIL import Image

from app.services.bbox import Box
from app.services.pdfium import open_document


PHONE_RE = re.compile(r"(?:\+49|0049|0)\s*(?:\(?\d{2,5}\)?[\s./-]*)\d[\d\s./-]{4,}")
EMAIL_RE = re.compile(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}")
DOMAIN_RE = re.compile(r"(?:https?://)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+", re.I)
POSTAL_RE = re.compile(r"\b\d{5}\b")
PRICE_RE = re.compile(
    r"(?:\d+(?:[.,]\d{1,2})?\s?(?:€|eur|euro|chf|tl)|(?:€|eur|euro|chf|tl)\s?\d+)",
    re.I,
)
IBAN_RE = re.compile(r"\b[A-Z]{2}\d{2}(?:[\s-]?[A-Z0-9]){11,30}\b", re.I)
VALIDITY_RE = re.compile(
    r"\b(?:gültig|gueltig|bis|deadline|frist|heute|vom|zeitraum)\b", re.I
)
CAMPAIGN_TERMS = (
    "aktion",
    "angebot",
    "rabatt",
    "sale",
    "promotion",
    "kampagne",
    "indirim",
)
INK_DISTANCE_THRESHOLD = 10


@dataclass(frozen=True)
class Glyph:
    text: str
    box: Box


@dataclass(frozen=True)
class TextLine:
    text: str
    box: Box
    glyphs: tuple[Glyph, ...]


@dataclass(frozen=True)
class RestorationResult:
    image: Image.Image | None
    manifest: dict
    review_reason: str | None


def approved_artwork_box(
    detector_box: Box,
    artwork_size: tuple[int, int],
    render_dpi: int,
    artwork_dpi: int,
    artwork_crop_origin: tuple[int, int],
) -> Box:
    scale = artwork_dpi / render_dpi
    return Box(
        max(
            0,
            min(
                artwork_size[0],
                round(detector_box.left * scale - artwork_crop_origin[0]),
            ),
        ),
        max(
            0,
            min(
                artwork_size[1],
                round(detector_box.top * scale - artwork_crop_origin[1]),
            ),
        ),
        max(
            0,
            min(
                artwork_size[0],
                round(detector_box.right * scale - artwork_crop_origin[0]),
            ),
        ),
        max(
            0,
            min(
                artwork_size[1],
                round(detector_box.bottom * scale - artwork_crop_origin[1]),
            ),
        ),
    )


def _normalize_anchor(value: str) -> str:
    compact = re.sub(r"\s+", " ", value.casefold()).strip()
    if PHONE_RE.search(compact):
        return re.sub(r"\D", "", compact)
    if EMAIL_RE.search(compact) or DOMAIN_RE.search(compact):
        return re.sub(r"[^a-z0-9@._+-]", "", compact)
    return compact


def _anchor_count(text: str, anchor: str) -> int:
    if PHONE_RE.search(anchor):
        return _normalize_anchor(text).count(_normalize_anchor(anchor))
    normalized_text = " ".join(text.casefold().split())
    normalized_anchor = " ".join(anchor.casefold().split())
    if EMAIL_RE.search(anchor) or DOMAIN_RE.search(anchor):
        normalized_text = re.sub(r"[^a-z0-9@._+-]", "", normalized_text)
        normalized_anchor = re.sub(r"[^a-z0-9@._+-]", "", normalized_anchor)
    return normalized_text.count(normalized_anchor)


def _tokens(text: str) -> set[str]:
    return {
        token
        for token in re.findall(r"\w+(?:[.@+_-]\w+)*", text.casefold())
        if len(token) > 2 and any(character.isalnum() for character in token)
    }


def _quantized_colors(image: Image.Image, boundary: Box, limit: int = 5):
    pixels = image.load()
    colors = Counter(
        tuple((channel // 16) * 16 for channel in pixels[x, y])
        for y in range(boundary.top, boundary.bottom)
        for x in range(boundary.left, boundary.right)
    )
    total = max(1, boundary.area)
    return {color: count / total for color, count in colors.most_common(limit)}


def verify_generative_proposal(
    source: Image.Image,
    proposed: Image.Image,
    boundary: Box,
    expected_anchors: Iterable[str],
    original_ocr_text: str,
    proposed_ocr_text: str,
    color_tolerance: float = 0.12,
    provided_crop_size: tuple[int, int] | None = None,
) -> dict:
    checks = []
    if provided_crop_size is not None:
        expected_crop_size = (boundary.right - boundary.left, boundary.bottom - boundary.top)
        if provided_crop_size != expected_crop_size:
            return {
                "status": "failed",
                "checks": [
                    {
                        "name": "dimensions",
                        "status": "failed",
                        "reason": "provider result dimensions differ from approved artwork crop",
                        "expected_crop_size": list(expected_crop_size),
                        "provided_crop_size": list(provided_crop_size),
                    }
                ],
            }
    if proposed.size != source.size:
        checks.append(
            {
                "name": "dimensions",
                "status": "failed",
                "reason": "proposal dimensions differ from source artwork",
            }
        )
        return {"status": "failed", "checks": checks}
    checks.append(
        {
            "name": "dimensions",
            "status": "passed",
            "source_size": list(source.size),
            "proposal_size": list(proposed.size),
        }
    )
    valid_boundary = (
        0 <= boundary.left < boundary.right <= source.width
        and 0 <= boundary.top < boundary.bottom <= source.height
    )
    source_pixels = source.load()
    proposed_pixels = proposed.load()
    outside_equal = valid_boundary and all(
        source_pixels[x, y] == proposed_pixels[x, y]
        for y in range(source.height)
        for x in range(source.width)
        if not (boundary.left <= x < boundary.right and boundary.top <= y < boundary.bottom)
    )
    checks.append(
        {
            "name": "approved_boundary",
            "status": "passed" if outside_equal else "failed",
            "reason": ""
            if outside_equal
            else "approved boundary is invalid or proposal differs outside it",
        }
    )
    anchors = [_normalize_anchor(anchor) for anchor in expected_anchors if anchor.strip()]
    original_text = " ".join(original_ocr_text.casefold().split())
    if not anchors or not original_text:
        checks.append(
            {
                "name": "ocr_assessable",
                "status": "not_assessed",
                "reason": "original OCR did not provide usable evidence for anchors",
            }
        )
        return {"status": "not_assessed", "checks": checks}
    checks.append(
        {
            "name": "ocr_assessable",
            "status": "passed",
            "reason": "original OCR evidence is available",
        }
    )
    anchor_matches = [_anchor_count(proposed_ocr_text, anchor) for anchor in anchors]
    checks.append(
        {
            "name": "text_anchors",
            "status": "passed" if all(count == 1 for count in anchor_matches) else "failed",
            "anchors": anchors,
            "matches": anchor_matches,
            "reason": ""
            if all(count == 1 for count in anchor_matches)
            else "an expected communication anchor is missing or duplicated",
        }
    )
    original_tokens = _tokens(original_ocr_text)
    proposed_tokens = _tokens(proposed_ocr_text)
    new_tokens = sorted(proposed_tokens - original_tokens)
    checks.append(
        {
            "name": "no_new_text",
            "status": "passed" if not new_tokens else "failed",
            "new_tokens": new_tokens,
            "reason": ""
            if not new_tokens
            else "OCR detected text that was not present in the original",
        }
    )
    original_colors = _quantized_colors(source, boundary)
    proposed_colors = _quantized_colors(proposed, boundary)
    color_failures = [
        color
        for color, share in original_colors.items()
        if abs(proposed_colors.get(color, 0.0) - share) > color_tolerance
    ]
    new_dominant = [
        color
        for color, share in proposed_colors.items()
        if share > 0.15 and color not in original_colors
    ]
    checks.append(
        {
            "name": "brand_colors",
            "status": "passed" if not color_failures and not new_dominant else "failed",
            "missing_or_changed": [list(color) for color in color_failures],
            "new_dominant": [list(color) for color in new_dominant],
            "reason": ""
            if not color_failures and not new_dominant
            else "dominant artwork colors changed beyond the configured tolerance",
        }
    )
    failed = [check for check in checks if check["status"] == "failed"]
    return {"status": "passed" if not failed else "failed", "checks": checks}


def _anchor_matches(
    image: Image.Image,
    line: TextLine,
    background,
    displacements: list[tuple[int, int]],
) -> int:
    pixels = image.load()
    points = []
    original_left = max(0, line.box.left)
    original_top = max(0, line.box.top)
    original_right = min(image.width, line.box.right)
    original_bottom = min(image.height, line.box.bottom)
    for y in range(original_top, original_bottom):
        for x in range(original_left, original_right):
            if _is_ink(pixels[x, y], background):
                points.append(
                    (x - original_left, y - original_top, pixels[x, y])
                )
    if not points:
        return 0
    points = points[:: max(1, len(points) // 32)][:32]
    matches = 0
    height = original_bottom - original_top
    width = original_right - original_left
    for offset_x, offset_y in displacements:
        candidate_left = original_left + offset_x
        candidate_top = original_top + offset_y
        if (
            candidate_left < 0
            or candidate_top < 0
            or candidate_left + width > image.width
            or candidate_top + height > image.height
        ):
            continue
        if all(
            pixels[candidate_left + x, candidate_top + y] == color
            for x, y, color in points
        ):
            matches += 1
    return matches


def verify_proposal(
    pdf_path: str | Path,
    page_number: int,
    detector_box: Box,
    render_dpi: int,
    source_image_path: str | Path,
    proposed: Image.Image,
    artwork_crop_origin: tuple[int, int],
    artwork_dpi: int,
    manifest: dict,
    anchor_texts: list[str] | None = None,
) -> dict:
    source = Image.open(source_image_path).convert("RGB")
    checks = []
    if proposed.size != source.size:
        checks.append(
            {
                "name": "dimensions",
                "status": "failed",
                "reason": "proposal dimensions differ from source artwork",
            }
        )
        return {"status": "failed", "checks": checks}
    aspect_ratio = source.width / source.height
    checks.append(
        {
            "name": "dimensions",
            "status": "passed",
            "source_size": list(source.size),
            "proposal_size": list(proposed.size),
            "source_aspect_ratio": aspect_ratio,
            "proposal_aspect_ratio": proposed.width / proposed.height,
        }
    )

    raw_boundary = manifest.get("ad_boundary")
    if not isinstance(raw_boundary, (list, tuple)) or len(raw_boundary) != 4:
        return {
            "status": "failed",
            "checks": checks
            + [
                {
                    "name": "approved_boundary",
                    "status": "failed",
                    "reason": "manifest is missing a valid approved advertisement boundary",
                }
            ],
        }
    try:
        boundary = Box(*(int(value) for value in raw_boundary))
    except (TypeError, ValueError):
        return {
            "status": "failed",
            "checks": checks
            + [
                {
                    "name": "approved_boundary",
                    "status": "failed",
                    "reason": "manifest contains an invalid approved advertisement boundary",
                }
            ],
        }
    if (
        boundary.left < 0
        or boundary.top < 0
        or boundary.right > source.width
        or boundary.bottom > source.height
        or boundary.left >= boundary.right
        or boundary.top >= boundary.bottom
    ):
        return {
            "status": "failed",
            "checks": checks
            + [
                {
                    "name": "approved_boundary",
                    "status": "failed",
                    "reason": "approved advertisement boundary is outside the artwork",
                }
            ],
        }
    source_pixels = source.load()
    proposed_pixels = proposed.load()
    outside_equal = all(
        source_pixels[x, y] == proposed_pixels[x, y]
        for y in range(source.height)
        for x in range(source.width)
        if not (
            boundary.left <= x < boundary.right
            and boundary.top <= y < boundary.bottom
        )
    )
    checks.append(
        {
            "name": "approved_boundary",
            "status": "passed" if outside_equal else "failed",
            "reason": ""
            if outside_equal
            else "proposal differs outside the approved advertisement boundary",
        }
    )

    local_glyphs = _local_glyphs(
        pdf_path,
        page_number,
        detector_box,
        render_dpi,
        artwork_dpi,
        artwork_crop_origin,
    )
    lines = _group_lines(local_glyphs, 5)
    background = _dominant_color(source, boundary)[0]
    anchors = [
        line for line in lines if _communication_kind(line.text) is not None
    ]
    if anchor_texts:
        anchors.extend(
            line for line in lines if line.text in set(anchor_texts)
        )
    anchors = list({line.text: line for line in anchors}.values())
    displacements = [(0, 0)]
    source_regions = [
        Box(*region) for region in manifest.get("source_regions", [])
    ]
    destination_regions = [
        Box(*region) for region in manifest.get("destination_regions", [])
    ]
    displacements.extend(
        (destination.left - source.left, destination.top - source.top)
        for source, destination in zip(source_regions, destination_regions)
    )
    displacements = list(dict.fromkeys(displacements))
    anchor_counts = [
        _anchor_matches(proposed, line, background, displacements)
        for line in anchors
    ]
    anchors_ok = bool(anchors) and all(count == 1 for count in anchor_counts)
    checks.append(
        {
            "name": "text_anchors",
            "status": "passed" if anchors_ok else "failed",
            "anchors": [line.text for line in anchors],
            "matches": anchor_counts,
            "new_anchors": [],
            "reason": ""
            if anchors_ok
            else "one or more original text anchors were lost or duplicated",
        }
    )

    original_colors = Counter(source.getdata())
    proposed_colors = Counter(proposed.getdata())
    replacement = tuple(
        manifest.get("background_replacement_color", background)
    )
    excess = {
        color: proposed_count - original_colors.get(color, 0)
        for color, proposed_count in proposed_colors.items()
        if color != replacement
        and proposed_count > original_colors.get(color, 0)
    }
    checks.append(
        {
            "name": "new_content",
            "status": "passed" if not excess else "failed",
            "excess_pixels_by_color": {
                str(color): count for color, count in excess.items()
            },
            "reason": ""
            if not excess
            else "proposal contains pixels absent from the source artwork",
        }
    )

    def dark_count(image, region):
        return sum(
            1
            for y in range(region.top, region.bottom)
            for x in range(region.left, region.right)
            if max(
                abs(color - base)
                for color, base in zip(image.getpixel((x, y)), background)
            )
            > 20
        )

    duplicate_ink = 0
    for source_region, destination_region in zip(
        source_regions, destination_regions
    ):
        expected = dark_count(source, destination_region)
        actual = dark_count(proposed, source_region)
        if abs(actual - expected) > max(20, expected * 0.25):
            duplicate_ink += 1
    checks.append(
        {
            "name": "duplicated_content",
            "status": "passed" if duplicate_ink == 0 else "failed",
            "remaining_source_ink": duplicate_ink,
            "reason": ""
            if duplicate_ink == 0
            else "source ink remains where moved content should have been removed",
        }
    )
    failed = [check for check in checks if check["status"] == "failed"]
    return {
        "status": "passed" if not failed else "failed",
        "checks": checks,
        "anchors_assessed": bool(anchors),
    }


def _page_glyphs(pdf_path: str | Path, page_number: int, ad_box: Box, render_dpi: int):
    with open_document(pdf_path) as pdf:
        page = pdf[page_number - 1]
        try:
            page_width, page_height = page.get_size()
            text_page = page.get_textpage()
            try:
                text = text_page.get_text_range()
                scale = render_dpi / 72
                page_box = ad_box
                glyphs = []
                invalid = 0
                for index, value in enumerate(text):
                    left, bottom, right, top = text_page.get_charbox(index)
                    if right <= left or top <= bottom:
                        invalid += 1
                        continue
                    pixel_box = Box(
                        round(left * scale),
                        round((page_height - top) * scale),
                        round(right * scale),
                        round((page_height - bottom) * scale),
                    )
                    center_x = (pixel_box.left + pixel_box.right) / 2
                    center_y = (pixel_box.top + pixel_box.bottom) / 2
                    if (
                        page_box.left <= center_x <= page_box.right
                        and page_box.top <= center_y <= page_box.bottom
                        and value.strip()
                    ):
                        glyphs.append(Glyph(value, pixel_box))
                return glyphs, invalid, len(text)
            finally:
                text_page.close()
        finally:
            page.close()


def _local_glyphs(
    pdf_path: str | Path,
    page_number: int,
    detector_box: Box,
    render_dpi: int,
    artwork_dpi: int,
    artwork_crop_origin: tuple[int, int],
) -> list[Glyph]:
    glyphs, _, _ = _page_glyphs(pdf_path, page_number, detector_box, render_dpi)
    return _to_local_glyphs(glyphs, artwork_dpi, render_dpi, artwork_crop_origin)


def _to_local_glyphs(
    glyphs: list[Glyph],
    artwork_dpi: int,
    render_dpi: int,
    artwork_crop_origin: tuple[int, int],
) -> list[Glyph]:
    scale = artwork_dpi / render_dpi
    return [
        Glyph(
            glyph.text,
            Box(
                round(glyph.box.left * scale - artwork_crop_origin[0]),
                round(glyph.box.top * scale - artwork_crop_origin[1]),
                round(glyph.box.right * scale - artwork_crop_origin[0]),
                round(glyph.box.bottom * scale - artwork_crop_origin[1]),
            ),
        )
        for glyph in glyphs
    ]


def communication_lines_for_box(
    pdf_path: str | Path,
    page_number: int,
    detector_box: Box,
    render_dpi: int,
    artwork_dpi: int,
    artwork_crop_origin: tuple[int, int],
) -> list[str]:
    lines = _group_lines(
        _local_glyphs(
            pdf_path,
            page_number,
            detector_box,
            render_dpi,
            artwork_dpi,
            artwork_crop_origin,
        ),
        5,
    )
    return [
        line.text for line in lines if _communication_kind(line.text) is not None
    ]


def _group_lines(glyphs: list[Glyph], tolerance: float) -> list[TextLine]:
    rows: list[list[Glyph]] = []
    for glyph in sorted(
        glyphs,
        key=lambda item: (
            (item.box.top + item.box.bottom) / 2,
            item.box.left,
        ),
    ):
        center = (glyph.box.top + glyph.box.bottom) / 2
        row = next(
            (candidate for candidate in rows if abs(candidate[0] - center) <= tolerance),
            None,
        )
        if row is None:
            rows.append([center, [glyph]])
        else:
            row[1].append(glyph)

    lines = []
    for _, row in sorted(rows, key=lambda item: item[0]):
        ordered = sorted(row, key=lambda item: item.box.left)
        heights = [glyph.box.bottom - glyph.box.top for glyph in ordered]
        gap = max(1, round(sorted(heights)[len(heights) // 2] * 0.7))
        words = []
        previous = None
        for glyph in ordered:
            if previous is not None and glyph.box.left - previous.right > gap:
                words.append(" ")
            words.append(glyph.text)
            previous = glyph.box
        lines.append(
            TextLine(
                "".join(words),
                Box(
                    min(glyph.box.left for glyph in ordered),
                    min(glyph.box.top for glyph in ordered),
                    max(glyph.box.right for glyph in ordered),
                    max(glyph.box.bottom for glyph in ordered),
                ),
                tuple(ordered),
            )
        )
    return lines


def _communication_kind(text: str) -> str | None:
    if PHONE_RE.search(text) or EMAIL_RE.search(text) or DOMAIN_RE.search(text):
        return "contact"
    if re.search(r"\d{5}", text) or re.search(
        r"\b(?:straße|strasse|weg|platz|gasse|allee|ufer)\b", text, re.I
    ):
        return "address"
    return None


def _findings(lines: list[TextLine]) -> list[dict]:
    findings = []
    for line in lines:
        normalized = " ".join(line.text.split())
        folded = normalized.casefold()
        rule = None
        if PRICE_RE.search(normalized):
            rule = "price_or_currency"
        elif IBAN_RE.search(normalized) and re.search(
            r"\b(?:iban|bic|konto|bank|bankverbindung)\b", normalized, re.I
        ):
            rule = "bank_details"
        elif VALIDITY_RE.search(normalized) and re.search(
            r"\d|termin|beratung|aktion|angebot", normalized, re.I
        ):
            rule = "validity_or_deadline"
        elif any(term in folded for term in CAMPAIGN_TERMS) or (
            "kostenlos" in folded and "beratungstermin" in folded
        ):
            rule = "campaign_or_offer"
        if rule:
            findings.append(
                {
                    "rule": rule,
                    "confidence": 0.95,
                    "text": normalized,
                    "region": [
                        line.box.left,
                        line.box.top,
                        line.box.right,
                        line.box.bottom,
                    ],
                    "action": "review_required",
                }
            )
    return findings


def _dominant_color(image: Image.Image, box: Box):
    pixels = image.load()
    colors = Counter(
        pixels[x, y]
        for y in range(box.top, box.bottom)
        for x in range(box.left, box.right)
    )
    color, count = colors.most_common(1)[0]
    total = (box.right - box.left) * (box.bottom - box.top)
    return color, count / total


def _border_color_mask(image: Image.Image, color, region: Box):
    width, height = image.size
    pixels = image.load()
    seen = bytearray(width * height)
    queue = deque()
    for x in range(region.left, region.right):
        queue.extend(((region.top, x), (region.bottom - 1, x)))
    for y in range(region.top, region.bottom):
        queue.extend(((y, region.left), (y, region.right - 1)))
    while queue:
        y, x = queue.popleft()
        index = y * width + x
        if (
            seen[index]
            or x < region.left
            or x >= region.right
            or y < region.top
            or y >= region.bottom
            or pixels[x, y] != color
        ):
            continue
        seen[index] = 1
        if x:
            queue.append((y, x - 1))
        if x + 1 < width:
            queue.append((y, x + 1))
        if y:
            queue.append((y - 1, x))
        if y + 1 < height:
            queue.append((y + 1, x))
    return seen


def _changed_region(mask: bytearray, size: tuple[int, int]):
    width, height = size
    points = [
        (index % width, index // width)
        for index, value in enumerate(mask)
        if value
    ]
    if not points:
        return None
    return [
        min(x for x, _ in points),
        min(y for _, y in points),
        max(x for x, _ in points) + 1,
        max(y for _, y in points) + 1,
    ]


def _has_ink_outside_strip(
    image: Image.Image,
    line: TextLine,
    strip: Box,
    background,
    boundary: Box,
) -> bool:
    pixels = image.load()
    height = max(line.box.bottom - line.box.top, 1)
    left = max(boundary.left, line.box.left - height * 2)
    right = min(boundary.right, line.box.right + height * 2)
    top = max(boundary.top, line.box.top - 2)
    bottom = min(boundary.bottom, line.box.bottom + 2)
    for y in range(top, bottom):
        for x in range(left, right):
            if _is_ink(pixels[x, y], background) and (
                x < strip.left or x >= strip.right
            ):
                return True
    return False


def _paste_ink(
    destination: Image.Image,
    source: Image.Image,
    position: tuple[int, int],
    background,
) -> None:
    destination_pixels = destination.load()
    source_pixels = source.load()
    for y in range(source.height):
        for x in range(source.width):
            pixel = source_pixels[x, y]
            if _is_ink(pixel, background):
                destination_pixels[position[0] + x, position[1] + y] = pixel


def _is_ink(pixel, background) -> bool:
    return (
        sum(abs(channel - base) for channel, base in zip(pixel, background))
        > INK_DISTANCE_THRESHOLD
    )


def propose_level_one(
    pdf_path: str | Path,
    page_number: int,
    detector_box: Box,
    render_dpi: int,
    artwork_path: str | Path,
    artwork_crop_origin: tuple[int, int],
    artwork_dpi: int,
) -> RestorationResult:
    image = Image.open(artwork_path).convert("RGB")
    artwork = image.copy()
    glyphs, invalid, char_count = _page_glyphs(
        pdf_path, page_number, detector_box, render_dpi
    )
    local_glyphs = _to_local_glyphs(
        glyphs, artwork_dpi, render_dpi, artwork_crop_origin
    )
    invalid_ratio = invalid / max(char_count, 1)
    overlap_count = 0
    for index, first in enumerate(local_glyphs):
        for second in local_glyphs[index + 1 :]:
            if abs(
                (first.box.top + first.box.bottom) / 2
                - (second.box.top + second.box.bottom) / 2
            ) > 12:
                continue
            intersection = Box(
                max(first.box.left, second.box.left),
                max(first.box.top, second.box.top),
                min(first.box.right, second.box.right),
                min(first.box.bottom, second.box.bottom),
            ).area
            if intersection > min(first.box.area, second.box.area) * 0.2:
                overlap_count += 1
    overlap_ratio = overlap_count / max(len(local_glyphs), 1)
    lines = _group_lines(local_glyphs, 5)
    findings = _findings(lines)
    communication = [
        line for line in lines if _communication_kind(line.text) is not None
    ]
    base_manifest = {
        "cascade_level": 1,
        "cascade_justification": "Level 1 is the first applicable cascade: two communication lines were located.",
        "source_regions": [],
        "destination_regions": [],
        "removed_regions": [],
        "background_regions": [],
        "protected_regions": [],
        "ad_boundary": [],
        "geometry_quality": {
            "status": "assessed",
            "text_characters": len(local_glyphs),
            "invalid_ratio": invalid_ratio,
            "overlap_ratio": overlap_ratio,
        },
        "findings": findings
        + [
            {
                "rule": "qr_detection_unavailable",
                "confidence": 0.0,
                "text": "",
                "region": None,
                "action": "review_required",
            }
        ],
        "verification": {"status": "not_assessed", "checks": []},
        "review_status": "pending",
        "edit_status": "refused",
    }
    if not local_glyphs:
        base_manifest["cascade_justification"] = (
            "Refused: no usable PDF text-layer geometry was found inside the approved ad box."
        )
        return RestorationResult(
            None, base_manifest, "restoration refused: no clean text-layer geometry"
        )
    if invalid_ratio > 0.08 or overlap_ratio > 0.08:
        base_manifest["cascade_justification"] = (
            "Refused: PDF text objects are malformed or overlapping, so line geometry is not trustworthy."
        )
        return RestorationResult(
            None,
            base_manifest,
            "restoration refused: malformed or overlapping text-layer geometry",
        )
    if len(communication) < 2:
        base_manifest["cascade_justification"] = (
            "Refused: fewer than two communication lines were located confidently."
        )
        return RestorationResult(
            None,
            base_manifest,
            "restoration refused: fewer than two communication lines",
        )
    if findings:
        base_manifest["cascade_justification"] = (
            "Refused: conservative forbidden-content findings require review before any pixel removal."
        )
        return RestorationResult(
            None,
            base_manifest,
            "restoration refused: forbidden-content finding requires review",
        )

    approved_box = approved_artwork_box(
        detector_box, artwork.size, render_dpi, artwork_dpi, artwork_crop_origin
    )
    base_manifest["ad_boundary"] = [
        approved_box.left,
        approved_box.top,
        approved_box.right,
        approved_box.bottom,
    ]
    selected = communication[-2:]
    left = min(line.box.left for line in selected)
    right = max(line.box.right for line in selected)
    height = max(line.box.bottom - line.box.top for line in selected)
    strip_height = max(height + 4, 1)
    strips = []
    for line in selected:
        center = (line.box.top + line.box.bottom) / 2
        strip = Box(
            left,
            round(center - strip_height / 2),
            right,
            round(center - strip_height / 2) + strip_height,
        )
        strips.append(strip)
    if any(
        strip.left < approved_box.left
        or strip.top < approved_box.top
        or strip.right > approved_box.right
        or strip.bottom > approved_box.bottom
        for strip in strips
    ):
        base_manifest["cascade_justification"] = (
            "Refused: a communication strip would cross the artwork boundary."
        )
        return RestorationResult(
            None,
            base_manifest,
            "restoration refused: communication strip crosses artwork boundary",
        )
    colors = [_dominant_color(image, strip) for strip in strips]
    if any(ratio < 0.45 for _, ratio in colors) or colors[0][0] != colors[1][0]:
        base_manifest["cascade_justification"] = (
            "Refused: communication strips do not have compatible flat backgrounds."
        )
        return RestorationResult(
            None,
            base_manifest,
            "restoration refused: non-flat or incompatible communication background",
        )

    first_box, second_box = strips
    background = colors[0][0]
    if any(
        _has_ink_outside_strip(image, line, strip, background, approved_box)
        for line, strip in zip(selected, strips)
    ):
        base_manifest["cascade_justification"] = (
            "Refused: the rendered ink extends beyond the located line strips, so moving it could clip or leave residue."
        )
        return RestorationResult(
            None,
            base_manifest,
            "restoration refused: rendered ink does not fit the line strips",
        )
    first = artwork.crop((first_box.left, first_box.top, first_box.right, first_box.bottom))
    second = artwork.crop(
        (second_box.left, second_box.top, second_box.right, second_box.bottom)
    )
    replacement_delta = -5 if sum(background) >= 3 * 250 else 5
    replacement = tuple(
        max(0, min(255, channel + replacement_delta)) for channel in background
    )
    changed_background = bytearray(artwork.width * artwork.height)
    pixels = artwork.load()
    protected_boxes = [
        glyph.box
        for glyph in local_glyphs
        if not any(
            strip.left <= glyph.box.left
            and glyph.box.right <= strip.right
            and strip.top <= glyph.box.top
            and glyph.box.bottom <= strip.bottom
            for strip in strips
        )
    ]
    for y in range(approved_box.top, approved_box.bottom):
        for x in range(approved_box.left, approved_box.right):
            index = y * artwork.width + x
            if pixels[x, y] == background:
                pixels[x, y] = replacement
                changed_background[index] = 1
    artwork.paste(
        replacement,
        (first_box.left, first_box.top, first_box.right, first_box.bottom),
    )
    artwork.paste(
        replacement,
        (second_box.left, second_box.top, second_box.right, second_box.bottom),
    )
    _paste_ink(artwork, second, (first_box.left, first_box.top), background)
    _paste_ink(artwork, first, (second_box.left, second_box.top), background)
    base_manifest.update(
        {
            "source_regions": [
                [first_box.left, first_box.top, first_box.right, first_box.bottom],
                [second_box.left, second_box.top, second_box.right, second_box.bottom],
            ],
            "destination_regions": [
                [second_box.left, second_box.top, second_box.right, second_box.bottom],
                [first_box.left, first_box.top, first_box.right, first_box.bottom],
            ],
            "protected_regions": [
                [box.left, box.top, box.right, box.bottom]
                for box in protected_boxes
            ],
            "background_regions": [
                region
                for region in [_changed_region(changed_background, artwork.size)]
                if region
            ],
            "background_source_color": list(background),
            "background_replacement_color": list(replacement),
            "edit_status": "applied",
        }
    )
    return RestorationResult(
        artwork,
        base_manifest,
        "restoration proposal requires review: QR detection is unavailable",
    )
