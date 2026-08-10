from dataclasses import dataclass


@dataclass(frozen=True)
class Box:
    left: int
    top: int
    right: int
    bottom: int

    @property
    def area(self):
        return max(0, self.right - self.left) * max(0, self.bottom - self.top)


def normalize_bbox(
    values: list[float],
    image_size: tuple[int, int],
    fixture_size: tuple[int, int] | None = None,
    min_pixels: int = 8,
) -> Box | None:
    width, height = image_size
    scale_w, scale_h = fixture_size or (1000, 1000)
    x1, y1, x2, y2 = values[:4]
    left, top = (
        int(max(0, min(width, x1 / scale_w * width))),
        int(max(0, min(height, y1 / scale_h * height))),
    )
    right, bottom = (
        int(max(0, min(width, x2 / scale_w * width))),
        int(max(0, min(height, y2 / scale_h * height))),
    )
    box = Box(left, top, right, bottom)
    return (
        box
        if box.right - box.left >= min_pixels and box.bottom - box.top >= min_pixels
        else None
    )


def iou(a: Box, b: Box) -> float:
    inter = Box(
        max(a.left, b.left),
        max(a.top, b.top),
        min(a.right, b.right),
        min(a.bottom, b.bottom),
    ).area
    union = a.area + b.area - inter
    return inter / union if union else 0.0


def deduplicate_boxes(boxes: list[Box], threshold: float = 0.85) -> list[Box]:
    result = []
    for box in boxes:
        if not any(iou(box, kept) >= threshold for kept in result):
            result.append(box)
    return result
