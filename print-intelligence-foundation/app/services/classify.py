from pathlib import Path
import pypdfium2 as pdfium


def classify_page(pdf_path: str | Path, page_number: int) -> str:
    pdf = pdfium.PdfDocument(str(pdf_path))
    page = pdf[page_number - 1]
    width, height = page.get_size()
    text = page.get_textpage().get_text_range()
    density = len("".join(text.split())) / max(width * height, 1) * 10000
    objects = sum(1 for _ in page.get_objects())
    if not text.strip() and objects == 0:
        return "blank"
    if density < 0.15 and objects >= 2:
        return "ad-page"
    if page_number == 1 or density > 1.2:
        return "cover" if page_number == 1 else "editorial"
    return "mixed"


def classify_pages(pdf_path: str | Path) -> list[str]:
    pdf = pdfium.PdfDocument(str(pdf_path))
    return [classify_page(pdf_path, n + 1) for n in range(len(pdf))]
