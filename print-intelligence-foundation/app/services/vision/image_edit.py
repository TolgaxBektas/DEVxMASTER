import base64
from dataclasses import dataclass
import hashlib
import io
import json
import math
from pathlib import Path
from typing import Protocol
from urllib.parse import urlparse

import httpx
from PIL import Image

from app.services.downloader import validate_public_url


@dataclass(frozen=True)
class ImageEditResult:
    image: Image.Image
    model: str
    reported_cost: float | None


class ImageEditProvider(Protocol):
    def edit(
        self,
        image: Image.Image,
        prompt: str,
        rejection_reasons: list[str] | None = None,
        size: str | None = None,
    ) -> ImageEditResult: ...

    def available(self) -> bool: ...


def image_sha256(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, format="PNG", optimize=False)
    return hashlib.sha256(buffer.getvalue()).hexdigest()


SUPPORTED_IMAGE_EDIT_SIZES = {
    "1024x1024": (1024, 1024),
    "1536x1024": (1536, 1024),
    "1024x1536": (1024, 1536),
}


def select_image_edit_size(image_size: tuple[int, int]) -> tuple[str, tuple[int, int]]:
    width, height = image_size
    if width <= 0 or height <= 0:
        raise ValueError("image edit source dimensions must be positive")
    ratio = width / height
    selected = min(
        SUPPORTED_IMAGE_EDIT_SIZES,
        key=lambda name: abs(
            math.log(ratio)
            - math.log(
                SUPPORTED_IMAGE_EDIT_SIZES[name][0]
                / SUPPORTED_IMAGE_EDIT_SIZES[name][1]
            )
        ),
    )
    return selected, SUPPORTED_IMAGE_EDIT_SIZES[selected]


def prepare_image_edit_input(
    image: Image.Image, target_size: tuple[int, int]
) -> tuple[Image.Image, tuple[int, int, int, int]]:
    target_width, target_height = target_size
    scale = min(target_width / image.width, target_height / image.height)
    resized_size = (round(image.width * scale), round(image.height * scale))
    resized = image.convert("RGB").resize(resized_size, Image.Resampling.LANCZOS)
    left = (target_width - resized.width) // 2
    top = (target_height - resized.height) // 2
    prepared = Image.new("RGB", target_size, (255, 255, 255))
    prepared.paste(resized, (left, top))
    return prepared, (left, top, left + resized.width, top + resized.height)


def restore_image_edit_output(
    image: Image.Image,
    fitted_region: tuple[int, int, int, int],
    source_size: tuple[int, int],
) -> Image.Image:
    cropped = image.crop(fitted_region)
    return cropped.resize(source_size, Image.Resampling.LANCZOS)


class RecordedImageEditProvider:
    def __init__(self, directory: str | Path):
        self.directory = Path(directory)

    def edit(
        self,
        image: Image.Image,
        prompt: str,
        rejection_reasons: list[str] | None = None,
        size: str | None = None,
    ) -> ImageEditResult:
        del prompt, rejection_reasons, size
        digest = image_sha256(image)
        manifest_path = self.directory / f"{digest}.json"
        if not manifest_path.exists():
            raise FileNotFoundError(f"recorded image edit fixture is missing: {digest}")
        payload = json.loads(manifest_path.read_text())
        image_path = self.directory / payload["image"]
        return ImageEditResult(
            Image.open(image_path).convert("RGB"),
            str(payload.get("model", "recorded-image-edit")),
            payload.get("reported_cost"),
        )

    def available(self) -> bool:
        return self.directory.is_dir()


class OpenAIImageEditProvider:
    def __init__(
        self,
        base_url: str,
        model: str,
        api_key: str,
        timeout: float = 120.0,
        quality: str = "medium",
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.timeout = timeout
        self.quality = quality

    def edit(
        self,
        image: Image.Image,
        prompt: str,
        rejection_reasons: list[str] | None = None,
        size: str | None = None,
    ) -> ImageEditResult:
        self._validate_base_url()
        buffer = io.BytesIO()
        image.convert("RGB").save(buffer, format="PNG", optimize=False)
        full_prompt = prompt
        if rejection_reasons:
            full_prompt += "\nPrevious refusal reasons:\n- " + "\n- ".join(
                rejection_reasons
            )
        try:
            response = httpx.post(
                f"{self.base_url}/images/edits",
                headers={"Authorization": f"Bearer {self.api_key}"},
                files={"image": ("artwork.png", buffer.getvalue(), "image/png")},
                data={
                    "model": self.model,
                    "prompt": full_prompt,
                    "size": size or "auto",
                    "quality": self.quality,
                },
                timeout=self.timeout,
                follow_redirects=False,
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            detail = self._response_error_detail(exc.response)
            suffix = f": {detail}" if detail else ""
            raise ValueError(
                f"image edit HTTP request failed: {exc}{suffix}"
            ) from exc
        except httpx.HTTPError as exc:
            raise ValueError(f"image edit HTTP request failed: {exc}") from exc
        try:
            payload = response.json()
            item = payload["data"][0]
        except (TypeError, KeyError, IndexError, ValueError) as exc:
            raise ValueError("image edit provider returned no image data") from exc
        encoded = item.get("b64_json")
        if not encoded:
            raise ValueError("image edit provider returned no b64_json image")
        return ImageEditResult(
            Image.open(io.BytesIO(base64.b64decode(encoded))).convert("RGB"),
            self.model,
            item.get("cost", payload.get("cost")),
        )

    def available(self) -> bool:
        return bool(self.api_key)

    @staticmethod
    def _response_error_detail(response: httpx.Response) -> str:
        try:
            payload = response.json()
        except ValueError:
            return ""
        error = payload.get("error") if isinstance(payload, dict) else None
        if not isinstance(error, dict):
            return ""
        detail = {
            key: error[key]
            for key in ("message", "type", "code", "param")
            if error.get(key) is not None
        }
        if not detail:
            return ""
        return json.dumps(detail, ensure_ascii=False)[:500]

    def _validate_base_url(self) -> None:
        parsed = urlparse(self.base_url)
        if parsed.scheme != "https" or not parsed.hostname:
            raise ValueError("image edit base URL must use https with a valid host")
        try:
            parsed.port
        except ValueError as exc:
            raise ValueError("image edit base URL has an invalid port") from exc
        validate_public_url(self.base_url)
