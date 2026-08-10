import json
from pathlib import Path


class RecordedVisionProvider:
    def __init__(self, directory: str | Path):
        self.directory = Path(directory)

    def detect_ads(self, image_path: str, page_number: int) -> list[dict]:
        path = self.directory / f"page_{page_number}.json"
        if not path.exists():
            return []
        return json.loads(path.read_text()).get("advertisements", [])

    def extract_fields(self, crop_path: str) -> dict:
        path = self.directory / f"{Path(crop_path).stem}.json"
        return json.loads(path.read_text()).get("fields", {}) if path.exists() else {}

    def available(self) -> bool:
        return True
