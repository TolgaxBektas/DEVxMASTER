from __future__ import annotations

import re
from difflib import SequenceMatcher
from typing import Any

from PIL import Image, ImageEnhance, ImageFilter, ImageOps


PHONE_RE = re.compile(r"(?:\+49|0049|0)\s*(?:\(?\d{2,5}\)?[\s./-]*)\d[\d\s./-]{4,}")
EMAIL_RE = re.compile(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", re.I)
DOMAIN_RE = re.compile(
    r"(?:https?://)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}", re.I
)


def _normalize(value: str) -> str:
    return " ".join(value.casefold().split())


def _phone(value: str) -> str:
    digits = re.sub(r"\D", "", value)
    if digits.startswith("0049") and len(digits) > 10:
        return "0" + digits[4:]
    if digits.startswith("0043") and len(digits) > 10:
        return "0" + digits[4:]
    if value.lstrip().startswith("+43") and len(digits) > 8:
        return "0" + digits[2:]
    if digits.startswith("49") and len(digits) > 8:
        return "0" + digits[2:]
    return digits


def _phone_equivalent(first: str, second: str) -> bool:
    if first == second:
        return True
    if abs(len(first) - len(second)) > 1:
        return False
    previous = list(range(len(second) + 1))
    for index, left in enumerate(first, 1):
        current = [index]
        for position, right in enumerate(second, 1):
            current.append(min(
                current[-1] + 1,
                previous[position] + 1,
                previous[position - 1] + (left != right),
            ))
        previous = current
    return previous[-1] <= 1


def _words(lines: list[str]) -> list[str]:
    return re.findall(r"[a-z0-9äöüß]+", " ".join(lines).casefold())


def _ocr_text(image: Image.Image) -> tuple[str, float]:
    import pytesseract

    candidates = []
    for angle in (0, 90, 180, 270):
        rotated = image.rotate(angle, expand=True) if angle else image
        text = pytesseract.image_to_string(rotated, lang="deu")
        words = _words(text.splitlines())
        score = sum(len(word) for word in words) + len(words) * 8
        confidence = 0.0
        try:
            from pytesseract import Output

            data = pytesseract.image_to_data(
                rotated,
                lang="deu",
                output_type=Output.DICT,
            )
            confidences = [
                float(value)
                for value, item in zip(data["conf"], data["text"])
                if item.strip() and float(value) >= 0
            ]
            if confidences:
                confidence = sum(confidences) / len(confidences)
                score = confidence * 20 + len(words) * 8
        except (AttributeError, KeyError, TypeError, ValueError):
            pass
        candidates.append((score, text, confidence))
    best = max(candidates, key=lambda item: item[0])
    return best[1], best[2]


def _text_findings(
    original: dict[str, Any],
    restored: dict[str, Any],
) -> list[dict[str, str]]:
    before = _words(original.get("text_lines") or [])
    after = _words(restored.get("text_lines") or [])
    if not before and not after:
        return []
    matcher = SequenceMatcher(None, before, after, autojunk=False)
    ratio = matcher.ratio()
    uncertain = (
        min(len(before), len(after)) < 5
        or ratio < 0.45
        or any(
            confidence is not None and confidence < 85
            for confidence in (
                original.get("ocr_confidence"),
                restored.get("ocr_confidence"),
            )
        )
    )
    if ratio < 0.35:
        return [{
            "type": "uncertain",
            "severity": "unsicher",
            "category": "Text",
            "value": "OCR-Text ist zwischen Original und Restaurat nicht eindeutig vergleichbar.",
        }]
    findings: list[dict[str, str]] = []
    for tag, first, last, second, end in matcher.get_opcodes():
        if tag not in {"delete", "replace", "insert"}:
            continue
        missing = before[first:last]
        added = after[second:end]
        meaningful = {
            "als", "an", "bei", "der", "die", "dich", "ein", "für",
            "im", "ist", "mich", "noch", "und", "von", "wir", "zu",
            "fragen", "interessiert", "melde",
        }
        substantial_missing = (
            len(missing) >= 3
            and len(set(missing) & meaningful) >= 2
        )
        substantial_added = (
            len(added) >= 3
            and len(set(added) & meaningful) >= 2
        )
        if substantial_missing:
            findings.append({
                "type": "missing",
                "severity": "unsicher" if uncertain else "abweichung",
                "category": "Text",
                "value": " ".join(missing),
            })
        if substantial_added:
            findings.append({
                "type": "new",
                "severity": "unsicher" if uncertain else "abweichung",
                "category": "Text",
                "value": " ".join(added),
            })
    return findings


def _ocr_is_uncertain(
    original: dict[str, Any],
    restored: dict[str, Any],
) -> bool:
    before = _words(original.get("text_lines") or [])
    after = _words(restored.get("text_lines") or [])
    return (
        min(len(before), len(after)) < 5
        or SequenceMatcher(None, before, after, autojunk=False).ratio() < 0.35
        or any(
            confidence is not None and confidence < 85
            for confidence in (
                original.get("ocr_confidence"),
                restored.get("ocr_confidence"),
            )
        )
    )


def _decode_qr(image: Image.Image) -> tuple[list[str], str | None]:
    try:
        from pyzbar.pyzbar import decode
    except ImportError:
        return [], "QR-Code-Prüfung nicht verfügbar (Decoder nicht installiert)."
    try:
        pixel_budget = 4_000_000
        scale = max(
            1.0,
            min(4.0, (pixel_budget / max(1, image.width * image.height)) ** 0.5),
        )
        enlarged_size = (
            max(1, round(image.width * scale)),
            max(1, round(image.height * scale)),
        )
        enlarged = image.resize(enlarged_size, Image.Resampling.LANCZOS)
        tile_width = max(128, min(image.width, 1200))
        tile_height = max(128, min(image.height, 1200))
        step_x = max(1, tile_width // 2)
        step_y = max(1, tile_height // 2)
        tiles = [
            (left, top)
            for top in range(0, image.height, step_y)
            for left in range(0, image.width, step_x)
        ]
        if len(tiles) > 16:
            last_index = len(tiles) - 1
            tiles = [
                tiles[round(index * last_index / 15)]
                for index in range(16)
            ]

        def variants():
            yield image
            yield enlarged
            gray = ImageOps.autocontrast(enlarged.convert("L"))
            yield gray
            yield ImageEnhance.Contrast(gray).enhance(2.0)
            yield gray.filter(ImageFilter.SHARPEN)
            for left, top in tiles:
                tile = image.crop((
                    left,
                    top,
                    min(image.width, left + tile_width),
                    min(image.height, top + tile_height),
                ))
                tile_scale = max(
                    1.0,
                    min(
                        4.0,
                        (pixel_budget / max(1, tile.width * tile.height)) ** 0.5,
                    ),
                )
                yield tile.resize(
                    (
                        max(1, round(tile.width * tile_scale)),
                        max(1, round(tile.height * tile_scale)),
                    ),
                    Image.Resampling.LANCZOS,
                )

        values = []
        for variant in variants():
            values.extend(
                item.data.decode("utf-8", errors="replace").strip()
                for item in decode(variant)
                if item.data
            )
    except (OSError, ValueError):
        return [], "QR-Code konnte nicht gelesen werden."
    values = sorted(set(value for value in values if value))
    values = [
        value for value in values
        if len(value) >= 8 and (
            value.casefold().startswith(("http://", "https://", "www."))
            or "@" in value
            or "." in value
        )
    ]
    return values, None


def _qr_presence(image: Image.Image) -> tuple[bool, float]:
    import numpy as np

    gray = np.asarray(
        ImageOps.autocontrast(image.convert("L"))
        .resize(
            (
                min(image.width, 256),
                min(image.height, 256),
            ),
            Image.Resampling.BILINEAR,
        ),
        dtype=np.float32,
    )
    binary = gray < gray.mean()
    horizontal = binary[:, 1:] != binary[:, :-1]
    vertical = binary[1:, :] != binary[:-1, :]

    def integral(values):
        return np.pad(values.astype(np.int32).cumsum(0).cumsum(1), ((1, 0), (1, 0)))

    gray_integral = integral(binary)
    horizontal_integral = integral(horizontal)
    vertical_integral = integral(vertical)

    def windows(values, height, width):
        return (
            values[height:, width:]
            - values[:-height, width:]
            - values[height:, :-width]
            + values[:-height, :-width]
        )

    best = 0.0
    finder_best = 0.0
    gray_image = Image.fromarray(gray.astype(np.uint8), mode="L")
    expected_pattern = np.array([
        [
            row in {0, 6}
            or column in {0, 6}
            or (2 <= row <= 4 and 2 <= column <= 4)
            for column in range(7)
        ]
        for row in range(7)
    ])
    for size in range(21, min(gray.shape) // 2 + 1, 3):
        dark = windows(gray_integral, size, size) / (size * size)
        if not dark.size:
            continue
        horizontal_score = windows(
            horizontal_integral, size, size - 1
        ) / (size * (size - 1))
        vertical_score = windows(
            vertical_integral, size - 1, size
        ) / (size * (size - 1))
        score = np.minimum(horizontal_score, vertical_score) * (1 - np.abs(0.5 - dark))
        best = max(best, float(score.max()))
        output_height = gray.shape[0] - size + 1
        output_width = gray.shape[1] - size + 1

        def region(y, x, height, width):
            return (
                gray_integral[
                    height + y:height + y + output_height,
                    width + x:width + x + output_width,
                ]
                - gray_integral[
                    y:y + output_height,
                    width + x:width + x + output_width,
                ]
                - gray_integral[
                    height + y:height + y + output_height,
                    x:x + output_width,
                ]
                + gray_integral[
                    y:y + output_height,
                    x:x + output_width,
                ]
            ) / (height * width)

        finder_scores = []
        for origin_x, origin_y in (
            (0, 0),
            (size - round(size / 3), 0),
            (0, size - round(size / 3)),
        ):
            matches = np.zeros((output_height, output_width), dtype=np.int16)
            for row in range(7):
                for column in range(7):
                    y0 = origin_y + round(row * size / 21)
                    y1 = origin_y + round((row + 1) * size / 21)
                    x0 = origin_x + round(column * size / 21)
                    x1 = origin_x + round((column + 1) * size / 21)
                    cell = region(y0, x0, y1 - y0, x1 - x0)
                    matches += ((cell >= 0.5) == expected_pattern[row, column])
            finder_scores.append(np.maximum(matches, 49 - matches) / 49)
        candidate_score = np.minimum.reduce(finder_scores)
        for flat_index in np.argpartition(
            candidate_score.ravel(), -16
        )[-16:]:
            top, left = np.unravel_index(flat_index, candidate_score.shape)
            crop = gray_image.crop((left, top, left + size, top + size)).resize(
                (21, 21), Image.Resampling.BILINEAR
            )
            pixels = np.asarray(crop, dtype=np.uint8)
            for inverted in (False, True):
                candidate_binary = ((pixels < 128) != inverted)
                matches = 0
                for origin_x, origin_y in ((0, 0), (14, 0), (0, 14)):
                    matches += int(
                        (
                            candidate_binary[
                                origin_y:origin_y + 7,
                                origin_x:origin_x + 7,
                            ]
                            == expected_pattern
                        ).sum()
                    )
                finder_best = max(finder_best, matches / 147)
    return finder_best >= 0.78, finder_best if finder_best else best


def _edge_grid(image: Image.Image, size: int = 12) -> list[float]:
    gray = ImageOps.autocontrast(image.convert("L")).resize((96, 96))
    values = list(gray.getdata())
    edges = [
        min(
            255,
            (
                abs(values[index] - values[index + 1])
                if column < 95
                else 0
            )
            + (
                abs(values[index] - values[index + 96])
                if row < 95
                else 0
            ),
        )
        for row in range(96)
        for column in range(96)
        for index in [row * 96 + column]
    ]
    return [
        sum(
            edges[(row * 8 + dy) * 96 + column * 8 + dx]
            for dy in range(8)
            for dx in range(8)
        ) / 64 / 255
        for row in range(size)
        for column in range(size)
    ]


def _edge_bitmap(image: Image.Image) -> list[bool]:
    gray = ImageOps.autocontrast(image.convert("L")).resize((96, 96))
    values = list(gray.getdata())
    return [
        (
            abs(values[index] - values[index + 1])
            if column < 95
            else 0
        ) + (
            abs(values[index] - values[index + 96])
            if row < 95
            else 0
        ) >= 35
        for row in range(96)
        for column in range(96)
        for index in [row * 96 + column]
    ]


def _grid_neighbors(index: int, size: int = 12) -> list[int]:
    row, column = divmod(index, size)
    neighbors = []
    if row > 0:
        neighbors.append(index - size)
    if row + 1 < size:
        neighbors.append(index + size)
    if column > 0:
        neighbors.append(index - 1)
    if column + 1 < size:
        neighbors.append(index + 1)
    return neighbors
def _aligned_candidate(
    original: Image.Image,
    restored: Image.Image,
    scale: float,
    offset_x: float,
    offset_y: float,
) -> Image.Image:
    width, height = original.size
    resized = restored.resize(
        (max(1, int(restored.width * scale)), max(1, int(restored.height * scale))),
        Image.Resampling.BILINEAR,
    )
    canvas = Image.new("RGB", (width, height), "white")
    canvas.paste(resized, (int(offset_x), int(offset_y)))
    return canvas


def compare_visual_motifs(
    original: Image.Image,
    restored: Image.Image,
) -> dict[str, Any]:
    original = original.convert("RGB")
    restored = restored.convert("RGB")
    best_score = -1.0
    best_image = restored
    best_parameters = {"scale": 1.0, "offset_x": 0.0, "offset_y": 0.0}
    original_grid = _edge_grid(original)
    original_edges = _edge_bitmap(original)
    width, height = original.size
    base_scale = min(
        original.width / restored.width,
        original.height / restored.height,
    )
    for scale in (0.8, 0.9, 1.0, 1.1, 1.2):
        for x_ratio in (-0.1, -0.05, 0.0, 0.05, 0.1):
            for y_ratio in (-0.1, -0.05, 0.0, 0.05, 0.1):
                candidate = _aligned_candidate(
                    original,
                    restored,
                    base_scale * scale,
                    width * x_ratio,
                    height * y_ratio,
                )
                candidate_grid = _edge_grid(candidate)
                grid_score = 1 - sum(
                    abs(left - right)
                    for left, right in zip(original_grid, candidate_grid)
                ) / len(original_grid)
                candidate_edges = _edge_bitmap(candidate)
                intersection = sum(
                    left and right
                    for left, right in zip(original_edges, candidate_edges)
                )
                union = sum(
                    left or right
                    for left, right in zip(original_edges, candidate_edges)
                )
                pixel_score = intersection / union if union else 1.0
                score = (grid_score + pixel_score) / 2
                if score > best_score:
                    best_score = score
                    best_image = candidate
                    best_parameters = {
                        "scale": scale,
                        "offset_x": width * x_ratio,
                        "offset_y": height * y_ratio,
                    }
    aligned = best_score >= 0.65
    result: dict[str, Any] = {
        "alignment": {
            "class": "aligned" if aligned else "manual_layout_review",
            "score": round(best_score, 4),
            **best_parameters,
        },
        "lost_cells": 0,
        "added_cells": 0,
        "findings": [],
    }
    if not aligned:
        result["findings"].append({
            "type": "uncertain",
            "severity": "unsicher",
            "category": "Bildmotive",
            "value": "Layout neu aufgebaut — Bildmotive sind nur von Hand prüfbar.",
        })
        return result
    restored_grid = _edge_grid(best_image)
    lost = {
        index for index, (before, after) in enumerate(zip(original_grid, restored_grid))
        if before >= 0.18 and after <= before * 0.35
    }
    added = {
        index for index, (before, after) in enumerate(zip(original_grid, restored_grid))
        if after >= 0.18 and before <= after * 0.35
    }

    def components(cells: set[int]) -> list[set[int]]:
        result: list[set[int]] = []
        while cells:
            pending = [cells.pop()]
            component = set(pending)
            while pending:
                index = pending.pop()
                for neighbor in _grid_neighbors(index):
                    if neighbor in cells:
                        cells.remove(neighbor)
                        component.add(neighbor)
                        pending.append(neighbor)
            result.append(component)
        return result

    lost_components = [part for part in components(set(lost)) if len(part) >= 2]
    added_components = [part for part in components(set(added)) if len(part) >= 2]
    result["lost_cells"] = len(lost)
    result["added_cells"] = len(added)
    for category, parts in (("verloren", lost_components), ("ergänzt", added_components)):
        for part in parts:
            result["findings"].append({
                "type": "missing" if category == "verloren" else "new",
                "severity": "abweichung",
                "category": "Bildmotivfläche",
                "value": f"{category}e zusammenhängende Rasterfläche ({len(part)} Zellen)",
            })
    return result


def extract_content_anchors(
    image: Image.Image,
    *,
    text: str | None = None,
    company_name: str | None = None,
    ocr_size: tuple[int, int] | None = None,
) -> dict[str, Any]:
    ocr_text = text
    if ocr_text is None:
        try:
            ocr_image = image
            if ocr_size and ocr_image.size != ocr_size:
                ocr_image = ocr_image.resize(ocr_size, Image.Resampling.LANCZOS)
            ocr_text, ocr_confidence = _ocr_text(ocr_image)
        except (ImportError, OSError, RuntimeError, ValueError):
            ocr_text = ""
            ocr_confidence = 0.0
    else:
        ocr_confidence = None
    lines = [_normalize(line) for line in (ocr_text or "").splitlines() if _normalize(line)]
    phones = sorted({_phone(value) for value in PHONE_RE.findall(ocr_text or "")})
    emails = sorted({_normalize(value) for value in EMAIL_RE.findall(ocr_text or "")})
    domains = sorted({
        _normalize(value).removeprefix("www.")
        for value in DOMAIN_RE.findall(ocr_text or "")
        if not value.replace(".", "").isdigit()
    })
    qr_codes, qr_finding = _decode_qr(image)
    qr_present, qr_score = _qr_presence(image)
    return {
        "text_lines": lines,
        "company_name": _normalize(company_name) if company_name else None,
        "phones": phones,
        "emails": emails,
        "domains": domains,
        "qr_codes": qr_codes,
        "qr_present": qr_present,
        "qr_presence_score": round(qr_score, 4),
        "qr_detection": "available" if qr_finding is None else "unavailable",
        "ocr_token_count": len(_words(lines)),
        "ocr_confidence": ocr_confidence,
    }


def compare_content_anchors(
    original: dict[str, Any],
    restored: dict[str, Any],
) -> dict[str, Any]:
    findings: list[dict[str, str]] = []
    ocr_uncertain = _ocr_is_uncertain(original, restored)

    for category, label in (
        ("phones", "Telefonnummer"),
        ("emails", "E-Mail-Adresse"),
        ("domains", "Web-Adresse"),
        ("qr_codes", "QR-Code-Inhalt"),
    ):
        before = set(original.get(category) or [])
        after = set(restored.get(category) or [])
        if category == "phones":
            exact_before = {_phone(value) for value in before}
            exact_after = {_phone(value) for value in after}
            near_pairs = [
                (left, right)
                for left in exact_before - exact_after
                for right in exact_after - exact_before
                if _phone_equivalent(left, right)
            ]
            for left, right in near_pairs:
                findings.append({
                    "type": "uncertain",
                    "severity": "unsicher",
                    "category": label,
                    "value": f"Nicht eindeutig lesbar: {left} / {right}",
                })
            exact_before -= {left for left, _ in near_pairs}
            exact_after -= {right for _, right in near_pairs}
            before, after = exact_before, exact_after
        for value in sorted(before - after):
            findings.append({
                "type": "missing",
                "severity": (
                    "unsicher"
                    if ocr_uncertain
                    else "abweichung"
                ),
                "category": label,
                "value": value,
            })
        for value in sorted(after - before):
            findings.append({
                "type": "new",
                "severity": (
                    "unsicher"
                    if ocr_uncertain
                    else "abweichung"
                ),
                "category": label,
                "value": value,
            })

    if original.get("qr_present") and not restored.get("qr_present"):
        findings.append({
            "type": "missing",
            "severity": "abweichung",
            "category": "QR-Code-Anwesenheit",
            "value": "Quadratischer QR-Code-Bereich im Original",
        })
    elif restored.get("qr_present") and not original.get("qr_present"):
        findings.append({
            "type": "new",
            "severity": "abweichung",
            "category": "QR-Code-Anwesenheit",
            "value": "Quadratischer QR-Code-Bereich im Restaurat",
        })

    if original.get("company_name") and restored.get("company_name"):
        if original["company_name"] != restored["company_name"]:
            findings.append({
                "type": "missing",
                "severity": "abweichung",
                "category": "Firmenname",
                "value": original["company_name"],
            })
            findings.append({
                "type": "new",
                "severity": "abweichung",
                "category": "Firmenname",
                "value": restored["company_name"],
            })

    if (
        original.get("qr_detection") == "unavailable"
        or restored.get("qr_detection") == "unavailable"
    ):
        findings.append({
            "type": "uncertain",
            "severity": "unsicher",
            "category": "QR-Code",
            "value": "QR-Code-Prüfung nicht verfügbar.",
        })
    findings.extend(_text_findings(original, restored))
    severity = (
        "abweichung"
        if any(item["severity"] == "abweichung" for item in findings)
        else "unsicher"
        if findings
        else "passed"
    )
    return {
        "status": severity,
        "severity": severity,
        "findings": findings,
    }


def finding_messages(comparison: dict[str, Any]) -> list[str]:
    messages = []
    for finding in comparison.get("findings", []):
        severity = finding.get("severity", "unsicher")
        if finding.get("type") == "missing":
            messages.append(
                f"[{severity}] Fehlender Inhaltsanker ({finding['category']}): {finding['value']}"
            )
        elif finding.get("type") == "new":
            messages.append(
                f"[{severity}] Neuer Inhaltsanker ({finding['category']}): {finding['value']}"
            )
        else:
            messages.append(
                f"[{severity}] {finding.get('value', 'Inhaltsabgleich nicht vollständig')}"
            )
    return messages
