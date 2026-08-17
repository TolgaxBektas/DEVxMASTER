import json
from pathlib import Path
import sys

from PIL import Image

from app.services.content_anchors import (
    compare_content_anchors,
    compare_visual_motifs,
    extract_content_anchors,
)


def main() -> int:
    root = Path(sys.argv[1])
    results = []
    for directory in sorted(path for path in root.iterdir() if path.is_dir()):
        original = next(directory.glob("01_original.*"))
        restored = next(directory.glob("02_restauriert_*"))
        with Image.open(original) as image:
            original_size = image.size
        with Image.open(restored) as image:
            restored_size = image.size
        ocr_size = (
            max(original_size[0], restored_size[0]),
            max(original_size[1], restored_size[1]),
        )
        with Image.open(original) as image:
            original_anchors = extract_content_anchors(
                image.convert("RGB"), ocr_size=ocr_size
            )
        with Image.open(restored) as image:
            restored_anchors = extract_content_anchors(
                image.convert("RGB"), ocr_size=ocr_size
            )
        visual_comparison = compare_visual_motifs(
            Image.open(original).convert("RGB"),
            Image.open(restored).convert("RGB"),
        )
        comparison = compare_content_anchors(
            original_anchors, restored_anchors
        )
        comparison["findings"].extend(visual_comparison["findings"])
        comparison["status"] = comparison["severity"] = (
            "abweichung"
            if any(
                finding.get("severity") == "abweichung"
                for finding in comparison["findings"]
            )
            else "unsicher"
            if comparison["findings"]
            else "passed"
        )
        results.append({
            "pair": directory.name,
            "original": original_anchors,
            "restored": restored_anchors,
            "comparison": comparison,
            "visual_comparison": visual_comparison,
        })
    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
