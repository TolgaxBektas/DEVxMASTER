from PIL import Image
import types

import app.services.content_anchors as anchors_module
from app.services.content_anchors import (
    _decode_qr,
    _grid_neighbors,
    _phone,
    compare_content_anchors,
    compare_visual_motifs,
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
    assert not any(
        finding["category"] == "QR-Code-Anwesenheit"
        for finding in result["findings"]
    )


def test_qr_payload_removal_is_intentional():
    base = {
        "text_lines": ["Firma mit ausreichend lesbarem Text"],
        "phones": [],
        "emails": [],
        "domains": [],
        "qr_detection": "available",
        "qr_present": True,
    }
    result = compare_content_anchors(
        {**base, "qr_codes": ["https://example.de"]},
        {**base, "qr_codes": [], "qr_present": False},
    )
    assert result["status"] == "passed"
    assert result["qr_removed"] is True
    assert result["findings"] == []


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


def test_watermark_removal_semantics_excludes_marker_from_text_comparison():
    base = {
        "phones": [],
        "emails": [],
        "domains": [],
        "qr_codes": [],
        "qr_present": False,
        "qr_detection": "available",
    }
    removed = compare_content_anchors(
        {
            **base,
            "text_lines": ["Muster GmbH", "© inixmedia"],
        },
        {
            **base,
            "text_lines": ["Muster GmbH"],
        },
        watermark_markers=["inixmedia"],
    )
    assert removed["status"] == "passed"
    assert removed["watermark_removed"] is True
    assert removed["watermark_markers_original"] == ["inixmedia"]

    retained = compare_content_anchors(
        {
            **base,
            "text_lines": ["Muster GmbH", "© inixmedia"],
        },
        {
            **base,
            "text_lines": ["Muster GmbH", "© inixmedia"],
        },
        watermark_markers=["inixmedia"],
    )
    assert retained["status"] == "unsicher"
    assert retained["findings"][0]["category"] == "Wasserzeichen"

    invented = compare_content_anchors(
        {**base, "text_lines": ["Muster GmbH"]},
        {**base, "text_lines": ["Muster GmbH inixmedia"]},
        watermark_markers=["inixmedia"],
    )
    assert invented["status"] == "abweichung"
    assert invented["findings"][0]["severity"] == "abweichung"


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


def test_qr_decoder_region_accounts_for_tile_offset(monkeypatch):
    calls = []

    class Rect:
        left = 100
        top = 50
        width = 200
        height = 100

    class Item:
        data = b"https://example.de"
        rect = Rect()
        type = "QRCODE"

    def decode(image):
        calls.append(image.size)
        return [Item()] if len(calls) == 7 else []

    monkeypatch.setitem(
        __import__("sys").modules,
        "pyzbar.pyzbar",
        types.SimpleNamespace(decode=decode),
    )
    values, finding, region = _decode_qr(Image.new("RGB", (2000, 2000), "white"))
    assert values == ["https://example.de"]
    assert finding is None
    assert region == {"x": 660.0, "y": 30.0, "width": 120.0, "height": 60.0}


def test_qr_decoder_ignores_non_qr_payload_region(monkeypatch):
    class Rect:
        left = 10
        top = 20
        width = 100
        height = 40

    class Item:
        data = b"https://example.de"
        rect = Rect()
        type = "CODE128"

    monkeypatch.setitem(
        __import__("sys").modules,
        "pyzbar.pyzbar",
        types.SimpleNamespace(decode=lambda _image: [Item()]),
    )
    values, finding, region = _decode_qr(Image.new("RGB", (32, 32), "white"))
    assert values == []
    assert finding is None
    assert region is None


def test_qr_heuristic_without_decoder_confirmation_is_not_presence(
    monkeypatch,
):
    monkeypatch.setattr(
        anchors_module,
        "_qr_presence",
        lambda _image: (True, 0.99, {"x": 4, "y": 4, "width": 20, "height": 20}),
    )
    monkeypatch.setattr(
        anchors_module,
        "_decode_qr",
        lambda _image: ([], None, None),
    )
    anchors = extract_content_anchors(
        Image.new("RGB", (32, 32), "white"),
        text="Anzeigentext",
    )
    assert anchors["qr_present"] is False
    assert anchors["qr_region"] is None
    assert anchors["qr_presence_score"] is None
    comparison = compare_content_anchors(anchors, anchors)
    assert not any(
        finding["category"] == "QR-Code-Anwesenheit"
        for finding in comparison["findings"]
    )


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


def test_low_ocr_confidence_downgrades_structured_contact_difference():
    result = compare_content_anchors(
        {
            "text_lines": ["Firma"],
            "emails": ["alt@example.de"],
            "ocr_confidence": 60,
        },
        {
            "text_lines": ["Firma"],
            "emails": ["neu@example.de"],
            "ocr_confidence": 60,
        },
    )
    email_findings = [
        finding
        for finding in result["findings"]
        if finding["category"] == "E-Mail-Adresse"
    ]
    assert email_findings
    assert all(finding["severity"] == "unsicher" for finding in email_findings)


def test_short_clean_text_does_not_downgrade_structured_contact_difference():
    result = compare_content_anchors(
        {
            "text_lines": ["Firma"],
            "emails": ["alt@example.de"],
            "ocr_confidence": 98,
        },
        {
            "text_lines": ["Firma"],
            "emails": ["neu@example.de"],
            "ocr_confidence": 98,
        },
    )
    email_findings = [
        finding
        for finding in result["findings"]
        if finding["category"] == "E-Mail-Adresse"
    ]
    assert email_findings
    assert all(finding["severity"] == "abweichung" for finding in email_findings)


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


def _visual_result(monkeypatch, original_grid, restored_grid, region):
    original = Image.new("RGB", (96, 96), "white")
    restored = Image.new("RGB", (96, 96), "white")
    grid_calls = iter([original_grid, *([restored_grid] * 150)])
    monkeypatch.setattr(
        anchors_module,
        "_aligned_candidate",
        lambda *_args, **_kwargs: restored,
    )
    monkeypatch.setattr(
        anchors_module,
        "_edge_grid",
        lambda _image: next(grid_calls),
    )
    monkeypatch.setattr(
        anchors_module,
        "_edge_bitmap",
        lambda _image: [False] * 144,
    )
    return compare_visual_motifs(
        original,
        restored,
        excluded_lost_regions=[region],
    )


def test_qr_removed_excludes_only_lost_qr_region(monkeypatch):
    original_grid = [0.0] * 144
    restored_grid = [0.0] * 144
    for index in (13, 14, 25, 26):
        original_grid[index] = 0.5
    result = _visual_result(
        monkeypatch,
        original_grid,
        restored_grid,
        {"x": 8, "y": 8, "width": 24, "height": 24},
    )
    assert result["lost_cells"] == 0
    assert not result["findings"]


def test_qr_removed_does_not_hide_lost_motif_elsewhere(monkeypatch):
    original_grid = [0.0] * 144
    restored_grid = [0.0] * 144
    for index in (13, 14, 25, 26, 100, 101):
        original_grid[index] = 0.5
    result = _visual_result(
        monkeypatch,
        original_grid,
        restored_grid,
        {"x": 0, "y": 0, "width": 96, "height": 96},
    )
    assert result["lost_cells"] > 0
    assert any(finding["severity"] == "abweichung" for finding in result["findings"])


def test_qr_region_does_not_hide_added_content(monkeypatch):
    original_grid = [0.0] * 144
    restored_grid = [0.0] * 144
    for index in (13, 14, 25, 26):
        restored_grid[index] = 0.5
    result = _visual_result(
        monkeypatch,
        original_grid,
        restored_grid,
        {"x": 8, "y": 8, "width": 24, "height": 24},
    )
    assert result["added_cells"] > 0
    assert any(finding["severity"] == "abweichung" for finding in result["findings"])
