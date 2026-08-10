from pathlib import Path
import pypdfium2 as pdfium


def render_pdf(
    pdf_path: str | Path, output_dir: str | Path, dpi: int = 120
) -> list[Path]:
    pdf = pdfium.PdfDocument(str(pdf_path))
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    paths = []
    scale = dpi / 72
    for i in range(len(pdf)):
        bitmap = pdf[i].render(scale=scale)
        path = out / f"page_{i + 1}.png"
        bitmap.to_pil().convert("RGB").save(path, format="PNG", optimize=False)
        paths.append(path)
    return paths
