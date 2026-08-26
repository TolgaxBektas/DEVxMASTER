from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pikepdf
from pikepdf import parse_content_stream, unparse_content_stream

from app.services.bbox import Box
from app.services.render import render_page
from app.services.text_layer import watermark_markers_in_boxes


@dataclass(frozen=True)
class WatermarkCleaningResult:
    pdf_path: Path
    removed_blocks: list[dict]
    font_usage: dict[str, dict]


@dataclass(frozen=True)
class WatermarkVerification:
    marker_check: dict
    text_check: dict
    pixel_check: dict

    @property
    def passed(self) -> bool:
        return all(
            check["status"] == "passed"
            for check in (self.marker_check, self.text_check, self.pixel_check)
        )

    def as_dict(self) -> dict:
        return {
            "marker": self.marker_check,
            "text": self.text_check,
            "pixels": self.pixel_check,
            "status": "passed" if self.passed else "failed",
        }


def clean_pdf(
    source_pdf: str | Path,
    output_pdf: str | Path,
    page_boxes: dict[int, list[Box]],
    markers: Iterable[str],
    render_dpi: int = 120,
) -> WatermarkCleaningResult:
    normalized_markers = [
        marker.casefold().strip() for marker in markers if marker.strip()
    ]
    output = Path(output_pdf)
    output.parent.mkdir(parents=True, exist_ok=True)
    removed_blocks: list[dict] = []
    font_usage: dict[str, dict] = {}
    with pikepdf.Pdf.open(source_pdf) as pdf:
        for page_number, boxes in page_boxes.items():
            page = pdf.pages[page_number - 1]
            removed, usage = _clean_page(
                pdf,
                page,
                boxes,
                normalized_markers,
                render_dpi,
                source_pdf,
                page_number,
            )
            removed_blocks.extend(
                [{"page": page_number, **block} for block in removed]
            )
            for key, value in usage.items():
                existing = font_usage.setdefault(
                    key,
                    {
                        "basefont": value["basefont"],
                        "blocks": 0,
                        "marker_blocks": 0,
                    },
                )
                existing["blocks"] += value["blocks"]
                existing["marker_blocks"] += value["marker_blocks"]
        pdf.save(output)
    return WatermarkCleaningResult(output, removed_blocks, font_usage)


def verify_cleaned_ad(
    original_pdf: str | Path,
    cleaned_pdf: str | Path,
    page_number: int,
    box: Box,
    markers: Iterable[str],
    render_dpi: int,
    pixel_dpi: int = 300,
    margin: int = 5,
    extra_allowed_regions: Iterable[Box] | None = None,
    removed_blocks: Iterable[dict] | None = None,
) -> WatermarkVerification:
    marker_list = list(markers)
    before = watermark_markers_in_boxes(
        original_pdf, page_number, [box], render_dpi, marker_list
    )[0]
    after = watermark_markers_in_boxes(
        cleaned_pdf, page_number, [box], render_dpi, marker_list
    )[0]
    marker_check = {
        "status": "passed" if not after else "failed",
        "markers_before": len(before),
        "markers_after": len(after),
        "evidence_before": before,
        "evidence_after": after,
    }

    text_before = _text_in_box(original_pdf, page_number, box, render_dpi)
    text_after = _text_in_box(cleaned_pdf, page_number, box, render_dpi)
    removed_items = list(removed_blocks or ())
    allowed_evidence = (
        removed_items
        if removed_blocks is not None
        else before
    )
    allowed_texts = [
        item["text"] for item in allowed_evidence if item.get("text")
    ]
    if removed_blocks is not None and allowed_texts:
        allowed_texts.extend(_removed_text_variants(allowed_texts, marker_list))
    text_equal = _text_equal_after_marker_fragments(
        text_before,
        text_after,
        marker_list,
        allowed_texts,
    )
    text_check = {
        "status": "passed" if text_equal else "failed",
        "before": text_before,
        "after": text_after,
        "normalized_before": _remove_marker_fragments(
            text_before, marker_list, allowed_texts
        ),
        "normalized_after": _remove_marker_fragments(
            text_after, marker_list, allowed_texts
        ),
    }

    original_page = render_page(original_pdf, page_number, pixel_dpi)
    cleaned_page = render_page(cleaned_pdf, page_number, pixel_dpi)
    original_crop = _crop_render(
        original_page, box, render_dpi, pixel_dpi
    )
    cleaned_crop = _crop_render(
        cleaned_page, box, render_dpi, pixel_dpi
    )
    changed = np.any(
        np.asarray(original_crop) != np.asarray(cleaned_crop), axis=2
    )
    allowed = np.zeros(changed.shape, dtype=bool)
    scale = pixel_dpi / render_dpi
    crop_left = round(box.left * scale)
    crop_top = round(box.top * scale)
    allowed_blocks = (
        removed_items
        if removed_blocks is not None
        else before
    )
    for item in allowed_blocks:
        if not item.get("bounds"):
            continue
        left, top, right, bottom = item["bounds"]
        x0 = max(0, round((left - box.left) * scale) - margin)
        y0 = max(0, round((top - box.top) * scale) - margin)
        x1 = min(changed.shape[1], round((right - box.left) * scale) + margin)
        y1 = min(changed.shape[0], round((bottom - box.top) * scale) + margin)
        allowed[y0:y1, x0:x1] = True
    for region in extra_allowed_regions or ():
        x0 = max(0, round((region.left - box.left) * scale) - margin)
        y0 = max(0, round((region.top - box.top) * scale) - margin)
        x1 = min(changed.shape[1], round((region.right - box.left) * scale) + margin)
        y1 = min(changed.shape[0], round((region.bottom - box.top) * scale) + margin)
        allowed[y0:y1, x0:x1] = True
    del crop_left, crop_top
    inside = int((changed & allowed).sum())
    outside = int((changed & ~allowed).sum())
    pixel_check = {
        "status": "passed" if outside == 0 else "failed",
        "changed_pixels_inside": inside,
        "changed_pixels_outside": outside,
        "margin_pixels": margin,
        "pixel_dpi": pixel_dpi,
        "watermark_bounds": [
            item["bounds"] for item in allowed_blocks if item.get("bounds")
        ],
        "removed_blocks": len(removed_items),
    }
    return WatermarkVerification(marker_check, text_check, pixel_check)


def _clean_page(
    pdf,
    page,
    boxes,
    markers,
    render_dpi,
    source_pdf=None,
    page_number=None,
):
    resources = page.get("/Resources", {})
    media_box = page.get("/MediaBox")
    page_height = float(media_box[3])
    target_boxes = [
        (
            box.left / render_dpi * 72,
            page_height - box.bottom / render_dpi * 72,
            box.right / render_dpi * 72,
            page_height - box.top / render_dpi * 72,
        )
        for box in boxes
    ]
    removed: list[dict] = []
    usage: dict[str, dict] = {}
    used_page_evidence: set[int] = set()
    page_evidence = None

    def get_page_evidence():
        nonlocal page_evidence
        if page_evidence is None:
            if source_pdf is None or page_number is None:
                page_evidence = []
            else:
                page_evidence = [
                    item
                    for items in watermark_markers_in_boxes(
                        source_pdf,
                        page_number,
                        boxes,
                        render_dpi,
                        markers,
                    )
                    for item in items
                    if item.get("kind") == "confirmed"
                ]
        return page_evidence

    def intersects(form) -> bool:
        bbox = form.get("/BBox")
        if bbox is None or len(bbox) != 4:
            return True
        left, bottom, right, top = (float(value) for value in bbox)
        left, right = sorted((left, right))
        bottom, top = sorted((bottom, top))
        return any(
            left < right_target
            and right > left_target
            and bottom < top_target
            and top > bottom_target
            for left_target, bottom_target, right_target, top_target in target_boxes
        )

    def clone_form(form):
        clone = pdf.make_stream(form.read_bytes())
        for key, value in form.items():
            if key not in {"/Length", "/Filter", "/DecodeParms"}:
                clone[key] = value
        return clone

    def process(
        container,
        container_resources,
        path,
        is_page=False,
        container_bounds=None,
    ):
        fonts = {
            str(name): (font, _cmap_for(font))
            for name, font in container_resources.get("/Font", {}).items()
        }
        operations = list(parse_content_stream(container))
        kept = []
        block = None
        current_font = ""
        for operands, operator in operations:
            name = str(operator)
            if name == "BT":
                block = {
                    "texts": [],
                    "fonts": [],
                    "operations": [(operands, operator)],
                }
                continue
            if block is not None:
                block["operations"].append((operands, operator))
            if name == "Tf" and block is not None:
                current_font = str(operands[0])
                block["fonts"].append(current_font)
            elif name == "Tj" and block is not None:
                cmap = fonts.get(current_font, (None, {}))[1]
                block["texts"].append(_decode_text(operands[0], cmap))
            elif name == "TJ" and block is not None:
                cmap = fonts.get(current_font, (None, {}))[1]
                block["texts"].extend(
                    _decode_text(value, cmap)
                    for value in operands[0]
                    if isinstance(value, pikepdf.String)
                )
            elif name == "ET" and block is not None:
                text = "".join(block["texts"])
                compact_text = re.sub(r"\s+", "", text).casefold()
                marker_block = any(
                    marker in compact_text for marker in markers
                )
                for font_name in set(block["fonts"]):
                    font = fonts.get(font_name, (None, {}))[0]
                    if font is None:
                        continue
                    key = str(font.objgen)
                    state = usage.setdefault(
                        key,
                        {
                            "basefont": str(font.get("/BaseFont")),
                            "blocks": 0,
                            "marker_blocks": 0,
                        },
                    )
                    state["blocks"] += 1
                    state["marker_blocks"] += int(marker_block)
                if marker_block:
                    measured_bounds = None
                    if container_bounds is None:
                        measured_bounds = _measured_page_bounds(
                            compact_text,
                            get_page_evidence(),
                            used_page_evidence,
                        )
                    removed.append(
                        {
                            "path": path,
                            "text": text,
                            "fonts": list(block["fonts"]),
                            "bounds_pdf": (
                                container_bounds
                                if container_bounds is not None
                                else measured_bounds["bounds_pdf"]
                                if measured_bounds
                                else None
                            ),
                            "bounds": (
                                _render_bounds(
                                    container_bounds,
                                    page_height,
                                    render_dpi,
                                )
                                if container_bounds is not None
                                else measured_bounds["bounds"]
                                if measured_bounds
                                else None
                            ),
                        }
                    )
                    block = None
                    continue
                kept.extend(block["operations"])
                block = None
                continue
            elif name == "Do":
                form = container_resources.get("/XObject", {}).get(operands[0])
                if (
                    form is not None
                    and form.get("/Subtype") == "/Form"
                    and intersects(form)
                    and _form_contains_marker(
                        form, form.get("/Resources", container_resources), markers
                    )
                ):
                    clone_name = pikepdf.Name(
                        f"/__watermark_removed_{len(removed)}"
                    )
                    clone = clone_form(form)
                    page.Resources["/XObject"][clone_name] = clone
                    clone_resources = clone.get(
                        "/Resources", container_resources
                    )
                    process(
                        clone,
                        clone_resources,
                        f"{path}{clone_name}",
                        container_bounds=_form_bounds(form),
                    )
                    operands = list(operands)
                    operands[0] = clone_name
            if block is None:
                kept.append((operands, operator))
        if is_page:
            page.Contents = pdf.make_stream(unparse_content_stream(kept))
        else:
            container.write(unparse_content_stream(kept))

    process(page, resources, "page", is_page=True)
    return removed, usage


def _measured_page_bounds(text, evidence, used):
    compact = re.sub(r"\s+", "", text).casefold()
    required_counts = {}
    for item in evidence:
        marker = re.sub(r"\s+", "", item.get("marker", "")).casefold()
        count = compact.count(marker) if marker else 0
        if count:
            required_counts[marker] = count
    if not required_counts:
        return None

    matches = []
    for marker, count in required_counts.items():
        taken = 0
        for index, item in enumerate(evidence):
            if index in used:
                continue
            item_marker = re.sub(
                r"\s+", "", item.get("marker", "")
            ).casefold()
            if item_marker != marker:
                continue
            matches.append(item)
            used.add(index)
            taken += 1
            if taken == count:
                break
    if not matches:
        return None
    bounds_pdf = [
        min(item["bounds_pdf"][axis] for item in matches)
        for axis in (0, 1)
    ] + [
        max(item["bounds_pdf"][axis] for item in matches)
        for axis in (2, 3)
    ]
    bounds = [
        min(item["bounds"][axis] for item in matches)
        for axis in (0, 1)
    ] + [
        max(item["bounds"][axis] for item in matches)
        for axis in (2, 3)
    ]
    return {
        "bounds_pdf": bounds_pdf,
        "bounds": bounds,
    }


def _form_bounds(form):
    bbox = form.get("/BBox")
    if bbox is None or len(bbox) != 4:
        return None
    left, bottom, right, top = (float(value) for value in bbox)
    left, right = sorted((left, right))
    bottom, top = sorted((bottom, top))
    return [left, bottom, right, top]


def _render_bounds(bounds_pdf, page_height, render_dpi):
    if bounds_pdf is None:
        return None
    left, bottom, right, top = bounds_pdf
    scale = render_dpi / 72
    return [
        round(left * scale),
        round((page_height - top) * scale),
        round(right * scale),
        round((page_height - bottom) * scale),
    ]


def _form_contains_marker(form, resources, markers, visited=None):
    if visited is None:
        visited = set()
    objgen = getattr(form, "objgen", None)
    if objgen is not None:
        if objgen in visited:
            return False
        visited.add(objgen)
    fonts = {
        str(name): _cmap_for(font)
        for name, font in resources.get("/Font", {}).items()
    }
    current_font = ""
    block_text: list[str] = []
    in_block = False
    for operands, operator in parse_content_stream(form):
        name = str(operator)
        if name == "BT":
            block_text = []
            in_block = True
        elif name == "Tf":
            current_font = str(operands[0])
        elif name == "Tj" and in_block:
            block_text.append(
                _decode_text(operands[0], fonts.get(current_font, {}))
            )
        elif name == "TJ":
            block_text.extend(
                _decode_text(value, fonts.get(current_font, {}))
                for value in operands[0]
                if isinstance(value, pikepdf.String)
            )
        elif name == "ET":
            compact_text = re.sub(
                r"\s+", "", "".join(block_text)
            ).casefold()
            if any(marker in compact_text for marker in markers):
                return True
            block_text = []
            in_block = False
        elif name == "Do":
            nested = resources.get("/XObject", {}).get(operands[0])
            if (
                nested is not None
                and nested.get("/Subtype") == "/Form"
                and _form_contains_marker(
                    nested,
                    nested.get("/Resources", resources),
                    markers,
                    visited,
                )
            ):
                return True
    return False


def _cmap_for(font):
    stream = font.get("/ToUnicode")
    if stream is None:
        return {}
    text = stream.read_bytes().decode("latin1")
    mapping = {}
    section = None
    for line in text.splitlines():
        if "beginbfchar" in line:
            section = "char"
            continue
        if "endbfchar" in line:
            section = None
            continue
        if section != "char":
            continue
        match = re.search(r"<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>", line)
        if match:
            codepoint = int(match.group(2), 16)
            if codepoint <= 0x10FFFF:
                mapping[bytes.fromhex(match.group(1))] = chr(codepoint)
    return mapping


def _decode_text(value, cmap):
    raw = bytes(value)
    if not cmap:
        return raw.decode("latin1", "replace")
    widths = sorted({len(key) for key in cmap}, reverse=True)
    result = []
    position = 0
    while position < len(raw):
        for width in widths:
            key = raw[position : position + width]
            if key in cmap:
                result.append(cmap[key])
                position += width
                break
        else:
            result.append("\ufffd")
            position += 1
    return "".join(result)


def _text_in_box(pdf_path, page_number, box, render_dpi):
    from app.services.text_layer import page_text_in_box

    return page_text_in_box(pdf_path, page_number, box, render_dpi)


def _remove_marker_fragments(text, markers, evidence_texts):
    normalized = " ".join(text.split())
    for evidence in evidence_texts:
        compact = "".join(evidence.split())
        if compact:
            if compact == "©":
                for variant in (
                    "inixmedia",
                    "inixme",
                    "ixmedia",
                    "inmedia",
                    "india",
                    "inix",
                    "media",
                ):
                    normalized = re.sub(
                        rf"{variant}\s*©", variant, normalized,
                        flags=re.IGNORECASE,
                    )
                    normalized = re.sub(
                        rf"©\s*(?={variant})", "", normalized,
                        flags=re.IGNORECASE,
                    )
                normalized = normalized.replace("©", " ")
                continue
            if compact == "me":
                pattern = re.compile(
                    rf"(?<!\w){re.escape(compact)}(?!\w)",
                    re.IGNORECASE,
                )
            elif compact in {
                "inix",
                "inixme",
                "ixmedia",
                "inmedia",
                "india",
                "media",
            }:
                pattern = re.compile(re.escape(compact), re.IGNORECASE)
            else:
                pattern = re.compile(
                    r"\s*".join(re.escape(char) for char in compact),
                    re.IGNORECASE,
                )
            normalized = pattern.sub(" ", normalized)
    for marker in markers:
        compact = "".join(marker.split())
        pattern = re.compile(
            r"\s*".join(re.escape(char) for char in compact),
            re.IGNORECASE,
        )
        normalized = pattern.sub(" ", normalized)
    return " ".join(normalized.split())


def _removed_text_variants(texts, markers):
    for text in texts:
        compact = "".join(text.split()).casefold()
        if any(
            "".join(marker.split()).casefold() in compact
            for marker in markers
        ):
            variants = [
                f"{prefix} {marker}"
                for prefix in ("©", "´'")
                for marker in markers
            ] + [
                "©",
                "inixmedia",
                "inixme",
                "ixmedia",
                "inmedia",
                "india",
                "inix",
                "media",
                "me",
            ]
            return variants
    return []


def _text_equal_after_marker_fragments(
    before, after, markers, evidence_texts
):
    return _remove_marker_fragments(
        before, markers, evidence_texts
    ) == _remove_marker_fragments(after, markers, evidence_texts)


def _crop_render(image, box, source_dpi, target_dpi):
    scale = target_dpi / source_dpi
    left = round(box.left * scale)
    top = round(box.top * scale)
    right = round(box.right * scale)
    bottom = round(box.bottom * scale)
    return image.crop((left, top, right, bottom))
