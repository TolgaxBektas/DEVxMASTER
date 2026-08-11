from dataclasses import dataclass
import logging
from pathlib import Path
import re
import shutil
from typing import Protocol

from app.services.extraction import extract_contact_fields

logger = logging.getLogger(__name__)


def _match_value(field: str, value: str) -> str:
    if field in {"phone", "raw_phone"}:
        return re.sub(r"\D", "", value)
    if field in {"email", "domain"}:
        return re.sub(r"[^a-z0-9@._+-]", "", value.casefold())
    return re.sub(r"\s+", " ", value.casefold()).strip()


def _field_confidence(
    field: str, value: str, words: list[tuple[str, float]]
) -> float:
    target = _match_value(field, value)
    if not target:
        return 0.0
    for start in range(len(words)):
        for end in range(start + 1, len(words) + 1):
            candidate = _match_value(
                field, " ".join(word for word, _ in words[start:end])
            )
            if candidate == target:
                return sum(confidence for _, confidence in words[start:end]) / (
                    len(words[start:end]) * 100
                )
    return 0.0


@dataclass(frozen=True)
class OCRResult:
    fields: dict[str, str]
    confidence: dict[str, float]
    text: str = ""


class OCRProvider(Protocol):
    def extract_fields(self, crop_path: str) -> OCRResult: ...


class TesseractOCRProvider:
    def __init__(
        self,
        languages: str = "deu+eng",
        minimum_confidence: float = 0.7,
    ):
        self.languages = languages
        self.minimum_confidence = minimum_confidence
        self._checked = False
        self._available = False

    def _ensure_available(self) -> bool:
        if self._checked:
            return self._available
        self._checked = True
        if shutil.which("tesseract") is None:
            logger.warning("OCR fallback disabled: tesseract binary is unavailable")
            return False
        try:
            import pytesseract

            languages = set(pytesseract.get_languages(config=""))
            required = set(self.languages.split("+"))
            missing = required - languages
            if missing:
                logger.warning(
                    "OCR fallback disabled: missing Tesseract languages=%s",
                    ",".join(sorted(missing)),
                )
                return False
        except (OSError, RuntimeError, ImportError) as exc:
            logger.warning("OCR fallback disabled: Tesseract setup failed: %s", exc)
            return False
        self._available = True
        return True

    def extract_fields(self, crop_path: str) -> OCRResult:
        if not self._ensure_available():
            return OCRResult({}, {})
        try:
            import pytesseract
            from PIL import Image

            with Image.open(crop_path) as image:
                data = pytesseract.image_to_data(
                    image,
                    lang=self.languages,
                    output_type=pytesseract.Output.DICT,
                )
            line_words: dict[tuple[int, int, int], list[str]] = {}
            words = []
            for index, (raw_text, raw_conf) in enumerate(
                zip(data["text"], data["conf"])
            ):
                text = raw_text.strip()
                confidence = float(raw_conf)
                if not text or confidence < 0:
                    continue
                words.append((text, confidence))
                line_key = (
                    int(data.get("block_num", [0] * len(data["text"]))[index]),
                    int(data.get("par_num", [0] * len(data["text"]))[index]),
                    int(data.get("line_num", [index] * len(data["text"]))[index]),
                )
                line_words.setdefault(line_key, []).append(text)
            text = "\n".join(" ".join(words) for words in line_words.values())
            fields = extract_contact_fields(text).model_dump(exclude_none=True)
            confidence = {
                key: _field_confidence(key, value, words)
                for key, value in fields.items()
            }
            return OCRResult(fields, confidence, text)
        except (OSError, RuntimeError, ValueError) as exc:
            logger.warning("OCR fallback skipped for %s: %s", crop_path, exc)
            return OCRResult({}, {})


class RecordedOCRProvider:
    def __init__(self, results: dict[str, OCRResult]):
        self.results = results

    def extract_fields(self, crop_path: str) -> OCRResult:
        return self.results.get(Path(crop_path).name, OCRResult({}, {}))
