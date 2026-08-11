from collections import Counter, deque
from dataclasses import dataclass
import re
from pathlib import Path

import pypdfium2 as pdfium
from PIL import Image

from app.services.bbox import Box


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


def _page_glyphs(pdf_path: str | Path, page_number: int, ad_box: Box, render_dpi: int):
    pdf = pdfium.PdfDocument(str(pdf_path))
    page = None
    text_page = None
    try:
        page = pdf[page_number - 1]
        page_width, page_height = page.get_size()
        text_page = page.get_textpage()
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
        if text_page is not None:
            text_page.close()
        if page is not None:
            page.close()
        pdf.close()


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
            if pixels[x, y] != background and (
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
            if pixel != background:
                destination_pixels[position[0] + x, position[1] + y] = pixel


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
    scale = artwork_dpi / render_dpi
    glyphs, invalid, char_count = _page_glyphs(
        pdf_path, page_number, detector_box, render_dpi
    )
    local_glyphs = [
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

    approved_box = Box(
        round(detector_box.left * scale - artwork_crop_origin[0]),
        round(detector_box.top * scale - artwork_crop_origin[1]),
        round(detector_box.right * scale - artwork_crop_origin[0]),
        round(detector_box.bottom * scale - artwork_crop_origin[1]),
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
        strip.left < 0
        or strip.top < 0
        or strip.right > image.width
        or strip.bottom > image.height
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
    mask = _border_color_mask(artwork, background, approved_box)
    replacement = tuple(min(255, channel + 5) for channel in background)
    changed_background = bytearray(len(mask))
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
    for index, connected in enumerate(mask):
        if connected:
            x, y = index % artwork.width, index // artwork.width
            if any(
                box.left <= x < box.right and box.top <= y < box.bottom
                for box in protected_boxes
            ):
                continue
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
