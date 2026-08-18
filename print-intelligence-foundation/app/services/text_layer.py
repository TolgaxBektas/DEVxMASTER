import ctypes
from pathlib import Path

from pypdfium2 import raw

from app.services.pdfium import open_document
from app.services.bbox import Box


def _pdf_box(page, box: Box, render_dpi: int):
    width, height = page.get_size()
    scale = render_dpi / 72
    left = box.left / scale
    right = box.right / scale
    top = box.top / scale
    bottom = box.bottom / scale
    return left, height - bottom, right, height - top


def page_texts_in_boxes(
    pdf_path: str | Path,
    page_number: int,
    boxes: list[Box],
    render_dpi: int,
) -> list[str]:
    with open_document(pdf_path) as pdf:
        page = pdf[page_number - 1]
        try:
            bounds = [_pdf_box(page, box, render_dpi) for box in boxes]
            text_page = page.get_textpage()
            try:
                full_text = text_page.get_text_range()
                characters = [[] for _ in boxes]
                areas = [box.area for box in boxes]
                for index in range(text_page.count_chars()):
                    char_left, char_bottom, char_right, char_top = (
                        text_page.get_charbox(index)
                    )
                    if index >= len(full_text):
                        continue
                    center_x = (char_left + char_right) / 2
                    center_y = (char_bottom + char_top) / 2
                    matches = [
                        i
                        for i, (left, bottom, right, top) in enumerate(bounds)
                        if left <= center_x <= right
                        and bottom <= center_y <= top
                    ]
                    if matches:
                        owner = min(matches, key=lambda i: areas[i])
                        characters[owner].append((index, full_text[index]))
                return [
                    "".join(char for _, char in sorted(chars)).strip()
                    for chars in characters
                ]
            finally:
                text_page.close()
        finally:
            page.close()


def remove_substring_bleed(texts: list[str], page_text: str | None = None) -> list[str]:
    normalized = [" ".join(text.casefold().split()) for text in texts]
    page_normalized = " ".join(page_text.casefold().split()) if page_text else ""
    return [
        ""
        if normalized[index]
        and any(
            index != other
            and len(normalized[index]) < len(normalized[other])
            and normalized[index] in normalized[other]
            and not any(char.isdigit() for char in normalized[index])
            for other in range(len(texts))
        )
        or (
            normalized[index]
            and page_normalized.count(normalized[index]) > 1
            and len(normalized[index]) < 80
            and not any(char.isdigit() for char in normalized[index])
        )
        else text
        for index, text in enumerate(texts)
    ]


def page_text_in_box(
    pdf_path: str | Path, page_number: int, box: Box, render_dpi: int
) -> str:
    return page_texts_in_boxes(pdf_path, page_number, [box], render_dpi)[0]


def page_text(
    pdf_path: str | Path, page_number: int
) -> str:
    with open_document(pdf_path) as pdf:
        page = pdf[page_number - 1]
        try:
            text_page = page.get_textpage()
            try:
                return text_page.get_text_range()
            finally:
                text_page.close()
        finally:
            page.close()


def watermark_markers_in_boxes(
    pdf_path: str | Path,
    page_number: int,
    boxes: list[Box],
    render_dpi: int,
    markers: list[str],
) -> list[list[dict]]:
    """Return PDF text-layer watermark marker evidence for each artwork box."""
    normalized_markers = [
        marker.casefold().strip() for marker in markers if marker.strip()
    ]
    evidence = [[] for _ in boxes]
    if not normalized_markers:
        return evidence
    with open_document(pdf_path) as pdf:
        page = pdf[page_number - 1]
        try:
            _, page_height = page.get_size()
            scale = render_dpi / 72
            text_page = page.get_textpage()
            try:
                for object_index, obj in enumerate(page.get_objects()):
                    if obj.type != 1:
                        continue
                    try:
                        bounds = list(obj.get_pos())
                    except Exception:
                        continue
                    if len(bounds) != 4:
                        continue
                    buffer = (ctypes.c_ushort * 4096)()
                    try:
                        raw.FPDFTextObj_GetText(
                            obj.raw, text_page.raw, buffer, len(buffer)
                        )
                    except Exception:
                        continue
                    text = "".join(chr(value) for value in buffer if value)
                    lowered = text.casefold()
                    matched = [
                        marker for marker in normalized_markers if marker in lowered
                    ]
                    if not matched:
                        continue
                    left, bottom, right, top = bounds
                    pixel_box = Box(
                        round(left * scale),
                        round((page_height - top) * scale),
                        round(right * scale),
                        round((page_height - bottom) * scale),
                    )
                    for box_index, box in enumerate(boxes):
                        if (
                            pixel_box.left < box.right
                            and pixel_box.right > box.left
                            and pixel_box.top < box.bottom
                            and pixel_box.bottom > box.top
                        ):
                            evidence[box_index].append(
                                {
                                    "marker": matched[0],
                                    "text": text,
                                    "object_index": object_index,
                                    "bounds_pdf": [
                                        float(value) for value in bounds
                                    ],
                                    "bounds": [
                                        pixel_box.left,
                                        pixel_box.top,
                                        pixel_box.right,
                                        pixel_box.bottom,
                                    ],
                                    "source": "pdf_text_layer",
                                }
                            )
            finally:
                text_page.close()
        finally:
            page.close()
    return evidence
