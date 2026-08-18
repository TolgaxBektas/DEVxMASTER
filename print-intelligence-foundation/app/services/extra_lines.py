from dataclasses import dataclass
import math
from pathlib import Path
import re
from typing import Any, Mapping, Sequence

import pytesseract
from PIL import Image, ImageDraw, ImageFont, ImageOps


CONTACT_RE = re.compile(r"(@|www\.|\.de\b|tel\.|telefon|fax|\d{3,})", re.I)
FONT_MINIMUM_SCALE = 0.70
SOCIAL_ASSETS = Path(__file__).parents[1] / "assets" / "social"
FONT_CANDIDATES = {
    False: (
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ),
    True: (
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ),
}


@dataclass(frozen=True)
class ExtraLineComposition:
    image: Image.Image
    manifest: dict[str, Any]


def _lines(
    image: Image.Image,
    *,
    config: str = "",
    offset: tuple[int, int] = (0, 0),
) -> list[dict[str, Any]]:
    data = pytesseract.image_to_data(
        image, lang="deu", config=config, output_type=pytesseract.Output.DICT
    )
    grouped: dict[tuple[int, int, int], dict[str, Any]] = {}
    for index, text in enumerate(data["text"]):
        if not text.strip() or float(data["conf"][index]) < 30:
            continue
        key = (
            data["block_num"][index],
            data["par_num"][index],
            data["line_num"][index],
        )
        left = data["left"][index] + offset[0]
        top = data["top"][index] + offset[1]
        line = grouped.setdefault(
            key,
            {
                "text": [],
                "heights": [],
                "words": [],
                "confidences": [],
                "left": left,
                "top": top,
                "right": left,
                "bottom": top,
            },
        )
        line["text"].append(text)
        line["heights"].append((text, data["height"][index]))
        line["confidences"].append(float(data["conf"][index]))
        line["words"].append(
            {
                "text": text,
                "left": left,
                "top": top,
                "right": left + data["width"][index],
                "bottom": top + data["height"][index],
                "height": data["height"][index],
            }
        )
        line["left"] = min(line["left"], left)
        line["top"] = min(line["top"], top)
        line["right"] = max(line["right"], left + data["width"][index])
        line["bottom"] = max(line["bottom"], top + data["height"][index])
    for line in grouped.values():
        line["text"] = " ".join(line["text"])
        line["words"].sort(key=lambda word: word["left"])
    return sorted(grouped.values(), key=lambda line: line["top"])


def _edge_colour(image: Image.Image) -> tuple[int, int, int]:
    rows = list(
        image.convert("RGB")
        .crop((0, max(0, image.height - 3), image.width, image.height))
        .getdata()
    )
    return max(set(rows), key=rows.count) if rows else (255, 255, 255)


def _content_bands(
    image: Image.Image,
    background: tuple[int, int, int],
    limit: int = 24,
) -> tuple[list[tuple[int, int]], dict[str, Any]]:
    active = [
        y for y in range(image.height) if not _row_uniform(image, y, background)
    ]
    runs: list[list[int]] = []
    for y in active:
        if not runs or y - runs[-1][-1] > 2:
            runs.append([y])
        else:
            runs[-1].append(y)
    original_count = len(runs)
    limited = original_count > limit
    if limited:
        runs = sorted(runs, key=len, reverse=True)[:limit]
    bands = []
    for run in sorted(runs, key=lambda item: item[0]):
        height = run[-1] - run[0] + 1
        padding = max(1, int(round(height * 0.25)))
        bands.append((max(0, run[0] - padding), min(image.height, run[-1] + padding + 1)))
    return bands, {
        "band_count": original_count,
        "bands_used": len(bands),
        "band_limit": limit,
        "band_limit_applied": limited,
    }


def _ocr_lines(image: Image.Image) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    ocr_lines = []
    for candidate in (
        image,
        ImageOps.autocontrast(image.convert("L")),
        ImageOps.invert(image.convert("RGB")),
    ):
        for line in _lines(candidate):
            line["ocr_source"] = "whole_image"
            ocr_lines.append(line)
    bands, metadata = _content_bands(image, _edge_colour(image))
    for top, bottom in bands:
        band = image.crop((0, top, image.width, bottom))
        for line in _lines(band, config="--psm 6", offset=(0, top)):
            line["ocr_source"] = "band"
            ocr_lines.append(line)
    return ocr_lines, metadata


def _contact_segments(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    segments = []
    for line in lines:
        words = line.get("words") or [
            {
                "text": line.get("text", ""),
                "left": line["left"],
                "top": line["top"],
                "right": line["right"],
                "bottom": line["bottom"],
                "height": max(
                    [height for _word, height in line.get("heights", [])] or [1]
                ),
            }
        ]
        median_height = sorted(word["height"] for word in words)[len(words) // 2]
        current = [words[0]]
        groups = []
        for word in words[1:]:
            gap = word["left"] - current[-1]["right"]
            if gap > max(3 * median_height, 3):
                groups.append(current)
                current = [word]
            else:
                current.append(word)
        groups.append(current)
        for group in groups:
            segments.append(
                {
                    "text": " ".join(word["text"] for word in group),
                    "heights": [
                        (word["text"], word["height"]) for word in group
                    ],
                    "left": group[0]["left"],
                    "top": min(word["top"] for word in group),
                    "right": group[-1]["right"],
                    "bottom": max(word["bottom"] for word in group),
                    "ocr_source": line.get("ocr_source"),
                    "full_text": line.get("text", ""),
                    "confidence": min(line.get("confidences") or [0]),
                }
            )
    return segments


def _contact_score(segment: dict[str, Any]) -> int:
    text = segment["text"]
    return (
        len(re.findall(r"\d", text))
        + 3 * bool(re.search(r"@", text))
        + 2 * bool(re.search(r"(?:www\.|https?://|\.de\b)", text, re.I))
    )


def _contact_values(text: str) -> list[tuple[str, str]]:
    values: list[tuple[str, str]] = []
    for match in re.finditer(r"[\w.+-]+@[\w.-]+\.[a-z]{2,}", text, re.I):
        values.append(("email", match.group(0)))
    for match in re.finditer(
        r"(?:(?:https?://)?(?:www\.)?"
        r"(?:facebook|instagram)\.[a-z]{2,}(?:/[^\s,;)]*)?)",
        text,
        re.I,
    ):
        domain = match.group(0)
        channel = "facebook" if "facebook." in domain.lower() else "instagram"
        values.append((channel, domain))
    without_email = re.sub(r"[\w.+-]+@[\w.-]+\.[a-z]{2,}", "", text, flags=re.I)
    for match in re.finditer(
        r"(?:(?:https?://)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+"
        r"(?:/[^\s,;)]*)?)",
        without_email,
        re.I,
    ):
        values.append(("website", match.group(0)))
    if re.search(r"\d{3,}", text):
        number_text = re.sub(
            r"^\s*(?:telefax|fax|telefon|tel\.?|phone)\s*[:\-]?\s*",
            "",
            text,
            flags=re.I,
        ).strip()
        number_matches = re.finditer(r"\d[\d\s./-]*\d|\d+", number_text)
        number_match = next(
            (
                match
                for match in number_matches
                if len(re.sub(r"\D", "", match.group(0))) >= 6
            ),
            None,
        )
        if number_match:
            values.append(
                (
                    "fax" if re.search(r"fax", text, re.I) else "phone",
                    number_match.group(0).strip(),
                )
            )
    return values


def _pure_contact_segment(segment: dict[str, Any]) -> list[tuple[str, str]] | None:
    values = _contact_values(segment.get("text", ""))
    if not values:
        return None
    remainder = segment.get("text", "")
    for _channel, value in values:
        remainder = remainder.replace(value, "")
    remainder = re.sub(
        r"\b(?:telefax|fax|telefon|tel\.?|phone|e-?mail|www)\b",
        "",
        remainder,
        flags=re.I,
    )
    if re.search(r"[A-Za-zÄÖÜäöüß]", remainder):
        return None
    return values


def _reset_background(
    image: Image.Image,
    segments: list[dict[str, Any]],
) -> tuple[tuple[int, int, int], tuple[int, int, int]] | None:
    left = min(segment["left"] for segment in segments)
    right = max(segment["right"] for segment in segments)
    top = min(segment["top"] for segment in segments)
    bottom = max(segment["bottom"] for segment in segments)
    padding = max(2, int(round(max(segment["bottom"] - segment["top"] for segment in segments) * 0.35)))
    box = (
        max(0, left - padding),
        max(0, top - padding),
        min(image.width, right + padding),
        min(image.height, bottom + padding),
    )
    region = image.crop(box).convert("RGB")
    width, height = region.size
    border_pixels = []
    for y in range(height):
        for x in range(width):
            if x < padding or x >= width - padding or y < padding or y >= height - padding:
                border_pixels.append(region.getpixel((x, y)))
    pixels = list(region.getdata())
    if not border_pixels:
        return None
    if not pixels:
        return None
    background = max(set(border_pixels), key=border_pixels.count)
    tolerance = 18
    matching = [
        pixel
        for pixel in pixels
        if all(abs(pixel[index] - background[index]) <= tolerance for index in range(3))
    ]
    if len(matching) / len(pixels) < 0.72:
        return None
    luma = 0.299 * background[0] + 0.587 * background[1] + 0.114 * background[2]
    text = (0, 0, 0) if luma > 127 else (255, 255, 255)
    return text, background


def _columnwise_homogeneous(
    image: Image.Image,
    top: int,
    bottom: int,
    tolerance: int = 18,
    left: int = 0,
    right: int | None = None,
) -> bool:
    if bottom <= top:
        return True
    pixels = image.convert("RGB")
    for x in range(left, right if right is not None else image.width):
        column = [pixels.getpixel((x, y)) for y in range(top, bottom)]
        reference = max(set(column), key=column.count)
        matching = sum(
            all(abs(pixel[index] - reference[index]) <= tolerance for index in range(3))
            for pixel in column
        )
        if matching / len(column) < 0.90:
            return False
    return True


def _rowwise_homogeneous(
    image: Image.Image,
    top: int,
    bottom: int,
    left: int,
    right: int,
    tolerance: int = 18,
) -> bool:
    pixels = image.convert("RGB")
    for y in range(top, bottom):
        row = [pixels.getpixel((x, y)) for x in range(left, right)]
        if not row:
            return False
        reference = max(set(row), key=row.count)
        matching = sum(
            all(abs(pixel[index] - reference[index]) <= tolerance for index in range(3))
            for pixel in row
        )
        if matching / len(row) < 0.90:
            return False
    return True


def _seam_repeatable(
    image: Image.Image,
    seam_y: int,
    bottom: int,
    left: int,
    right: int,
    tolerance: int = 18,
) -> bool:
    if bottom <= seam_y or right <= left:
        return True
    pixels = image.convert("RGB")
    best_score = 0.0
    best_seam = None
    best_y = seam_y
    candidate_limit = min(bottom - 12, seam_y + 40)
    for candidate_y in range(seam_y, max(seam_y, candidate_limit)):
        candidate = [pixels.getpixel((x, candidate_y)) for x in range(left, right)]
        score = 1.0
        for y in range(candidate_y, min(bottom, candidate_y + 12)):
            matching = sum(
                all(
                    abs(pixels.getpixel((x, y))[index] - candidate[x - left][index])
                    <= tolerance
                    for index in range(3)
                )
                for x in range(left, right)
            )
            score = min(score, matching / len(candidate))
        if score > best_score:
            best_score = score
            best_seam = candidate
            best_y = candidate_y
    if best_seam is None or best_score < 0.90:
        return False
    for y in range(best_y, bottom):
        matching = sum(
            all(
                abs(pixels.getpixel((x, y))[index] - best_seam[x - left][index])
                <= tolerance
                for index in range(3)
            )
            for x in range(left, right)
        )
        if matching / len(best_seam) < 0.90:
            return False
    return True


def _seam_band_stable(
    image: Image.Image,
    top: int,
    bottom: int,
    left: int,
    right: int,
    tolerance: int = 18,
) -> bool:
    pixels = image.convert("RGB")
    references = []
    for y in range(top, min(bottom, top + 12)):
        row = [pixels.getpixel((x, y)) for x in range(left, right)]
        if not row:
            return False
        reference = max(set(row), key=row.count)
        matching = sum(
            all(abs(pixel[index] - reference[index]) <= tolerance for index in range(3))
            for pixel in row
        )
        if matching / len(row) < 0.80:
            return False
        references.append(reference)
    return bool(references) and all(
        all(abs(reference[index] - references[0][index]) <= tolerance for index in range(3))
        for reference in references
    )


def _inline_fax_area(
    image: Image.Image,
    segment: dict[str, Any],
    content_right: int,
    margin: int,
    cap_height: int,
) -> tuple[int, int, int, tuple[int, int, int]] | None:
    left = segment["right"] + max(1, cap_height)
    right = content_right - margin - max(1, cap_height)
    padding = max(2, int(round(cap_height * 0.35)))
    top = max(0, segment["top"] - padding)
    bottom = min(image.height, segment["bottom"] + padding)
    if right <= left or bottom <= top:
        return None
    pixels = image.convert("RGB")
    run_right = left
    background = None
    for x in range(left, right):
        column = [pixels.getpixel((x, y)) for y in range(top, bottom)]
        candidate = max(set(column), key=column.count)
        matching = sum(
            all(abs(pixel[index] - candidate[index]) <= 18 for index in range(3))
            for pixel in column
        )
        if matching / len(column) < 0.90:
            break
        if background is None:
            background = candidate
        elif any(abs(candidate[index] - background[index]) > 18 for index in range(3)):
            break
        run_right = x + 1
    if background is None or run_right - left < max(20, cap_height * 3):
        return None
    return left, run_right - max(1, cap_height), top, background


def _reset_block(anchor: dict[str, Any]) -> dict[str, Any] | None:
    candidates = []
    all_segments = [
        segment
        for segment in anchor.get("contact_segments", [])
        if segment.get("ocr_source") == "whole_image"
    ]
    for segment in anchor.get("contact_segments", []):
        if segment.get("ocr_source") != "whole_image":
            continue
        values = _pure_contact_segment(segment)
        if values and segment.get("confidence", 0) >= 60:
            candidates.append({**segment, "values": values})
    if not candidates:
        return None
    candidates.sort(key=lambda item: (item["top"], item["left"]))
    selected = []
    reference_left = candidates[0]["left"]
    column_segments = [
        segment
        for segment in all_segments
        if abs(segment["left"] - reference_left)
        <= max(segment["bottom"] - segment["top"], 1)
    ]
    if any(_pure_contact_segment(segment) is None for segment in column_segments):
        return None
    for segment in candidates:
        if abs(segment["left"] - reference_left) > max(
            segment["bottom"] - segment["top"], 1
        ):
            continue
        if selected and segment["top"] - selected[-1]["bottom"] > max(
            segment["bottom"] - segment["top"], 1
        ) * 2:
            break
        selected.append(segment)
    if not selected:
        return None
    unique: list[dict[str, Any]] = []
    seen = set()
    for segment in selected:
        key = (
            segment["text"],
            segment["left"],
            segment["top"],
            segment["right"],
            segment["bottom"],
        )
        if key not in seen:
            unique.append(segment)
            seen.add(key)
    selected = unique
    values = [value for segment in selected for value in segment["values"]]
    if not values:
        return None
    return {
        "segments": selected,
        "values": values,
        "left": min(segment["left"] for segment in selected),
        "top": min(segment["top"] for segment in selected),
        "right": max(segment["right"] for segment in selected),
        "bottom": max(segment["bottom"] for segment in selected),
    }


def _reset_band(
    image: Image.Image,
    reset: dict[str, Any],
    background: tuple[int, int, int],
    cap_height: int,
) -> tuple[int, int]:
    padding = max(1, int(round(cap_height * 0.35)))
    left = max(0, reset["left"] - padding)
    right = min(image.width, reset["right"] + padding)
    pixels = image.convert("RGB")

    def matches(y: int) -> bool:
        if not 0 <= y < image.height or right <= left:
            return False
        return (
            sum(
                all(
                    abs(pixels.getpixel((x, y))[index] - background[index]) <= 18
                    for index in range(3)
                )
                for x in range(left, right)
            )
            / (right - left)
            >= 0.90
        )

    band_top = reset["top"]
    while band_top > 0 and matches(band_top - 1):
        band_top -= 1
    band_bottom = reset["bottom"]
    while band_bottom < image.height and matches(band_bottom):
        band_bottom += 1
    return band_top, band_bottom


def _planned_element_boxes(
    blocks: list[dict[str, Any]],
    font: ImageFont.FreeTypeFont,
    common_x: float,
    top: int,
    line_height: int,
) -> list[tuple[int, int, int, int]]:
    boxes = []
    y = top
    for block in blocks:
        for row in block["rows"]:
            row_x = common_x
            for part in row["parts"]:
                if part["logo"] is not None:
                    bbox = font.getbbox(part["display_value"])
                    logo_y = int(round(y + (bbox[1] + bbox[3] - part["logo"].height) / 2))
                    boxes.append(
                        (
                            int(row_x),
                            logo_y,
                            int(row_x) + part["logo"].width,
                            logo_y + part["logo"].height,
                        )
                    )
                    row_x += part["logo"].width + int(round(0.4 * (bbox[3] - bbox[1])))
                bbox = font.getbbox(part["display_value"])
                boxes.append(
                    (
                        int(row_x),
                        int(y + bbox[1]),
                        int(row_x + font.getlength(part["display_value"])),
                        int(y + bbox[3]),
                    )
                )
                row_x += font.getlength(part["display_value"]) + int(
                    round(2 * (bbox[3] - bbox[1]))
                )
            y += line_height
        y += line_height
    return boxes


def _reset_elements_fit(
    image: Image.Image,
    reset: dict[str, Any],
    background: tuple[int, int, int],
    boxes: list[tuple[int, int, int, int]],
    band_top: int,
    band_bottom: int,
    delta: int,
    frame_left: int,
    frame_right: int,
    cap_height: int,
) -> bool:
    padding = max(1, int(round(cap_height * 0.15)))
    above_padding = padding
    cleared = image.copy()
    clear_draw = ImageDraw.Draw(cleared)
    for segment in reset["segments"]:
        clear_draw.rectangle(
            (
                max(0, int(segment["left"] - cap_height * 0.25)),
                max(0, int(segment["top"] - cap_height * 0.25)),
                min(image.width - 1, int(segment["right"] + cap_height * 0.25)),
                min(image.height - 1, int(segment["bottom"] + cap_height * 0.25)),
            ),
            fill=background,
        )
    pixels = cleared.convert("RGB")
    seam_y = min(image.height - 1, max(0, band_bottom - 1))
    seam = image.convert("RGB").crop((0, seam_y, image.width, seam_y + 1))
    row_references = []
    band_left = max(0, reset.get("left", min(s["left"] for s in reset["segments"])) - cap_height)
    band_right = min(image.width, reset.get("right", max(s["right"] for s in reset["segments"])) + cap_height)
    for y in range(
        max(
            0,
            reset.get("top", min(s["top"] for s in reset["segments"])) - cap_height,
        ),
        min(
            image.height,
            reset.get("top", min(s["top"] for s in reset["segments"])) + cap_height,
        ),
    ):
        row = [image.convert("RGB").getpixel((x, y)) for x in range(band_left, band_right)]
        reference = max(set(row), key=row.count)
        if sum(
            all(abs(pixel[i] - reference[i]) <= 18 for i in range(3))
            for pixel in row
        ) / max(1, len(row)) >= 0.80:
            row_references.append(reference)
    for left, top, right, bottom in boxes:
        if (
            left - padding < frame_left
            or right + padding > frame_right
            or left - padding < 0
            or right + padding > image.width
            or bottom + padding > band_bottom + delta
        ):
            return False
        check_bottom = min(image.height, band_bottom)
        for y in range(max(0, top - above_padding), min(check_bottom, bottom + padding)):
            for x in range(max(0, left - padding), min(image.width, right + padding)):
                if any(abs(pixels.getpixel((x, y))[i] - background[i]) > 18 for i in range(3)):
                    pixel = pixels.getpixel((x, y))
                    references = [seam.getpixel((x, 0))] + row_references
                    if any(
                        all(abs(pixel[i] - ref[i]) <= 18 for i in range(3))
                        for ref in references
                    ):
                        continue
                    return False
    return True


def _anchor(image: Image.Image) -> dict[str, Any] | None:
    ocr_lines, metadata = _ocr_lines(image)
    whole_lines = [
        line for line in ocr_lines if line.get("ocr_source") == "whole_image"
    ]
    alignment_segments = _contact_segments(whole_lines or ocr_lines)
    contacts = [
        segment
        for segment in alignment_segments
        if CONTACT_RE.search(segment["text"])
    ]
    if not contacts:
        return None
    anchor = dict(
        max(contacts, key=lambda segment: (segment["bottom"], _contact_score(segment)))
    )
    heights = sorted(
        height for segment in contacts for _word, height in segment["heights"]
    )
    tolerance = max(1, heights[len(heights) // 2])
    left_groups: list[list[dict[str, Any]]] = []
    for segment in sorted(contacts, key=lambda item: item["left"]):
        group = next(
            (
                group
                for group in left_groups
                if abs(group[0]["left"] - segment["left"]) <= tolerance
            ),
            None,
        )
        if group is None:
            left_groups.append([segment])
        else:
            group.append(segment)
    common = max(
        left_groups,
        key=lambda group: len({segment["text"] for segment in group}),
        default=[],
    )
    distinct_common = {segment["text"] for segment in common}
    anchor["alignment_left"] = (
        round(sum(segment["left"] for segment in common) / len(common), 2)
        if len(distinct_common) >= 2
        else None
    )
    anchor["contact_segments"] = contacts
    anchor["ocr_lines"] = ocr_lines
    anchor["ocr_metadata"] = metadata
    return anchor


def _normal_key(channel: str, value: str) -> tuple[str, str]:
    value = value.strip().lower()
    value = re.sub(r"^[a-z]+://", "", value)
    value = re.sub(r"^www\.", "", value)
    value = value.rstrip(".,;)")
    if channel in {"phone", "fax"}:
        return "digits", "".join(re.findall(r"\d", value))
    if channel == "email":
        return "email", value
    return "address", value


def _present_keys(lines: list[dict[str, Any]]) -> set[tuple[str, str]]:
    keys: set[tuple[str, str]] = set()
    for line in lines:
        text = line["text"].lower()
        for email in re.findall(r"[\w.+-]+@[\w.-]+\.[a-z]{2,}", text):
            keys.add(_normal_key("email", email))
        for address in re.findall(
            r"(?:https?://)?(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:/[^\s,;)]*)?",
            text,
        ):
            keys.add(_normal_key("website", address))
        digits = "".join(re.findall(r"\d", text))
        if digits:
            keys.add(("digits_line", digits))
    return keys


def _filter_existing(
    channels: list[tuple[str, str]], anchor: dict[str, Any]
) -> tuple[list[tuple[str, str]], list[dict[str, str]]]:
    lines = anchor.get("ocr_lines") or [anchor]
    present = _present_keys(lines)
    kept, discarded = [], []
    for channel, value in channels:
        key_type, key_value = _normal_key(channel, value)
        duplicate = (key_type, key_value) in present
        if key_type == "digits":
            duplicate = len(key_value) >= 6 and any(
                kind == "digits_line" and key_value in line_value
                for kind, line_value in present
            )
        if duplicate:
            discarded.append(
                {"channel": channel, "value": value, "reason": "already_present"}
            )
        else:
            kept.append((channel, value))
    return kept, discarded


def _content_end(image: Image.Image, background: tuple[int, int, int]) -> int:
    for y in range(image.height - 1, -1, -1):
        if not _row_uniform(image, y, background):
            return y + 1
    return 0


def _uniform_rows(
    image: Image.Image,
    start: int,
    end: int,
    background: tuple[int, int, int],
) -> bool:
    return start >= 0 and end <= image.height and start < end and all(
        _row_uniform(image, y, background) for y in range(start, end)
    )


def _column_uniform(
    image: Image.Image,
    x: int,
    background: tuple[int, int, int],
    tolerance: int = 18,
    coverage: float = 0.90,
) -> bool:
    if x < 0 or x >= image.width:
        return False
    column = list(image.convert("RGB").crop((x, 0, x + 1, image.height)).getdata())
    if not column:
        return False
    matching = sum(
        all(
            abs(channel - background[index]) <= tolerance
            for index, channel in enumerate(pixel)
        )
        for pixel in column
    )
    return matching / len(column) >= coverage


def _content_bounds(
    image: Image.Image,
    background: tuple[int, int, int],
) -> tuple[int, int] | None:
    active = [
        x for x in range(image.width) if not _column_uniform(image, x, background)
    ]
    if not active:
        return None
    return min(active), max(active) + 1


def _layout_height(
    blocks: list[dict[str, Any]],
    line_height: int,
    block_gap: int,
    font: ImageFont.FreeTypeFont,
    cap_height: int,
    bottom_air: int,
) -> tuple[int, int]:
    offset = 0
    glyph_bottom = 0
    for block in blocks:
        for row in block["rows"]:
            row_bottom = max(
                [font.getbbox(part["value"])[3] for part in row["parts"]]
                + [cap_height]
            )
            glyph_bottom = max(glyph_bottom, offset + row_bottom)
            offset += line_height
        offset += block_gap
    return glyph_bottom + bottom_air, glyph_bottom


def _average(pixels: list[tuple[int, int, int]]) -> tuple[int, int, int]:
    return tuple(
        sum(pixel[index] for pixel in pixels) // len(pixels) for index in range(3)
    )


def _colours(
    image: Image.Image, anchor: dict[str, Any]
) -> tuple[tuple[int, int, int], tuple[int, int, int]] | None:
    box = image.crop(
        (anchor["left"], anchor["top"], anchor["right"], anchor["bottom"])
    ).convert("RGB")
    pixels = list(box.getdata())
    if not pixels:
        return None
    luma = sorted(
        pixels,
        key=lambda pixel: 0.299 * pixel[0] + 0.587 * pixel[1] + 0.114 * pixel[2],
    )
    sample = max(1, len(luma) // 20)
    dark, light = luma[:sample], luma[-sample:]
    start = min(image.height, anchor["bottom"])
    end = min(image.height, start + 3)
    if end == start:
        start = max(0, start - 3)
        end = min(image.height, start + 3)
    strip_pixels = list(
        image.crop((0, start, image.width, end)).convert("RGB").getdata()
    )
    if not strip_pixels:
        return None
    background = max(set(strip_pixels), key=strip_pixels.count)
    background_luma = (
        0.299 * background[0] + 0.587 * background[1] + 0.114 * background[2]
    )
    return (_average(dark) if background_luma > 127 else _average(light), background)


def _font_path(bold: bool) -> str | None:
    for candidate in FONT_CANDIDATES[bold]:
        if Path(candidate).is_file():
            return candidate
    return None


def _fit_font(
    text: str,
    height: int,
    bold: bool,
    max_width: int | None = None,
) -> ImageFont.FreeTypeFont | None:
    path = _font_path(bold)
    if path is None:
        return None
    best = None
    for size in range(max(1, min(8, height)), max(10, height * 4)):
        font = ImageFont.truetype(path, size)
        box = font.getbbox(text)
        fits_height = box[3] - box[1] <= height
        fits_width = max_width is None or box[2] - box[0] <= max_width
        if fits_height and fits_width:
            best = font
        elif best is not None and box[3] - box[1] > height:
            break
    return best


def _is_bold(
    image: Image.Image,
    anchor: dict[str, Any],
    text_colour: tuple[int, int, int],
    background: tuple[int, int, int],
) -> bool:
    pixels = list(
        image.crop(
            (anchor["left"], anchor["top"], anchor["right"], anchor["bottom"])
        ).convert("RGB").getdata()
    )
    if not pixels:
        return False

    def near(pixel: tuple[int, int, int], reference: tuple[int, int, int]) -> bool:
        return sum(abs(pixel[index] - reference[index]) for index in range(3)) < 150

    ink = sum(
        1 for pixel in pixels if near(pixel, text_colour) and not near(pixel, background)
    )
    return ink / len(pixels) > 0.2


def _snap(colour: tuple[int, int, int]) -> tuple[int, int, int]:
    return tuple(
        255 if channel > 235 else 0 if channel < 20 else channel for channel in colour
    )


def _row_uniform(
    image: Image.Image,
    y: int,
    background: tuple[int, int, int],
    tolerance: int = 18,
    coverage: float = 0.90,
) -> bool:
    if y < 0 or y >= image.height:
        return False
    row = list(image.convert("RGB").crop((0, y, image.width, y + 1)).getdata())
    if not row:
        return False
    matching = sum(
        all(
            abs(channel - background[index]) <= tolerance
            for index, channel in enumerate(pixel)
        )
        for pixel in row
    )
    return matching / len(row) >= coverage


def _band_end(
    image: Image.Image,
    anchor: dict[str, Any],
    background: tuple[int, int, int],
    tolerance: int = 12,
) -> int:
    pixels = image.convert("RGB")
    left = max(0, anchor["left"] - 2)
    right = min(image.width, anchor["right"] + 2)
    end = min(image.height, anchor["bottom"])
    for y in range(end, image.height):
        row = list(pixels.crop((left, y, right, y + 1)).getdata())
        if row and all(
            all(
                abs(channel - background[index]) <= tolerance
                for index, channel in enumerate(pixel)
            )
            for pixel in row
        ):
            end = y + 1
        else:
            break
    return end


def _append_geometry(
    image: Image.Image,
    background: tuple[int, int, int],
    line_height: int,
) -> tuple[int, int]:
    content_end = _content_end(image, background)
    insertion_gap = max(1, int(round(line_height / 2)))
    return content_end, insertion_gap


def _channel_value(
    item: str | tuple[str, str] | Mapping[str, str],
) -> tuple[str, str]:
    if isinstance(item, Mapping):
        channel = item.get("field_name", item.get("channel", ""))
        value = item.get("value", "")
    elif isinstance(item, tuple) and len(item) == 2:
        channel, value = item
    else:
        value = item
        lowered = value.lower()
        channel = (
            "fax"
            if lowered.startswith("fax")
            else "facebook"
            if "facebook." in lowered
            else "instagram"
            if "instagram." in lowered
            else "website"
            if "www." in lowered or ".de" in lowered
            else "phone"
        )
    return str(channel).strip().lower(), str(value).strip()


def _display_value(channel: str, value: str) -> str:
    if channel in {"phone", "fax"}:
        value = re.sub(
            r"^\s*(?:telefax|fax|telefon|tel\.?|phone)\s*[:\-]?\s*",
            "",
            value,
            flags=re.I,
        )
        return f"{'T' if channel == 'phone' else 'F'} {value}"
    if channel in {"facebook", "instagram"}:
        return re.sub(r"^(?:[a-z]+://)?(?:www\.)?", "", value.strip(), flags=re.I)
    return value


def _asset(channel: str, cap_height: int) -> Image.Image | None:
    path = SOCIAL_ASSETS / f"{channel}.png"
    if not path.is_file():
        return None
    logo_height = max(1, int(round(cap_height * 1.2)))
    return Image.open(path).convert("RGBA").resize(
        (logo_height, logo_height), Image.Resampling.LANCZOS
    )


def _group_lines(
    values: list[tuple[str, str]],
    draw: ImageDraw.ImageDraw,
    font: ImageFont.FreeTypeFont,
    cap_height: int,
    available: int,
) -> list[dict[str, Any]]:
    groups = [
        ("phone", [item for item in values if item[0] in {"phone", "fax"}]),
        ("email_web", [item for item in values if item[0] in {"email", "website"}]),
        (
            "social",
            [
                item
                for item in values
                if item[0] not in {"phone", "fax", "email", "website"}
            ],
        ),
    ]
    result = []
    pair_gap = int(round(2 * cap_height))
    logo_gap = int(round(0.4 * cap_height))
    for name, items in groups:
        if not items:
            continue
        order = (
            {"phone": 0, "fax": 1}
            if name == "phone"
            else {"email": 0, "website": 1}
            if name == "email_web"
            else {}
        )
        items = sorted(items, key=lambda item: order.get(item[0], 99))
        rows = []
        if name == "phone" and len(items) == 2:
            widths = [
                draw.textlength(_display_value(channel, value), font=font)
                for channel, value in items
            ]
            if sum(widths) + pair_gap <= available:
                rows.append(items)
            else:
                rows.extend((item,) for item in items)
        elif name == "email_web":
            rows.extend((item,) for item in items)
        else:
            rows.extend((item,) for item in items)
        row_specs = []
        for row in rows:
            parts = []
            width = 0
            for channel, value in row:
                logo = _asset(channel, cap_height) if name == "social" else None
                display_value = _display_value(channel, value)
                text_width = draw.textlength(display_value, font=font)
                if parts:
                    width += pair_gap
                if logo is not None:
                    width += logo.width + logo_gap
                width += text_width
                parts.append(
                    {
                        "channel": channel,
                        "value": value,
                        "display_value": display_value,
                        "logo": logo,
                        "logo_used": logo is not None,
                        "text_width": round(text_width, 2),
                    }
                )
            row_specs.append({"parts": parts, "width": round(width, 2)})
        result.append(
            {
                "name": name,
                "rows": row_specs,
                "width": max(row["width"] for row in row_specs),
            }
        )
    return result


def compose_extra_lines(
    image: Image.Image,
    values: Sequence[str | tuple[str, str] | Mapping[str, str]],
) -> ExtraLineComposition:
    source = image.convert("RGB")
    channels = [_channel_value(value) for value in values]
    channels = [(channel, value) for channel, value in channels if value]
    line_values = [value for _channel, value in channels]
    if not channels:
        return ExtraLineComposition(
            source.copy(), {"status": "skipped", "reason": "no_lines", "lines": []}
        )
    anchor = _anchor(source)
    if anchor is None:
        return ExtraLineComposition(
            source.copy(),
            {
                "status": "skipped",
                "reason": "no_contact_line",
                "lines": line_values,
            },
        )
    reset = _reset_block(anchor)
    reset_skip_reason = (
        "mixed_or_uncertain_contact_block"
        if reset is None and anchor.get("contact_segments")
        else None
    )
    reset_colours = None
    if reset is not None:
        reset_colours = _reset_background(source, reset["segments"])
        if reset_colours is None:
            reset = None
            reset_skip_reason = "non_homogeneous_background"
    channels, discarded = _filter_existing(channels, anchor)
    line_values = [value for _channel, value in channels]
    if not channels:
        return ExtraLineComposition(
            source.copy(),
            {
                "status": "skipped",
                "reason": "all_lines_already_present",
                "lines": [],
                "discarded": discarded,
                "ocr": anchor.get("ocr_metadata", {}),
            },
        )
    reset_values = reset["values"] if reset is not None else []
    requested_channels = list(channels)
    rendered_keys: set[tuple[str, str]] = set()
    render_channels = []
    for channel, value in [*reset_values, *channels]:
        key = _normal_key(channel, value)
        if key in rendered_keys:
            continue
        rendered_keys.add(key)
        render_channels.append((channel, value))
    if reset is not None and any(
        _normal_key(channel, value) not in rendered_keys
        for channel, value in reset_values
    ):
        reset = None
        reset_skip_reason = "removed_value_not_preserved"
        render_channels = channels
    channels = render_channels
    colours = _colours(source, anchor)
    if colours is None:
        return ExtraLineComposition(
            source.copy(),
            {
                "status": "skipped",
                "reason": "no_colour_measurement",
                "lines": line_values,
                "discarded": discarded,
            },
        )
    text_colour, background = colours
    if reset_colours is not None:
        text_colour, background = reset_colours
    text_colour = _snap(text_colour)
    anchor_heights = sorted(
        [height for word, height in anchor["heights"] if CONTACT_RE.search(word)]
        or [height for _word, height in anchor["heights"]]
    )
    contact_heights = []
    for line in anchor.get("ocr_lines", [anchor]):
        line_heights = [
            height
            for word, height in line.get("heights", [])
            if CONTACT_RE.search(word)
        ]
        if not line_heights and CONTACT_RE.search(line.get("text", "")):
            line_heights = [height for _word, height in line.get("heights", [])]
        contact_heights.extend(line_heights)
    reference_heights = sorted(contact_heights or anchor_heights)
    anchor_height = anchor_heights[len(anchor_heights) // 2]
    reference_height = reference_heights[len(reference_heights) // 2]
    cap_height = max(1, reference_height)
    bold = _is_bold(source, anchor, text_colour, background)
    line_height = max(1, int(round(cap_height * 1.75)))
    block_gap = max(1, int(round(cap_height * 0.9)))
    bottom_air = max(1, int(round(cap_height * 0.35)))
    band_end = _band_end(source, anchor, background)
    band_fits = band_end - anchor["bottom"] >= line_height * 0.4 and _row_uniform(
        source, band_end - 1, background
    )
    if reset is not None:
        band_fits = True
        band_end = reset["top"]
    content_end_value = None
    insertion_gap = None
    if reset is None and not band_fits:
        bottom = list(
            source.crop(
                (0, max(0, source.height - 3), source.width, source.height)
            ).getdata()
        )
        if not bottom:
            return ExtraLineComposition(
                source.copy(),
                {
                    "status": "skipped",
                    "reason": "no_colour_measurement",
                    "lines": line_values,
                    "discarded": discarded,
                },
            )
        background = max(set(bottom), key=bottom.count)
        text_colour = (0, 0, 0) if sum(background) > 381 else (255, 255, 255)
        content_end_value, insertion_gap = _append_geometry(
            source, background, line_height
        )
        band_end = content_end_value + insertion_gap
    content_bounds = _content_bounds(source, _edge_colour(source)) or (
        0,
        source.width,
    )
    content_left, content_right = content_bounds
    margin = max(int(round(source.width * 0.04)), cap_height)
    left_limit = content_left + margin
    right_limit = content_right - margin
    inline_fax = None
    fax_values = [item for item in requested_channels if item[0] == "fax"]
    if len(fax_values) == 1 and not any(
        item[0] == "phone" for item in requested_channels
    ):
        fax_value = fax_values[0]
        for segment in anchor.get("contact_segments", []):
            segment_values = _contact_values(segment.get("text", ""))
            if not any(channel == "phone" for channel, _value in segment_values):
                continue
            area = _inline_fax_area(
                source, segment, content_right, margin, cap_height
            )
            if area is not None:
                inline_fax = {
                    "channel": fax_value[0],
                    "value": fax_value[1],
                    "segment": segment,
                    "left": area[0],
                    "right": area[1],
                    "top": area[2],
                    "background": area[3],
                }
                break
    fax_inline_reason = None if inline_fax else (
        "no_homogeneous_space" if fax_values else None
    )
    if inline_fax:
        channels = [item for item in channels if item[0] != "fax"]
        if reset is not None:
            channels = [
                *reset_values,
                *[
                    item
                    for item in channels
                    if _normal_key(*item)
                    not in {_normal_key(*value) for value in reset_values}
                ],
            ]
    if anchor.get("alignment_left") is not None:
        centred = False
    else:
        centred = (
            abs((anchor["left"] + anchor["right"]) / 2 - source.width / 2)
            < source.width * 0.06
        )
    desired_left = max(
        left_limit,
        (
            anchor["alignment_left"]
            if anchor.get("alignment_left") is not None
            else anchor["left"]
        ),
    )
    max_available = (
        max(0, right_limit - desired_left)
        if reset is not None and not centred
        else right_limit - left_limit
    )
    if max_available <= 0:
        return ExtraLineComposition(
            source.copy(),
            {
                "status": "skipped",
                "reason": "no_line_space",
                "lines": line_values,
                "discarded": discarded,
            },
        )
    probe = _fit_font("X", cap_height, bold)
    draw_probe = ImageDraw.Draw(source)
    if probe is None:
        return ExtraLineComposition(
            source.copy(),
            {
                "status": "skipped",
                "reason": "font_not_found",
                "lines": line_values,
                "discarded": discarded,
            },
        )
    font = None
    blocks = []
    font_path = _font_path(bold)
    if font_path is None:
        return ExtraLineComposition(
            source.copy(),
            {
                "status": "skipped",
                "reason": "font_not_found",
                "lines": line_values,
                "discarded": discarded,
            },
        )
    minimum_font_size = max(1, math.ceil(probe.size * FONT_MINIMUM_SCALE))
    inline_font = None
    if inline_fax is not None:
        display = _display_value(inline_fax["channel"], inline_fax["value"])
        inline_minimum = max(
            1,
            math.ceil(
                (inline_fax["segment"]["bottom"] - inline_fax["segment"]["top"])
                * FONT_MINIMUM_SCALE
            ),
        )
        inline_size = min(
            probe.size,
            max(
                inline_minimum,
                int(round(probe.size * (
                    (inline_fax["segment"]["bottom"] - inline_fax["segment"]["top"])
                    / max(1, cap_height)
                ))),
            ),
        )
        for size in range(inline_size, inline_minimum - 1, -1):
            candidate = ImageFont.truetype(font_path, size)
            bbox = draw_probe.textbbox((0, 0), display, font=candidate)
            if bbox[2] - bbox[0] <= inline_fax["right"] - inline_fax["left"]:
                inline_font = candidate
                break
        if inline_font is None:
            inline_fax = None
            fax_inline_reason = "rendered_text_does_not_fit"
            channels = list(render_channels)

    def fit_blocks(values_to_fit, available: int, minimum_size: int):
        for size in range(probe.size, minimum_size - 1, -1):
            candidate = ImageFont.truetype(font_path, size)
            candidate_blocks = _group_lines(
                values_to_fit, draw_probe, candidate, cap_height, available
            )
            if all(block["width"] <= available for block in candidate_blocks):
                return candidate, candidate_blocks
        return None, []

    probe_blocks = _group_lines(
        channels, draw_probe, probe, cap_height, max_available
    )
    if all(block["width"] <= max_available for block in probe_blocks):
        font, blocks = probe, probe_blocks
    else:
        font, blocks = fit_blocks(channels, max_available, minimum_font_size)
    if font is None:
        return ExtraLineComposition(
            source.copy(),
            {
                "status": "skipped",
                "reason": "font_below_readability_threshold",
                "lines": line_values,
                "discarded": discarded,
                "font_minimum_scale": FONT_MINIMUM_SCALE,
                "font_minimum_size": minimum_font_size,
            },
        )
    content_height, glyph_bottom = _layout_height(
        blocks, line_height, block_gap, font, cap_height, bottom_air
    )
    font_floor_applied = probe.size > minimum_font_size and font.size == minimum_font_size
    if reset is not None:
        band_top, band_bottom = _reset_band(
            source, reset, background, cap_height
        )
        available_bottom = band_bottom - reset["top"] - bottom_air
        block_width = max((block["width"] for block in blocks), default=0)
        span_left = max(0, int(round(desired_left - cap_height * 0.35)))
        span_right = min(
            source.width,
            int(round(desired_left + block_width + cap_height * 0.35)),
        )
        homogeneous_room = (
            content_height <= available_bottom
            and _seam_repeatable(
                source,
                band_bottom - max(1, cap_height // 2),
                band_bottom,
                span_left,
                span_right,
            )
        )
        movable_artwork = _seam_repeatable(
            source,
            band_bottom - max(1, cap_height // 2),
            band_bottom,
            span_left,
            span_right,
        )
        stable_seam = _seam_band_stable(
            source,
            band_bottom - max(1, cap_height // 2),
            band_bottom,
            span_left,
            span_right,
        ) or _seam_band_stable(
            source,
            band_bottom - max(1, cap_height // 2),
            band_bottom,
            reset["left"],
            reset["right"],
        ) or _columnwise_homogeneous(
            source,
            max(band_top, band_bottom - 12),
            band_bottom,
            left=reset["left"],
            right=reset["right"],
        )
        delta = max(0, content_height - available_bottom)
        growth = delta
        max_block_width = max((block["width"] for block in blocks), default=0)
        planned_common_x = (
            content_left + (content_right - content_left - max_block_width) / 2
            if centred
            else desired_left
        )
        planned_common_x = max(
            left_limit,
            min(planned_common_x, right_limit - max_block_width),
        )
        placement_top = reset["top"]
        placement_safe = False
        max_top = band_bottom + delta - content_height
        step = max(1, int(round(cap_height * 0.5)))
        candidates = [
            candidate
            for candidate in range(reset["top"], max(reset["top"], max_top) + 1, step)
        ]
        if max_top >= reset["top"] and max_top not in candidates:
            candidates.append(max_top)
        clearance = max(1, int(round(cap_height * 0.15)))
        for candidate_top in candidates:
            candidate_boxes = _planned_element_boxes(
                blocks,
                font,
                planned_common_x,
                candidate_top,
                line_height,
            )
            candidate_delta = max(
                0,
                max((box[3] for box in candidate_boxes), default=0)
                + clearance
                + bottom_air
                - band_bottom,
            )
            if candidate_delta > int(round(source.height * 0.25)):
                continue
            if _reset_elements_fit(
                source,
                reset,
                background,
                candidate_boxes,
                band_top,
                band_bottom,
                candidate_delta,
                content_left,
                content_right,
                cap_height,
            ):
                placement_top = candidate_top
                placement_safe = True
                delta = candidate_delta
                growth = candidate_delta
                break
        if growth > int(round(source.height * 0.25)) or (
            not homogeneous_room and not movable_artwork and not stable_seam
        ) or not placement_safe:
            reset = None
            reset_values = []
            channels = list(requested_channels)
            reset_skip_reason = (
                "elements_overlap_existing_content"
                if not placement_safe
                else "no_room_without_moving_artwork"
            )
            band_fits = False
            bottom = list(
                source.crop(
                    (0, max(0, source.height - 3), source.width, source.height)
                ).getdata()
            )
            background = max(set(bottom), key=bottom.count)
            text_colour = (0, 0, 0) if sum(background) > 381 else (255, 255, 255)
            content_end_value, insertion_gap = _append_geometry(
                source, background, line_height
            )
            band_end = content_end_value + insertion_gap
            probe_blocks = _group_lines(
                channels, draw_probe, probe, cap_height, max_available
            )
            font, blocks = (
                (probe, probe_blocks)
                if all(block["width"] <= max_available for block in probe_blocks)
                else fit_blocks(channels, max_available, minimum_font_size)
            )
            if font is None:
                return ExtraLineComposition(
                    source.copy(),
                    {
                        "status": "skipped",
                        "reason": "font_below_readability_threshold",
                        "lines": line_values,
                        "discarded": discarded,
                    },
                )
            content_height, glyph_bottom = _layout_height(
                blocks, line_height, block_gap, font, cap_height, bottom_air
            )
        else:
            if delta:
                grown = Image.new("RGB", (source.width, source.height + delta))
                grown.paste(source.crop((0, 0, source.width, band_bottom)), (0, 0))
                seam = source.crop((0, band_bottom - 1, source.width, band_bottom))
                for offset in range(delta):
                    grown.paste(seam, (0, band_bottom + offset))
                grown.paste(
                    source.crop((0, band_bottom, source.width, source.height)),
                    (0, band_bottom + delta),
                )
            else:
                grown = source.copy()
            reset_draw = ImageDraw.Draw(grown)
            for segment in reset["segments"]:
                padding = max(1, int(round(cap_height * 0.25)))
                reset_draw.rectangle(
                    (
                        max(0, segment["left"] - padding),
                        max(0, segment["top"] - padding),
                        min(grown.width - 1, segment["right"] + padding),
                        min(grown.height - 1, segment["bottom"] + padding),
                    ),
                    fill=background,
                )
            band_end = placement_top
    if reset is None and not band_fits:
        available = max(0, source.height - band_end)
        fits_margin = available >= content_height and _uniform_rows(
            source, band_end, band_end + content_height, background
        )
        required_height = band_end + content_height
        output_height = source.height if fits_margin else max(
            source.height, required_height
        )
        grown = source.copy() if fits_margin else Image.new(
            "RGB", (source.width, output_height), background
        )
        if not fits_margin:
            grown.paste(source, (0, 0))
    elif reset is None:
        grown = Image.new("RGB", (source.width, source.height + content_height), background)
        grown.paste(source.crop((0, 0, source.width, band_end)), (0, 0))
    if reset is None and band_fits:
        seam = source.crop((0, band_end - 1, source.width, band_end))
        for offset in range(content_height):
            grown.paste(seam, (0, band_end + offset))
        grown.paste(
            source.crop((0, band_end, source.width, source.height)),
            (0, band_end + content_height),
        )
    draw = ImageDraw.Draw(grown)
    y = band_end
    manifest_blocks = []
    max_block_width = max((block["width"] for block in blocks), default=0)
    desired_common_x = (
        content_left + (content_right - content_left - max_block_width) / 2
        if centred
        else desired_left
    )
    common_x = max(
        left_limit,
        min(desired_common_x, right_limit - max_block_width),
    )
    if inline_fax is not None:
        fax_display = _display_value(inline_fax["channel"], inline_fax["value"])
        inline_font = inline_font or font
        inline_bbox = draw.textbbox((0, 0), fax_display, font=inline_font)
        inline_y = inline_fax["segment"]["bottom"] - inline_bbox[3]
        draw.text(
            (inline_fax["left"], inline_y),
            fax_display,
            font=inline_font,
            fill=text_colour,
        )
    for block in blocks:
        block_start = y
        block_x = common_x
        shifted = not centred and abs(common_x - desired_left) > 0.01
        rows_manifest = []
        for row in block["rows"]:
            row_x = block_x
            row_parts = []
            for part in row["parts"]:
                start_x = row_x
                logo_position = None
                if part["logo"] is not None:
                    bbox = font.getbbox(part["display_value"])
                    logo_y = int(round(y + (bbox[1] + bbox[3] - part["logo"].height) / 2))
                    logo_position = [round(row_x, 2), logo_y]
                    grown.paste(part["logo"], (int(row_x), logo_y), part["logo"])
                    row_x += part["logo"].width + int(round(0.4 * cap_height))
                draw.text(
                    (int(row_x), int(y)),
                    part["display_value"],
                    font=font,
                    fill=text_colour,
                )
                row_x += draw.textlength(
                    part["display_value"], font=font
                ) + int(round(2 * cap_height))
                row_parts.append(
                    {
                        "channel": part["channel"],
                        "value": part["value"],
                        "display_value": part["display_value"],
                        "logo_used": part["logo_used"],
                        "position": [round(start_x, 2), y],
                        "logo_position": logo_position,
                        "logo_size": (
                            list(part["logo"].size) if part["logo"] is not None else None
                        ),
                    }
                )
            rows_manifest.append(
                {
                    "parts": row_parts,
                    "logo_used": all(part["logo_used"] for part in row_parts),
                    "position": [round(block_x, 2), y],
                    "width": round(row["width"], 2),
                }
            )
            y += line_height
        y += block_gap
        manifest_blocks.append(
            {
                "name": block["name"],
                "width": block["width"],
                "rows": rows_manifest,
                "top": block_start,
                "shifted": shifted,
            }
        )
    return ExtraLineComposition(
        grown,
        {
            "status": "composed",
            "placement": "block_reset" if reset is not None else (
                "contact_bar" if band_fits else "appended_strip"
            ),
            "mode": "block_reset" if reset is not None else "append",
            "anchor_text": anchor["text"],
            "anchor_box": [
                anchor["left"],
                anchor["top"],
                anchor["right"],
                anchor["bottom"],
            ],
            "text_colour": list(text_colour),
            "background": list(background),
            "content_bounds": list(content_bounds),
            "font_size": font.size,
            "font_minimum_scale": FONT_MINIMUM_SCALE if font_floor_applied else None,
            "font_minimum_size": minimum_font_size if font_floor_applied else None,
            "bold": bold,
            "band_end": band_end,
            "content_end": content_end_value,
            "insertion_gap": insertion_gap,
            "centred": centred,
            "anchor_height": anchor_height,
            "cap_height": cap_height,
            "reference_height": reference_height,
            "line_height": line_height,
            "block_gap": block_gap,
            "lines": line_values,
            "discarded": discarded,
            "removed_communication_values": [
                {"channel": channel, "value": value}
                for channel, value in (reset_values if reset is not None else [])
            ],
            "set_values": [
                {"channel": channel, "value": value}
                for channel, value in (
                    channels
                    + (
                        [(inline_fax["channel"], inline_fax["value"])]
                        if inline_fax is not None
                        else []
                    )
                )
            ],
            "block_reset_skipped_reason": reset_skip_reason,
            "fax_inline": inline_fax is not None,
            "fax_inline_reason": fax_inline_reason,
            "fax_inline_target": (
                {
                    "text": inline_fax["segment"]["text"],
                    "box": [
                        inline_fax["segment"]["left"],
                        inline_fax["segment"]["top"],
                        inline_fax["segment"]["right"],
                        inline_fax["segment"]["bottom"],
                    ],
                }
                if inline_fax is not None
                else None
            ),
            "blocks": manifest_blocks,
            "ocr": anchor.get("ocr_metadata", {}),
            "grew": grown.height > source.height,
            "output_size": list(grown.size),
            "glyph_bottom": glyph_bottom,
            "bottom_air": bottom_air,
        },
    )
