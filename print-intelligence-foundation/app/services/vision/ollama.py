import base64
import time
import httpx
from app.services.parsing import parse_qwen_response


class OllamaVisionProvider:
    def __init__(self, host: str, model: str, timeout: float = 120, retries: int = 2):
        self.host, self.model, self.timeout, self.retries = (
            host.rstrip("/"),
            model,
            timeout,
            retries,
        )

    def _call(self, prompt: str, image_path: str) -> dict:
        with open(image_path, "rb") as image_file:
            image = base64.b64encode(image_file.read()).decode()
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
            )
        )
        if isinstance(result, dict):
            result = result.get("advertisements", result.get("ads", [result]))
        return result if isinstance(result, list) else []

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
