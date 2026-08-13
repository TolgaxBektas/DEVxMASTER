from pathlib import Path

from app.services.pdfium import open_document


def render_pdf(
    pdf_path: str | Path, output_dir: str | Path, dpi: int = 120
) -> list[Path]:
    with open_document(pdf_path) as pdf:
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


def render_page(pdf_path: str | Path, page_number: int, dpi: int):
    with open_document(pdf_path) as pdf:
        page = pdf[page_number - 1]
        try:
            bitmap = page.render(scale=dpi / 72)
            try:
                return bitmap.to_pil().convert("RGB")
            finally:
                bitmap.close()
        finally:
            page.close()
