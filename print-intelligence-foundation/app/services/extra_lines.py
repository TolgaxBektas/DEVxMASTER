from dataclasses import dataclass
import re
from typing import Any, Sequence

import pytesseract
from PIL import Image, ImageDraw, ImageFont


FONT_REGULAR = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
CONTACT_RE = re.compile(
    r"(@|www\.|\.de\b|tel\.|telefon|fax|\d{3,})",
    re.I,
)


@dataclass(frozen=True)
class ExtraLineComposition:
    image: Image.Image
    manifest: dict[str, Any]


def _lines(image: Image.Image) -> list[dict[str, Any]]:
    data = pytesseract.image_to_data(
        image, lang="deu", output_type=pytesseract.Output.DICT
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
        left, top = data["left"][index], data["top"][index]
        right = left + data["width"][index]
        bottom = top + data["height"][index]
        line = grouped.setdefault(
            key,
            {
                "text": [],
                "heights": [],
                "left": left,
                "top": top,
                "right": right,
                "bottom": bottom,
            },
        )
        line["text"].append(text)
        line["heights"].append((text, data["height"][index]))
        line["left"] = min(line["left"], left)
        line["top"] = min(line["top"], top)
        line["right"] = max(line["right"], right)
        line["bottom"] = max(line["bottom"], bottom)
    for line in grouped.values():
        line["text"] = " ".join(line["text"])
    return sorted(grouped.values(), key=lambda line: line["top"])


def _anchor(image: Image.Image) -> dict[str, Any] | None:
    from PIL import ImageOps

    grey = image.convert("L")
    found = []
    for candidate_image in (
        image,
        ImageOps.autocontrast(grey),
        ImageOps.invert(image.convert("RGB")),
    ):
        lines = [
            line for line in _lines(candidate_image) if CONTACT_RE.search(line["text"])
        ]
        if lines:
            found.append(lines[-1])
    if not found:
        return None
    return max(found, key=lambda line: line["bottom"])


def _average(pixels: list[tuple[int, int, int]]) -> tuple[int, int, int]:
    count = len(pixels)
    return tuple(sum(pixel[index] for pixel in pixels) // count for index in range(3))


def _colours(
    image: Image.Image, anchor: dict[str, Any]
) -> tuple[tuple[int, int, int], tuple[int, int, int]]:
    box = image.crop(
        (anchor["left"], anchor["top"], anchor["right"], anchor["bottom"])
    ).convert("RGB")
    pixels = list(box.getdata())
    luma = sorted(
        pixels,
        key=lambda pixel: 0.299 * pixel[0] + 0.587 * pixel[1] + 0.114 * pixel[2],
    )
    dark = luma[: max(1, len(luma) // 20)]
    light = luma[-max(1, len(luma) // 20) :]
    strip = image.crop(
        (0, anchor["bottom"], image.width, min(image.height, anchor["bottom"] + 3))
    ).convert("RGB")
    strip_pixels = list(strip.getdata())
    background = max(set(strip_pixels), key=strip_pixels.count)
    background_luma = (
        0.299 * background[0] + 0.587 * background[1] + 0.114 * background[2]
    )
    text = _average(dark) if background_luma > 127 else _average(light)
    return text, background


def _fit_font(text: str, height: int, bold: bool) -> ImageFont.FreeTypeFont:
    path = FONT_BOLD if bold else FONT_REGULAR
    best = ImageFont.truetype(path, 8)
    for size in range(8, max(10, height * 3)):
        font = ImageFont.truetype(path, size)
        box = font.getbbox(text)
        if box[3] - box[1] > height:
            break
        best = font
    return best


def _is_bold(
    image: Image.Image,
    anchor: dict[str, Any],
    text_colour: tuple[int, int, int],
    background: tuple[int, int, int],
) -> bool:
    box = image.crop(
        (anchor["left"], anchor["top"], anchor["right"], anchor["bottom"])
    ).convert("RGB")
    pixels = list(box.getdata())
    if not pixels:
        return False

    def near(pixel: tuple[int, int, int], reference: tuple[int, int, int]) -> bool:
        return sum(abs(pixel[index] - reference[index]) for index in range(3)) < 150

    ink = sum(
        1 for pixel in pixels if near(pixel, text_colour) and not near(pixel, background)
    )
    return ink / len(pixels) > 0.2


def _snap(colour: tuple[int, int, int]) -> tuple[int, int, int]:
    return tuple(255 if channel > 235 else 0 if channel < 20 else channel for channel in colour)


def _row_uniform(
    image: Image.Image,
    y: int,
    background: tuple[int, int, int],
    tolerance: int = 18,
    coverage: float = 0.90,
) -> bool:
    row = list(image.convert("RGB").crop((0, y, image.width, y + 1)).getdata())
    matching = sum(
        1
        for pixel in row
        if all(
            abs(channel - background[index]) <= tolerance
            for index, channel in enumerate(pixel)
        )
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
    end = anchor["bottom"]
    for y in range(anchor["bottom"], image.height):
        row = list(pixels.crop((left, y, right, y + 1)).getdata())
        if all(
            all(
                abs(channel - background[index]) <= tolerance
                for index, channel in enumerate(pixel)
            )
            for pixel in row
        ):
            end = y + 1
            continue
        break
    return end


def compose_extra_lines(
    image: Image.Image, values: Sequence[str]
) -> ExtraLineComposition:
    source = image.convert("RGB")
    lines = [value.strip() for value in values if value.strip()]
    if not lines:
        return ExtraLineComposition(
            source.copy(),
            {"status": "skipped", "reason": "no_lines", "lines": []},
        )
    anchor = _anchor(source)
    if anchor is None:
        return ExtraLineComposition(
            source.copy(),
            {"status": "skipped", "reason": "no_contact_line", "lines": lines},
        )
    text_colour, background = _colours(source, anchor)
    text_colour = _snap(text_colour)
    contact_words = [
        height for word, height in anchor["heights"] if CONTACT_RE.search(word)
    ]
    heights = sorted(
        contact_words or [height for _word, height in anchor["heights"]]
    )
    cap_height = heights[len(heights) // 2]
    bold = _is_bold(source, anchor, text_colour, background)
    font = _fit_font(max(lines, key=len), cap_height, bold)
    line_height = int(round(cap_height * 1.75))
    centred = (
        abs((anchor["left"] + anchor["right"]) / 2 - source.width / 2)
        < source.width * 0.06
    )
    band_end = _band_end(source, anchor, background)
    added = line_height * len(lines) + int(round(line_height * 0.35))
    band_fits = band_end - anchor["bottom"] >= line_height * 0.4 and _row_uniform(
        source, band_end - 1, background
    )
    if not band_fits:
        band_end = source.height
        centred = True
        bottom = source.crop((0, source.height - 3, source.width, source.height)).convert(
            "RGB"
        )
        bottom_pixels = list(bottom.getdata())
        background = max(set(bottom_pixels), key=bottom_pixels.count)
        background_luma = (
            0.299 * background[0] + 0.587 * background[1] + 0.114 * background[2]
        )
        text_colour = (0, 0, 0) if background_luma > 127 else (255, 255, 255)
    grown = Image.new("RGB", (source.width, source.height + added), background)
    grown.paste(source.crop((0, 0, source.width, band_end)), (0, 0))
    if band_fits:
        seam = source.crop((0, band_end - 1, source.width, band_end))
        for offset in range(added):
            grown.paste(seam, (0, band_end + offset))
        grown.paste(
            source.crop((0, band_end, source.width, source.height)),
            (0, band_end + added),
        )
    draw = ImageDraw.Draw(grown)
    y = band_end - int(round(line_height * 0.25)) if band_fits else band_end
    for value in lines:
        width = draw.textlength(value, font=font)
        x = (source.width - width) / 2 if centred else anchor["left"]
        draw.text((x, y), value, font=font, fill=text_colour)
        y += line_height
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
            "font_size": font.size,
            "bold": bold,
            "band_end": band_end,
            "centred": centred,
            "line_height": line_height,
            "lines": lines,
            "output_size": list(grown.size),
        },
    )
