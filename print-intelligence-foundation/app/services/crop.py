from pathlib import Path
from PIL import Image, ImageChops
from app.services.bbox import Box


def crop_ad(image_path: str | Path, box: Box, output_path: str | Path) -> Path:
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(image_path) as image:
        image.crop((box.left, box.top, box.right, box.bottom)).convert("RGB").save(
            output, format="PNG", optimize=False
        )
    return output


def _padded_box(box: Box, size: tuple[int, int], padding: int) -> Box:
    width, height = size
    return Box(
        max(0, box.left - padding),
        max(0, box.top - padding),
        min(width, box.right + padding),
        min(height, box.bottom + padding),
    )


def _trim_white_margin(image: Image.Image, trim_cap: int) -> Image.Image:
    if trim_cap <= 0:
        return image.copy()
    white = Image.new("RGB", image.size, (255, 255, 255))
    bbox = ImageChops.difference(image, white).getbbox()
    if not bbox:
        return image.copy()
    left = max(0, min(bbox[0], trim_cap))
    top = max(0, min(bbox[1], trim_cap))
    right = min(image.width, max(bbox[2], image.width - trim_cap))
    bottom = min(image.height, max(bbox[3], image.height - trim_cap))
    return image.crop((left, top, right, bottom))


def restore_artwork(
    page_image: Image.Image,
    box: Box,
    output_path: str | Path,
    trimmed_output_path: str | Path,
    padding: int = 8,
    trim_cap: int = 4,
) -> tuple[Path, Path, Box]:
    output = Path(output_path)
    trimmed_output = Path(trimmed_output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    trimmed_output.parent.mkdir(parents=True, exist_ok=True)
    crop_box = _padded_box(box, page_image.size, padding)
    artwork = page_image.crop(
        (crop_box.left, crop_box.top, crop_box.right, crop_box.bottom)
    ).convert("RGB")
    artwork.save(output, format="PNG", optimize=False)
    _trim_white_margin(artwork, trim_cap).save(
        trimmed_output, format="PNG", optimize=False
    )
    return output, trimmed_output, crop_box
