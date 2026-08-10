from pathlib import Path
from PIL import Image
from app.services.bbox import Box


def crop_ad(image_path: str | Path, box: Box, output_path: str | Path) -> Path:
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(image_path) as image:
        image.crop((box.left, box.top, box.right, box.bottom)).convert("RGB").save(
            output, format="PNG", optimize=False
        )
    return output
