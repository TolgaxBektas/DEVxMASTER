from dataclasses import dataclass
import logging
from pathlib import Path
import shutil
from typing import Protocol

from app.services.extraction import extract_contact_fields

logger = logging.getLogger(__name__)


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
            words = [
                (text.strip(), float(conf))
                for text, conf in zip(data["text"], data["conf"])
                if text.strip() and float(conf) >= 0
            ]
            text = " ".join(word for word, _ in words)
            fields = extract_contact_fields(text).model_dump(exclude_none=True)
            confidence = {
                key: sum(conf for _, conf in words) / len(words) / 100
                for key in fields
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
