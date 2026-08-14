import base64
from dataclasses import dataclass
import hashlib
import io
import json
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
    ) -> ImageEditResult: ...

    def available(self) -> bool: ...


def image_sha256(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, format="PNG", optimize=False)
    return hashlib.sha256(buffer.getvalue()).hexdigest()


class RecordedImageEditProvider:
    def __init__(self, directory: str | Path):
        self.directory = Path(directory)

    def edit(
        self,
        image: Image.Image,
        prompt: str,
        rejection_reasons: list[str] | None = None,
    ) -> ImageEditResult:
        del prompt, rejection_reasons
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
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.timeout = timeout

    def edit(
        self,
        image: Image.Image,
        prompt: str,
        rejection_reasons: list[str] | None = None,
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
                },
                timeout=self.timeout,
            )
            response.raise_for_status()
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

    def _validate_base_url(self) -> None:
        parsed = urlparse(self.base_url)
        if parsed.scheme != "https" or not parsed.hostname:
            raise ValueError("image edit base URL must use https with a valid host")
        try:
            parsed.port
        except ValueError as exc:
            raise ValueError("image edit base URL has an invalid port") from exc
        validate_public_url(self.base_url)
