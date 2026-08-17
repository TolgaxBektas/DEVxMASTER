from PIL import Image
import types

from app.services.content_anchors import (
    _grid_neighbors,
    _phone,
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
    assert result["status"] == "abweichung"
    assert any(
        finding["category"] == "E-Mail-Adresse"
        and finding["value"] == "alt@example.de"
        and finding["severity"] == "unsicher"
        for finding in result["findings"]
    )
    assert any(
        finding["category"] == "E-Mail-Adresse"
        and finding["value"] == "neu@example.de"
        and finding["severity"] == "unsicher"
        for finding in result["findings"]
    )
    assert any(
        finding["category"] == "QR-Code-Inhalt"
        and finding["value"] == "https://example.de"
        for finding in result["findings"]
    )


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


def test_phone_ocr_difference_is_uncertain_not_passed():
    result = compare_content_anchors(
        {
            "text_lines": ["Telefon 0516160410"],
            "phones": ["0516160410"],
            "emails": [],
            "domains": [],
            "qr_codes": [],
            "qr_present": False,
            "qr_detection": "available",
        },
        {
            "text_lines": ["Telefon 051616040"],
            "phones": ["051616040"],
            "emails": [],
            "domains": [],
            "qr_codes": [],
            "qr_present": False,
            "qr_detection": "available",
        },
    )
    assert result["status"] == "unsicher"
    assert result["findings"][0]["severity"] == "unsicher"


def test_phone_normalization_uses_one_canonical_german_form():
    assert _phone("0049 40 123456") == "040123456"
    assert _phone("+49 40 123456") == "040123456"
    assert _phone("040 123456") == "040123456"
    assert _phone("0043 1 234567") == _phone("+43 1 234567")


def test_grid_neighbors_do_not_wrap_between_edge_columns():
    assert 11 not in _grid_neighbors(0)
    assert 0 not in _grid_neighbors(11)
    assert 12 in _grid_neighbors(0)
    assert 10 in _grid_neighbors(11)


def test_text_comparison_reports_substantial_missing_run():
    result = compare_content_anchors(
        {
            "text_lines": [
                "Interessiert Noch Fragen Melde Dich",
                "Muster GmbH Telefon 040 123456",
            ],
            "phones": [],
            "emails": [],
            "domains": [],
            "qr_codes": [],
            "qr_present": False,
            "qr_detection": "available",
        },
        {
            "text_lines": ["Muster GmbH Telefon 040 123456"],
            "phones": [],
            "emails": [],
            "domains": [],
            "qr_codes": [],
            "qr_present": False,
            "qr_detection": "available",
        },
    )
    assert any(
        finding["category"] == "Text"
        and finding["severity"] == "abweichung"
        for finding in result["findings"]
    )


def test_ocr_uses_shared_effective_resolution(monkeypatch):
    seen_sizes = []
    fake_tesseract = types.SimpleNamespace(
        image_to_string=lambda image, lang: (
            seen_sizes.append(image.size) or "Muster GmbH"
        ),
    )
    monkeypatch.setitem(__import__("sys").modules, "pytesseract", fake_tesseract)
    extract_content_anchors(Image.new("RGB", (20, 10), "white"), ocr_size=(80, 40))
    assert seen_sizes[0] == (80, 40)
