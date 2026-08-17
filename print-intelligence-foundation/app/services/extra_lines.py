from dataclasses import dataclass
from pathlib import Path
import re
from typing import Any, Mapping, Sequence

import pytesseract
from PIL import Image, ImageDraw, ImageFont, ImageOps


CONTACT_RE = re.compile(r"(@|www\.|\.de\b|tel\.|telefon|fax|\d{3,})", re.I)
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
                "left": left,
                "top": top,
                "right": left,
                "bottom": top,
            },
        )
        line["text"].append(text)
        line["heights"].append((text, data["height"][index]))
        line["left"] = min(line["left"], left)
        line["top"] = min(line["top"], top)
        line["right"] = max(line["right"], left + data["width"][index])
        line["bottom"] = max(line["bottom"], top + data["height"][index])
    for line in grouped.values():
        line["text"] = " ".join(line["text"])
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
        ocr_lines.extend(_lines(candidate))
    bands, metadata = _content_bands(image, _edge_colour(image))
    for top, bottom in bands:
        band = image.crop((0, top, image.width, bottom))
        ocr_lines.extend(
            _lines(band, config="--psm 6", offset=(0, top))
        )
    return ocr_lines, metadata


def _anchor(image: Image.Image) -> dict[str, Any] | None:
    ocr_lines, metadata = _ocr_lines(image)
    contacts = [line for line in ocr_lines if CONTACT_RE.search(line["text"])]
    if not contacts:
        return None
    anchor = dict(max(contacts, key=lambda line: line["bottom"]))
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


def _asset(channel: str, cap_height: int) -> Image.Image | None:
    path = SOCIAL_ASSETS / f"{channel}.png"
    if not path.is_file():
        return None
    return Image.open(path).convert("RGBA").resize(
        (cap_height, cap_height), Image.Resampling.LANCZOS
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
        if name != "social" and len(items) == 2:
            widths = [draw.textlength(value, font=font) for _channel, value in items]
            if sum(widths) + pair_gap <= available:
                rows.append(items)
            else:
                rows.extend((item,) for item in items)
        else:
            rows.extend((item,) for item in items)
        row_specs = []
        for row in rows:
            parts = []
            width = 0
            for channel, value in row:
                logo = _asset(channel, cap_height) if name == "social" else None
                text_width = draw.textlength(value, font=font)
                if parts:
                    width += pair_gap
                if logo is not None:
                    width += cap_height + logo_gap
                width += text_width
                parts.append(
                    {
                        "channel": channel,
                        "value": value,
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
    content_end_value = None
    insertion_gap = None
    if not band_fits:
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
        content_end = _content_end(source, background)
        gap = max(1, int(round(line_height / 2)))
        content_end_value = content_end
        insertion_gap = gap
        band_end = content_end + gap
    centred = (
        True
        if not band_fits
        else abs((anchor["left"] + anchor["right"]) / 2 - source.width / 2)
        < source.width * 0.06
    )
    content_bounds = _content_bounds(source, _edge_colour(source)) or (
        0,
        source.width,
    )
    content_left, content_right = content_bounds
    margin = max(int(round(source.width * 0.04)), cap_height)
    left_limit = content_left + margin
    right_limit = content_right - margin
    max_available = right_limit - left_limit
    desired_left = max(left_limit, anchor["left"])
    left_available = right_limit - desired_left
    shifted_for_fit = False
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
    if left_available <= 0:
        desired_left = left_limit
        left_available = max_available
        shifted_for_fit = True
    probe = _fit_font("X", cap_height, bold)
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
    draw_probe = ImageDraw.Draw(source)
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
    def fit_blocks(available: int):
        for size in range(probe.size, 0, -1):
            candidate = ImageFont.truetype(font_path, size)
            candidate_blocks = _group_lines(
                channels, draw_probe, candidate, cap_height, available
            )
            if all(block["width"] <= available for block in candidate_blocks):
                return candidate, candidate_blocks
        return None, []

    font, blocks = fit_blocks(max_available if centred else left_available)
    if font is None and not centred and desired_left != left_limit:
        desired_left = left_limit
        shifted_for_fit = True
        font, blocks = fit_blocks(max_available)
    if font is None:
        return ExtraLineComposition(
            source.copy(),
            {
                "status": "skipped",
                "reason": "no_line_space",
                "lines": line_values,
                "discarded": discarded,
            },
        )
    content_height, glyph_bottom = _layout_height(
        blocks, line_height, block_gap, font, cap_height, bottom_air
    )
    if not band_fits:
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
    else:
        grown = Image.new("RGB", (source.width, source.height + content_height), background)
        grown.paste(source.crop((0, 0, source.width, band_end)), (0, 0))
    if band_fits:
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
    for block in blocks:
        block_start = y
        desired_x = (
            (
                content_left + (content_right - content_left - block["width"]) / 2
                if centred
                else desired_left
            )
        )
        block_x = max(
            left_limit, min(desired_x, right_limit - block["width"])
        )
        shifted = shifted_for_fit or (
            not centred and abs(block_x - desired_x) > 0.01
        )
        rows_manifest = []
        for row in block["rows"]:
            row_x = block_x
            row_parts = []
            for part in row["parts"]:
                start_x = row_x
                if part["logo"] is not None:
                    grown.paste(part["logo"], (int(row_x), int(y)), part["logo"])
                    row_x += cap_height + int(round(0.4 * cap_height))
                draw.text((int(row_x), int(y)), part["value"], font=font, fill=text_colour)
                row_x += draw.textlength(part["value"], font=font) + int(round(2 * cap_height))
                row_parts.append(
                    {
                        "channel": part["channel"],
                        "value": part["value"],
                        "logo_used": part["logo_used"],
                        "position": [round(start_x, 2), y],
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
            "placement": "contact_bar" if band_fits else "appended_strip",
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
            "blocks": manifest_blocks,
            "ocr": anchor.get("ocr_metadata", {}),
            "grew": grown.height > source.height,
            "output_size": list(grown.size),
            "glyph_bottom": glyph_bottom,
            "bottom_air": bottom_air,
        },
    )
