import base64
from io import BytesIO
import time
import httpx
from PIL import Image

from app.services.parsing import parse_qwen_response


class OllamaVisionProvider:
    def __init__(
        self,
        host: str,
        model: str,
        timeout: float = 120,
        retries: int = 2,
        preview_max_dimension: int | None = 1600,
    ):
        self.host, self.model, self.timeout, self.retries = (
            host.rstrip("/"),
            model,
            timeout,
            retries,
        )
        self.preview_max_dimension = preview_max_dimension

    def _encode_image(self, image_path: str, preview: bool = False) -> str:
        if (
            not preview
            or self.preview_max_dimension is None
            or self.preview_max_dimension <= 0
        ):
            with open(image_path, "rb") as image_file:
                return base64.b64encode(image_file.read()).decode()
        with Image.open(image_path) as source:
            if max(source.size) <= self.preview_max_dimension:
                with open(image_path, "rb") as image_file:
                    return base64.b64encode(image_file.read()).decode()
            image = source.convert("RGB")
            image.thumbnail(
                (self.preview_max_dimension, self.preview_max_dimension),
                Image.Resampling.LANCZOS,
            )
            output = BytesIO()
            image.save(output, format="JPEG", quality=78, optimize=True)
        return base64.b64encode(output.getvalue()).decode()

    def _call(self, prompt: str, image_path: str, preview: bool = False) -> dict:
        image = self._encode_image(image_path, preview)
        schema = {
            "type": "object",
            "properties": {
                "advertisements": {"type": "array"},
                "company": {"type": "string"},
                "phone": {"type": "string"},
                "email": {"type": "string"},
                "domain": {"type": "string"},
                "address": {"type": "string"},
                "industry": {"type": "string"},
            },
        }
        payload = {
            "model": self.model,
            "stream": False,
            "think": False,
            "format": schema,
            "options": {"num_predict": 1200},
            "messages": [{"role": "user", "content": prompt, "images": [image]}],
        }
        for attempt in range(self.retries + 1):
            try:
                response = httpx.post(
                    f"{self.host}/api/chat", json=payload, timeout=self.timeout
                )
                response.raise_for_status()
                return response.json()
            except (httpx.HTTPError, OSError):
                if attempt == self.retries:
                    raise
                time.sleep(2**attempt)
        return {}

    def detect_ads(self, image_path: str, page_number: int) -> list[dict]:
        result = parse_qwen_response(
            self._call(
                "Return JSON advertisements with company_name and bbox [x1,y1,x2,y2]. Return only JSON.",
                image_path,
                preview=True,
            )
        )
        if isinstance(result, dict):
            result = result.get("advertisements", result.get("ads", [result]))
        if not isinstance(result, list):
            return []
        normalized = []
        for advert in result:
            if not isinstance(advert, dict):
                continue
            raw_bbox = advert.get("bbox") or advert.get("bbox_2d")
            if not isinstance(raw_bbox, (list, tuple)) or len(raw_bbox) < 4:
                continue
            try:
                bbox = [float(value) for value in raw_bbox[:4]]
            except (TypeError, ValueError):
                continue
            normalized.append(
                {
                    **{
                        key: value
                        for key, value in advert.items()
                        if key not in {"bbox", "bbox_2d"}
                    },
                    "bbox": bbox,
                }
            )
        return normalized

    def extract_fields(self, crop_path: str) -> dict:
        result = parse_qwen_response(
            self._call(
                "Extract JSON fields company, phone, email, domain, address, industry. Return only JSON.",
                crop_path,
            )
        )
        return result if isinstance(result, dict) else {}

    def available(self) -> bool:
        try:
            response = httpx.get(f"{self.host}/api/tags", timeout=5)
            configured = self.model.split(":", 1)[0]
            return response.is_success and any(
                x.get("name", "").split(":", 1)[0] == configured
                or x.get("model", "").split(":", 1)[0] == configured
                for x in response.json().get("models", [])
            )
        except httpx.HTTPError:
            return False
