from PIL import Image

from app.services.content_anchors import (
    compare_content_anchors,
    extract_content_anchors,
)


def test_content_comparison_reports_missing_and_new_contacts():
    result = compare_content_anchors(
        {
            "text_lines": ["Firma", "Telefon 040 123456"],
            "phones": ["040123456"],
            "emails": ["alt@example.de"],
            "domains": ["example.de"],
            "qr_codes": ["https://example.de"],
            "qr_present": True,
            "qr_detection": "available",
        },
        {
            "text_lines": ["Firma"],
            "phones": ["040123456"],
            "emails": ["neu@example.de"],
            "domains": ["example.de"],
            "qr_codes": [],
            "qr_present": False,
            "qr_detection": "available",
        },
    )
    assert result["status"] == "findings"
    assert {"type": "missing", "category": "E-Mail-Adresse", "value": "alt@example.de"} in result["findings"]
    assert {"type": "new", "category": "E-Mail-Adresse", "value": "neu@example.de"} in result["findings"]
    assert {"type": "missing", "category": "QR-Code-Inhalt", "value": "https://example.de"} in result["findings"]


def test_anchor_extraction_keeps_text_and_is_safe_without_qr(monkeypatch):
    monkeypatch.setitem(__import__("sys").modules, "pyzbar", None)
    anchors = extract_content_anchors(
        Image.new("RGB", (32, 32), "white"),
        text="Muster GmbH\nTelefon 040 123456\nwww.example.de",
    )
    assert anchors["text_lines"] == [
        "muster gmbh",
        "telefon 040 123456",
        "www.example.de",
    ]
    assert anchors["phones"] == ["040123456"]
