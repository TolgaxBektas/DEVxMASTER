from app.services.parsing import parse_qwen_response
from app.services.bbox import Box, deduplicate_boxes, iou, normalize_bbox
from app.services.dedupe import normalize_name, contact_key
from app.services.extraction import extract_contact_fields
from app.services.discovery import discover_pdf_links
from app.services.text_layer import remove_substring_bleed
from app.services.vision.ollama import OllamaVisionProvider


def test_qwen_shapes():
    assert parse_qwen_response({"message": {"content": '```json\n{"a": 1}\n```'}}) == {
        "a": 1
    }
    assert parse_qwen_response(
        {"message": {"content": "", "thinking": "Here: {'a': 1}"}}
    ) == {"a": 1}
    assert parse_qwen_response("no ads on this page") == []
    assert parse_qwen_response(
        '{"advertisements":[{"company_name":"A"}, {"company_name":"B"}'
    ) == [{"company_name": "A"}, {"company_name": "B"}]
    assert parse_qwen_response("{'a': 1,}") == {"a": 1}


def test_ollama_request_disables_thinking_for_structured_output(monkeypatch, tmp_path):
    image = tmp_path / "image.png"
    image.write_bytes(b"image")
    captured = {}

    class Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {"message": {"content": '{"a": 1}'}}

    def post(url, json, timeout):
        captured.update(json)
        return Response()

    monkeypatch.setattr("app.services.vision.ollama.httpx.post", post)
    result = OllamaVisionProvider("http://ollama", "qwen3-vl:4b")._call(
        "Return JSON", str(image)
    )
    assert captured["think"] is False
    assert result["message"]["content"] == '{"a": 1}'


def test_ollama_detection_canonicalizes_bbox_variants(monkeypatch):
    provider = OllamaVisionProvider("http://ollama", "qwen3-vl:4b")
    monkeypatch.setattr(
        provider,
        "_call",
        lambda prompt, image_path: {
            "message": {
                "content": (
                    '[{"company_name":"A","bbox_2d":[10,"20",30,40]},'
                    '{"company_name":"bad","bbox":["x",1,2,3]}]'
                )
            }
        },
    )
    assert provider.detect_ads("image.png", 1) == [
        {"company_name": "A", "bbox": [10.0, 20.0, 30.0, 40.0]}
    ]


def test_bbox_and_overlap():
    assert normalize_bbox([70, 68, 925, 264], (1000, 2000)) == Box(70, 136, 925, 528)
    assert normalize_bbox([0, 0, 1, 1], (1000, 1000)) is None
    assert len(deduplicate_boxes([Box(0, 0, 100, 100), Box(1, 1, 99, 99)])) == 1
    assert iou(Box(0, 0, 10, 10), Box(20, 20, 30, 30)) == 0


def test_german_contacts():
    fields = extract_contact_fields(
        "AWO\nTel. 06441 / 9484-0\ninfo@example.de\nwww.awo.de\n35576 Wetzlar"
    )
    assert fields.email == "info@example.de"
    assert fields.phone
    assert fields.raw_phone == "06441 / 9484-0"
    assert fields.phone == "0644194840"
    assert fields.domain == "www.awo.de"
    assert fields.address == "35576 Wetzlar"


def test_contact_normalization():
    fields = extract_contact_fields(
        "Steubenstraße 13 • 35576 Wetzlar\nWWW.PIETAET-ULM.DE\n+49 (6441) / 42302"
    )
    assert fields.domain == "www.pietaet-ulm.de"
    assert fields.phone == "+49644142302"
    assert fields.raw_phone == "+49 (6441) / 42302"
    assert fields.address == "Steubenstraße 13, 35576 Wetzlar"


def test_multiline_german_address_assembly():
    fields = extract_contact_fields(
        "PFANNENSTIELSGASSE 11 – 13\n35578 WETZLAR\nTELEFON 06441 42302"
    )
    assert fields.address == "PFANNENSTIELSGASSE 11 – 13 35578 WETZLAR"


def test_substring_bleed_removal_keeps_short_phone_text():
    assert remove_substring_bleed(
        ["Tagsüber in guten Händen, ab", "AWO Tagsüber in guten Händen, abends"]
    ) == ["", "AWO Tagsüber in guten Händen, abends"]
    assert remove_substring_bleed(["Tel. 06441 1234", "Andere Anzeige"]) == [
        "Tel. 06441 1234",
        "Andere Anzeige",
    ]


def test_normalization_and_discovery():
    assert normalize_name("ÄÖÜ GmbH & Co. KG") == "aou gmbh co kg"
    assert contact_key({"email": "A@B.DE"}) == "|a@b.de|"
    assert discover_pdf_links(
        '<a href="/a.pdf">A</a><a href="x.html">X</a>', "https://example.test/"
    ) == ["https://example.test/a.pdf"]
