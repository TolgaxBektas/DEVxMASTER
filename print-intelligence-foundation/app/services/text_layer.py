from pathlib import Path
import pypdfium2 as pdfium
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
    pdf = pdfium.PdfDocument(str(pdf_path))
    try:
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
    finally:
        pdf.close()


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
