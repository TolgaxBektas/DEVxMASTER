from pathlib import Path
import pypdfium2 as pdfium


def render_pdf(
    pdf_path: str | Path, output_dir: str | Path, dpi: int = 120
) -> list[Path]:
    pdf = pdfium.PdfDocument(str(pdf_path))
    try:
        out = Path(output_dir)
        out.mkdir(parents=True, exist_ok=True)
        paths = []
        scale = dpi / 72
        for i in range(len(pdf)):
            page = pdf[i]
            try:
                bitmap = page.render(scale=scale)
                try:
                    path = out / f"page_{i + 1}.png"
                    bitmap.to_pil().convert("RGB").save(
                        path, format="PNG", optimize=False
                    )
                    paths.append(path)
                finally:
                    bitmap.close()
            finally:
                page.close()
        return paths
    finally:
        pdf.close()


def render_page(pdf_path: str | Path, page_number: int, dpi: int):
    pdf = pdfium.PdfDocument(str(pdf_path))
    try:
        page = pdf[page_number - 1]
        try:
            bitmap = page.render(scale=dpi / 72)
            try:
                return bitmap.to_pil().convert("RGB")
            finally:
                bitmap.close()
        finally:
            page.close()
    finally:
        pdf.close()
