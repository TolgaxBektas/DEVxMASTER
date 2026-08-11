from pathlib import Path
import pypdfium2 as pdfium


def classify_page(pdf_path: str | Path, page_number: int) -> str:
    pdf = pdfium.PdfDocument(str(pdf_path))
    try:
        page = pdf[page_number - 1]
        try:
            width, height = page.get_size()
            text_page = page.get_textpage()
            try:
                text = text_page.get_text_range()
            finally:
                text_page.close()
            objects = list(page.get_objects())
            try:
                object_count = len(objects)
            finally:
                for obj in objects:
                    obj.close()
            density = len("".join(text.split())) / max(width * height, 1) * 10000
            if not text.strip() and object_count == 0:
                return "blank"
            if density < 0.15 and object_count >= 2:
                return "ad-page"
            if page_number == 1 or density > 1.2:
                return "cover" if page_number == 1 else "editorial"
            return "mixed"
        finally:
            page.close()
    finally:
        pdf.close()


def classify_pages(pdf_path: str | Path) -> list[str]:
    pdf = pdfium.PdfDocument(str(pdf_path))
    try:
        page_count = len(pdf)
    finally:
        pdf.close()
    return [classify_page(pdf_path, n + 1) for n in range(page_count)]
