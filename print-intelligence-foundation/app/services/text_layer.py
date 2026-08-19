from pathlib import Path

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
            text_page = page.get_textpage()
            try:
                _, page_height = page.get_size()
                full_text = text_page.get_text_range()
                characters = []
                for index, char in enumerate(full_text):
                    if index >= text_page.count_chars():
                        break
                    left, bottom, right, top = text_page.get_charbox(index)
                    characters.append(
                        (index, char, (left, bottom, right, top))
                    )
                scale = render_dpi / 72
                for box_index, box in enumerate(boxes):
                    in_box = [
                        item
                        for item in characters
                        if _char_in_box(item[2], box, scale, page_height)
                    ]
                    compact = [
                        item
                        for item in in_box
                        if not item[1].isspace()
                    ]
                    compact_text = "".join(
                        item[1] for item in compact
                    ).casefold()
                    for marker in normalized_markers:
                        _append_marker_matches(
                            evidence[box_index],
                            marker,
                            compact_text,
                            compact,
                            page_height,
                            scale,
                            kind="confirmed",
                        )
                    if not any(
                        item.get("kind") == "confirmed"
                        for item in evidence[box_index]
                    ):
                        for fragment in (
                            "inix",
                            "ixmedia",
                            "inmedia",
                            "india",
                        ):
                            _append_marker_matches(
                                evidence[box_index],
                                fragment,
                                compact_text,
                                compact,
                                page_height,
                                scale,
                                kind="suspected",
                            )
            finally:
                text_page.close()
        finally:
            page.close()
    return evidence


def _char_in_box(charbox, box, scale, page_height):
    left, bottom, right, top = charbox
    return (
        left * scale < box.right
        and right * scale > box.left
        and (page_height - top) * scale < box.bottom
        and (page_height - bottom) * scale > box.top
    )


def _append_marker_matches(
    target,
    marker,
    compact_text,
    compact,
    page_height,
    scale,
    *,
    kind,
):
    start = 0
    while True:
        start = compact_text.find(marker, start)
        if start < 0:
            return
        evidence_start = start
        while (
            evidence_start
            and start - evidence_start < 3
            and not compact[evidence_start - 1][1].isalnum()
        ):
            evidence_start -= 1
        evidence_items = compact[
            evidence_start : start + len(marker)
        ]
        bounds = [item[2] for item in evidence_items]
        left = min(item[0] for item in bounds)
        bottom = min(item[1] for item in bounds)
        right = max(item[2] for item in bounds)
        top = max(item[3] for item in bounds)
        text = "".join(item[1] for item in evidence_items)
        target.append(
            {
                "marker": marker,
                "text": text,
                "object_index": compact[start][0],
                "bounds_pdf": [
                    float(left),
                    float(bottom),
                    float(right),
                    float(top),
                ],
                "bounds": [
                    round(left * scale) - 40,
                    round((page_height - top) * scale) - 40,
                    round(right * scale) + 40,
                    round((page_height - bottom) * scale) + 40,
                ],
                "source": "pdf_text_layer",
                "kind": kind,
            }
        )
        start += len(marker)
