from PIL import Image
import types

from app.services.content_anchors import (
    compare_content_anchors,
    extract_content_anchors,
)


def test_content_comparison_reports_missing_and_new_contacts():
    result = compare_content_anchors(
        {
            "text_lines": [
                "Firma Muster GmbH",
                "Telefon 040 123456",
                "Büro Hamburg Innenstadt",
                "Montag bis Freitag geöffnet",
                "www.example.de",
            ],
            "phones": ["040123456"],
            "emails": ["alt@example.de"],
            "domains": ["example.de"],
            "qr_codes": ["https://example.de"],
            "qr_present": True,
            "qr_detection": "available",
        },
        {
            "text_lines": [
                "Firma Muster GmbH",
                "Telefon 040 123456",
                "Büro Hamburg Innenstadt",
                "Montag bis Freitag geöffnet",
                "www.example.de",
            ],
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
        and finding["severity"] == "abweichung"
        for finding in result["findings"]
    )
    assert any(
        finding["category"] == "E-Mail-Adresse"
        and finding["value"] == "neu@example.de"
        and finding["severity"] == "abweichung"
        for finding in result["findings"]
    )
    assert result["qr_removed"] is True
    assert not any(finding["category"].startswith("QR-Code") for finding in result["findings"])


def test_qr_removal_semantics():
    base = {
        "text_lines": ["Firma mit ausreichend lesbarem Text"],
        "phones": [],
        "emails": [],
        "domains": [],
        "qr_codes": [],
        "qr_detection": "available",
    }
    removed = compare_content_anchors(
        {**base, "qr_present": True},
        {**base, "qr_present": False},
    )
    assert removed["status"] == "passed"
    assert removed["qr_removed"] is True

    retained = compare_content_anchors(
        {**base, "qr_present": True},
        {**base, "qr_present": True},
    )
    assert retained["status"] == "unsicher"
    assert retained["findings"][0]["value"] == "QR-Code nicht entfernt"

    invented = compare_content_anchors(
        {**base, "qr_present": False},
        {**base, "qr_present": True},
    )
    assert invented["status"] == "abweichung"


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
