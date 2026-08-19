from __future__ import annotations

from dataclasses import dataclass
import re
from pathlib import Path
from typing import Iterable

import numpy as np
import pikepdf
from PIL import Image

from app.services.bbox import Box
from app.services.render import render_page
from app.services.text_layer import page_text_in_box


Matrix = tuple[float, float, float, float, float, float]
IDENTITY: Matrix = (1, 0, 0, 1, 0, 0)


@dataclass(frozen=True)
class QRObject:
    path: str
    operator_index: int
    name: str
    objgen: tuple[int, int]
    payloads: tuple[str, ...]
    placement_matrix: Matrix
    page_coordinates: dict[str, float]
    overlap_area: float

    def as_dict(self) -> dict:
        return {
            "path": self.path,
            "operator_index": self.operator_index,
            "name": self.name,
            "object": list(self.objgen),
            "payloads": list(self.payloads),
            "placement_matrix": list(self.placement_matrix),
            "page_coordinates": self.page_coordinates,
            "overlap_area": self.overlap_area,
        }


@dataclass(frozen=True)
class QRRemovalResult:
    pdf_path: Path
    removed_object: dict


@dataclass(frozen=True)
class QRRemovalVerification:
    decoder_check: dict
    text_check: dict
    pixel_check: dict

    @property
    def passed(self) -> bool:
        return all(
            check["status"] == "passed"
            for check in (self.decoder_check, self.text_check, self.pixel_check)
        )

    def as_dict(self) -> dict:
        return {
            "decoder": self.decoder_check,
            "text": self.text_check,
            "pixels": self.pixel_check,
            "status": "passed" if self.passed else "failed",
        }


def remove_confirmed_qr(
    source_pdf: str | Path,
    output_pdf: str | Path,
    page_number: int,
    payloads: Iterable[str],
    qr_page_box: dict[str, float],
) -> QRRemovalResult | None:
    expected = {payload for payload in payloads if payload}
    output = Path(output_pdf)
    output.parent.mkdir(parents=True, exist_ok=True)
    with pikepdf.Pdf.open(source_pdf) as pdf:
        page = pdf.pages[page_number - 1]
        targets = _find_targets(page, expected, qr_page_box)
        if len(targets) != 1:
            return None
        target = targets[0]
        _remove_target(pdf, page, target)
        pdf.save(output)
    return QRRemovalResult(output, target.as_dict())


def verify_qr_removed_ad(
    original_pdf: str | Path,
    cleaned_pdf: str | Path,
    page_number: int,
    box: Box,
    qr_region: dict[str, float],
    padded_box: Box,
    render_dpi: int,
    artwork_dpi: int,
    pixel_dpi: int = 300,
    margin: int = 5,
) -> QRRemovalVerification:
    original_crop = _render_ad(original_pdf, page_number, box, render_dpi, pixel_dpi)
    cleaned_crop = _render_ad(cleaned_pdf, page_number, box, render_dpi, pixel_dpi)
    original_anchors = _anchors(original_crop)
    cleaned_anchors = _anchors(cleaned_crop)
    decoder_check = {
        "status": (
            "passed"
            if original_anchors["qr_present"] and not cleaned_anchors["qr_present"]
            else "failed"
        ),
        "payloads_before": original_anchors["qr_codes"],
        "payloads_after": cleaned_anchors["qr_codes"],
        "decoder_before": original_anchors["qr_detection"],
        "decoder_after": cleaned_anchors["qr_detection"],
    }

    before_text = page_text_in_box(
        original_pdf, page_number, box, render_dpi
    )
    after_text = page_text_in_box(cleaned_pdf, page_number, box, render_dpi)
    normalized_before = _normalize_text(before_text)
    normalized_after = _normalize_text(after_text)
    text_check = {
        "status": "passed" if normalized_before == normalized_after else "failed",
        "normalized_before": normalized_before,
        "normalized_after": normalized_after,
    }

    changed = np.any(
        np.asarray(original_crop) != np.asarray(cleaned_crop), axis=2
    )
    allowed = np.zeros(changed.shape, dtype=bool)
    qr_left = (
        (padded_box.left + qr_region["x"])
        * pixel_dpi / artwork_dpi
        - box.left * pixel_dpi / render_dpi
    )
    qr_top = (
        (padded_box.top + qr_region["y"])
        * pixel_dpi / artwork_dpi
        - box.top * pixel_dpi / render_dpi
    )
    qr_width = qr_region["width"] * pixel_dpi / artwork_dpi
    qr_height = qr_region["height"] * pixel_dpi / artwork_dpi
    x0 = max(0, round(qr_left) - margin)
    y0 = max(0, round(qr_top) - margin)
    x1 = min(changed.shape[1], round(qr_left + qr_width) + margin)
    y1 = min(changed.shape[0], round(qr_top + qr_height) + margin)
    if x0 < x1 and y0 < y1:
        allowed[y0:y1, x0:x1] = True
    inside = int((changed & allowed).sum())
    outside = int((changed & ~allowed).sum())
    pixel_check = {
        "status": "passed" if outside == 0 else "failed",
        "changed_pixels_inside": inside,
        "changed_pixels_outside": outside,
        "margin_pixels": margin,
        "allowed_region": [x0, y0, x1, y1],
    }
    return QRRemovalVerification(decoder_check, text_check, pixel_check)


def page_box_from_artwork_region(
    qr_region: dict[str, float],
    padded_box: Box,
    page_height_points: float,
    artwork_dpi: int,
) -> dict[str, float]:
    left = (padded_box.left + qr_region["x"]) * 72 / artwork_dpi
    right = (
        padded_box.left + qr_region["x"] + qr_region["width"]
    ) * 72 / artwork_dpi
    top = (padded_box.top + qr_region["y"]) * 72 / artwork_dpi
    bottom = (
        padded_box.top + qr_region["y"] + qr_region["height"]
    ) * 72 / artwork_dpi
    return {
        "left": left,
        "right": right,
        "bottom": page_height_points - bottom,
        "top": page_height_points - top,
    }


def _find_targets(page, expected, qr_box) -> list[QRObject]:
    targets: list[QRObject] = []

    def visit(container, resources, path, parent_matrix=IDENTITY):
        operations = list(pikepdf.parse_content_stream(container))
        matrix = parent_matrix
        stack: list[Matrix] = []
        for index, (operands, operator) in enumerate(operations):
            name = str(operator)
            if name == "q":
                stack.append(matrix)
            elif name == "Q":
                matrix = stack.pop() if stack else parent_matrix
            elif name == "cm":
                matrix = _multiply(matrix, tuple(float(value) for value in operands))
            elif name == "Do":
                xobject = resources.get("/XObject", {}).get(operands[0])
                if xobject is None:
                    continue
                placement = matrix
                subtype = str(xobject.get("/Subtype"))
                if subtype == "/Image":
                    payloads = _image_payloads(xobject)
                    coordinates = _matrix_box(placement)
                    overlap = _overlap(coordinates, qr_box)
                    if (
                        expected.intersection(payloads)
                        and overlap > 0
                        and _contains(coordinates, qr_box)
                    ):
                        targets.append(
                            QRObject(
                                f"{path}",
                                index,
                                str(operands[0]),
                                tuple(xobject.objgen),
                                tuple(sorted(payloads)),
                                tuple(placement),
                                coordinates,
                                overlap,
                            )
                        )
                elif subtype == "/Form":
                    form_matrix = _matrix_from(xobject.get("/Matrix"))
                    visit(
                        xobject,
                        xobject.get("/Resources", resources),
                        f"{path}/{operands[0]}",
                        _multiply(placement, form_matrix),
                    )

    visit(page, page.get("/Resources", {}), "page")
    return targets


def _remove_target(pdf, page, target: QRObject) -> None:
    def clone_form(form):
        clone = pdf.make_stream(form.read_bytes())
        for key, value in form.items():
            if key not in {"/Length", "/Filter", "/DecodeParms"}:
                clone[key] = value
        return clone

    def process(container, resources, path, is_page=False):
        operations = list(pikepdf.parse_content_stream(container))
        kept = []
        for index, (operands, operator) in enumerate(operations):
            name = str(operator)
            if (
                name == "Do"
                and path == target.path
                and index == target.operator_index
                and str(operands[0]) == target.name
            ):
                continue
            if name == "Do":
                form = resources.get("/XObject", {}).get(operands[0])
                child_path = f"{path}/{operands[0]}"
                if (
                    form is not None
                    and form.get("/Subtype") == "/Form"
                    and target.path.startswith(child_path)
                ):
                    clone = clone_form(form)
                    clone_resources = clone.get("/Resources", resources)
                    process(clone, clone_resources, child_path)
                    clone_name = pikepdf.Name(f"/__qr_cleaned_{target.operator_index}")
                    page.Resources["/XObject"][clone_name] = clone
                    operands = list(operands)
                    operands[0] = clone_name
            kept.append((operands, operator))
        stream = pikepdf.unparse_content_stream(kept)
        if is_page:
            page.Contents = pdf.make_stream(stream)
        else:
            container.write(stream)

    process(page, page.get("/Resources", {}), "page", is_page=True)


def _image_payloads(xobject) -> set[str]:
    try:
        from pyzbar.pyzbar import decode
    except ImportError:
        return set()
    try:
        image = pikepdf.PdfImage(xobject).as_pil_image()
    except (AttributeError, OSError, ValueError):
        return set()
    values = set()
    for item in decode(image):
        symbol_type = getattr(item, "type", None)
        if (
            symbol_type != "QRCODE"
            and getattr(symbol_type, "name", None) != "QRCODE"
        ):
            continue
        if item.data:
            values.add(item.data.decode("utf-8", errors="replace").strip())
    return values


def _anchors(image: Image.Image) -> dict:
    from app.services.content_anchors import extract_content_anchors

    return extract_content_anchors(image, text="")


def _render_ad(pdf, page_number, box, render_dpi, pixel_dpi):
    page = render_page(pdf, page_number, pixel_dpi)
    scale = pixel_dpi / render_dpi
    return page.crop(
        (
            round(box.left * scale),
            round(box.top * scale),
            round(box.right * scale),
            round(box.bottom * scale),
        )
    ).convert("RGB")


def _normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _matrix_from(value) -> Matrix:
    if value is None:
        return IDENTITY
    return tuple(float(item) for item in value)


def _multiply(left: Matrix, right: Matrix) -> Matrix:
    a, b, c, d, e, f = left
    g, h, i, j, k, last = right
    return (
        a * g + c * h,
        b * g + d * h,
        a * i + c * j,
        b * i + d * j,
        a * k + c * last + e,
        b * k + d * last + f,
    )


def _matrix_box(matrix: Matrix) -> dict[str, float]:
    points = [
        _point(matrix, 0, 0),
        _point(matrix, 1, 0),
        _point(matrix, 0, 1),
        _point(matrix, 1, 1),
    ]
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return {
        "left": min(xs),
        "bottom": min(ys),
        "right": max(xs),
        "top": max(ys),
    }


def _point(matrix: Matrix, x: float, y: float) -> tuple[float, float]:
    a, b, c, d, e, f = matrix
    return a * x + c * y + e, b * x + d * y + f


def _overlap(left, right) -> float:
    width = max(0.0, min(left["right"], right["right"]) - max(left["left"], right["left"]))
    height = max(0.0, min(left["top"], right["top"]) - max(left["bottom"], right["bottom"]))
    return width * height


def _contains(outer, inner) -> bool:
    return (
        outer["left"] <= inner["left"]
        and outer["right"] >= inner["right"]
        and outer["bottom"] <= inner["bottom"]
        and outer["top"] >= inner["top"]
    )
