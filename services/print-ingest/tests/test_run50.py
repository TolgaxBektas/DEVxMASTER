import hashlib
import io
import json
import re

import fitz
import pytest
from PIL import Image
from fastapi.testclient import TestClient

from app.api import stateless
from app.core.config import settings
from app.main import app
from app.services import run50
from app.services.run50 import (
    CROP_CHECK_PROMPT,
    CROP_CHECK_PROMPT_FILE,
    DETECTOR_PROMPT,
    DETECTOR_PROMPT_FILE,
    Run50PageResult,
    ResponsesClient,
    _norm_name,
    _same_name,
    customer_exclusion,
    detect_document,
    detect_page,
    is_order_form_page,
)


class FakeClient:
    def __init__(self, detector_results=None, crop_results=None):
        self.detector_results = list(detector_results or [])
        self.crop_results = list(crop_results or [])
        self.calls = []

    def ask(self, prompt, png, max_edge):
        self.calls.append((prompt, png, max_edge))
        if max_edge == 2000:
            result = self.detector_results.pop(0)
        else:
            result = self.crop_results.pop(0)
        return result, {"usage": {"input_tokens": 100, "output_tokens": 20}}


class FakeStorage:
    def __init__(self):
        self.objects = {}

    def put_bytes(self, key, data, content_type="application/octet-stream"):
        self.objects[key] = (data, content_type)


def _pdf(pages):
    document = fitz.open()
    for page_spec in pages:
        page = document.new_page(width=600, height=800)
        for index, rect in enumerate(page_spec.get("ads", []), start=1):
            box = fitz.Rect(*rect)
            page.draw_rect(box, color=(0, 0, 0), width=1)
            page.insert_text(
                (box.x0 + 10, box.y0 + 30),
                f"Musterfirma {index} GmbH",
                fontsize=12,
            )
            page.insert_text(
                (box.x0 + 10, box.y0 + 60),
                "Telefon 01234 567890 www.muster.example",
                fontsize=10,
            )
    data = document.tobytes()
    document.close()
    return data


def _bbox(rect, width=600, height=800):
    x0, y0, x1, y1 = rect
    return [
        x0 / width * 100,
        y0 / height * 100,
        x1 / width * 100,
        y1 / height * 100,
    ]


def _detector_ad(rect, company="Detektor GmbH", confidence=0.9, bbox=None):
    return {
        "company_name": company,
        "bbox": bbox if bbox is not None else _bbox(rect),
        "confidence": confidence,
        "has_frame": True,
        "is_full_bleed": False,
    }


def _verdict(
    company="Prüf GmbH",
    content="single_advertisement",
    confidence=0.9,
    tight_bbox=None,
    foreign=None,
    cut_off=None,
):
    return {
        "content": content,
        "advertiser": company,
        "tight_bbox": tight_bbox or [5, 5, 95, 95],
        "cut_off_sides": cut_off or [],
        "foreign_content_sides": foreign or [],
        "confidence": confidence,
    }


def _rendered_page(pdf_bytes):
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    page = doc[0]
    image = page.get_pixmap(matrix=fitz.Matrix(180 / 72, 180 / 72), alpha=False)
    result = {
        "page_number": 1,
        "text": page.get_text("text"),
        "image_bytes": image.tobytes("png"),
        "classification": "MIXED_CONTENT",
        "ad_probability": 0.8,
        "layout": None,
    }
    doc.close()
    return result


def _run_one_page(pdf, ad, crop_results, layout=None):
    client = FakeClient([{"advertisements": [ad]}], crop_results)
    result = detect_page(pdf, 1, layout, client)
    return result, client


def test_prompt_files_hashes_and_sent_text():
    assert hashlib.sha256(DETECTOR_PROMPT_FILE.read_bytes()).hexdigest() == (
        "75d67fc6eb55d1c11d4a723f3ef7045f1a7cfffbaad161af9f2545ce8f50f1f7"
    )
    assert hashlib.sha256(CROP_CHECK_PROMPT_FILE.read_bytes()).hexdigest() == (
        "2b53b436d55a04174e7bab1b161b51068f36bc0924ea8b24436bbb4da926ab48"
    )
    detector_text = DETECTOR_PROMPT_FILE.read_text(encoding="utf-8")
    assert DETECTOR_PROMPT == re.search(
        r"```(?:text)?\n(.*?)\n```", detector_text, re.S
    ).group(1)
    assert CROP_CHECK_PROMPT == CROP_CHECK_PROMPT_FILE.read_text(encoding="utf-8")


def test_two_framed_ads_are_accepted_with_crop_provenance_and_evidence():
    boxes = [(40, 60, 280, 240), (320, 60, 560, 240)]
    pdf = _pdf([{"ads": boxes}])
    client = FakeClient(
        [{"advertisements": [_detector_ad(box) for box in boxes]}],
        [_verdict("Erster Kunde GmbH"), _verdict("Zweiter Kunde AG")],
    )

    result = detect_page(pdf, 1, None, client)

    assert len(result.accepted) == 2
    assert [ad.company for ad in result.accepted] == [
        "Erster Kunde GmbH",
        "Zweiter Kunde AG",
    ]
    assert all("positiv:run50" in ad.region["evidence"] for ad in result.accepted)
    assert all("positiv:p3" in ad.region["evidence"] for ad in result.accepted)
    assert all(ad.crop_info["margin_mm"] for ad in result.accepted)
    assert all(ad.run50["detector_ad"]["has_frame"] for ad in result.accepted)
    assert all(ad.run50["crop_check_first"]["confidence"] == 0.9 for ad in result.accepted)
    assert [call[2] for call in client.calls] == [2000, 1600, 1600]
    assert result.usage == [
        {"input_tokens": 100, "output_tokens": 20},
        {"input_tokens": 100, "output_tokens": 20},
        {"input_tokens": 100, "output_tokens": 20},
    ]
    assert all(len(ad.run50["usage"]) == 2 for ad in result.accepted)
    assert result.accepted[0].region["x"] != result.accepted[0].crop_info["crop_bbox"]["x"]


def test_unparseable_detector_response_creates_one_page_rejection():
    pdf = _pdf([{"ads": []}])
    client = FakeClient([None])

    result = detect_page(pdf, 1, None, client)

    assert len(result.rejected) == 1
    assert result.rejected[0].stage == "detector"
    assert result.rejected[0].reason == "antwort_unlesbar"
    assert result.accepted == []


def test_confidence_bbox_validation_and_fraction_units():
    box = (60, 80, 420, 320)
    pdf = _pdf([{"ads": [box]}])
    detector = {
        "advertisements": [
            _detector_ad(box, confidence=0.4),
            _detector_ad(box, bbox=[10, 150, 70, 350]),
            _detector_ad(box, bbox=[10, 1001, 70, 350]),
        ]
    }
    client = FakeClient([detector], [_verdict()])

    result = detect_page(pdf, 1, None, client)

    assert len(result.accepted) == 1
    accepted = result.accepted[0]
    assert accepted.region["x"] == pytest.approx(0.1)
    assert accepted.region["y"] == pytest.approx(0.15)
    assert accepted.region["width"] == pytest.approx(0.6)
    assert accepted.region["height"] == pytest.approx(0.2)
    assert "bbox:promille_korrigiert" in accepted.region["evidence"]
    assert accepted.run50["bbox_promille_korrigiert"] is True
    assert [rejection.reason for rejection in result.rejected] == [
        "konfidenz_unter_0_5",
        "bbox_werte_ueber_1000",
    ]

    fraction, _ = _run_one_page(
        pdf,
        _detector_ad(box, bbox=[0.1, 0.1, 0.7, 0.4]),
        [_verdict()],
    )
    assert len(fraction.accepted) == 1
    assert fraction.accepted[0].region["x"] == pytest.approx(0.1)


def test_glyph_growth_over_limit_continues_to_crop_check():
    document = fitz.open()
    page = document.new_page(width=600, height=800)
    rect = (40, 60, 300, 260)
    page.draw_rect(fitz.Rect(*rect), color=(0, 0, 0), width=1)
    page.insert_text(
        (50, 100), "Telefon 01234 567890 www.muster.example", fontsize=12
    )
    page.insert_text(
        (280, 180),
        "W" * 10,
        fontsize=64,
    )
    pdf = document.tobytes()
    document.close()

    result, client = _run_one_page(pdf, _detector_ad(rect), [_verdict()])

    assert len(result.accepted) == 1
    accepted = result.accepted[0]
    assert "glyph:randschnitt_zuschnittpruefung" in accepted.region["evidence"]
    assert accepted.run50["glyph_randschnitt"]
    assert len([call for call in client.calls if call[2] == 1600]) == 1


def test_malformed_bbox_is_rejected():
    pdf = _pdf([{"ads": [(60, 80, 420, 320)]}])
    client = FakeClient(
        [{"advertisements": [_detector_ad((60, 80, 420, 320), bbox=[1, "x", 3])]}]
    )

    result = detect_page(pdf, 1, None, client)

    assert result.rejected[0].reason == "bbox_ungueltig"


def test_too_small_and_no_contact_regions_are_rejected(monkeypatch):
    small_pdf = _pdf([{"ads": []}])
    small = _detector_ad((100, 100, 140, 140))
    small_result, _ = _run_one_page(small_pdf, small, [])
    assert small_result.rejected[0].reason == "zuschnitt_zu_klein"

    no_contact_pdf = _pdf([{"ads": []}])
    monkeypatch.setattr(run50.pytesseract, "image_to_string", lambda *_args, **_kwargs: "")
    no_contact, _ = _run_one_page(
        no_contact_pdf,
        _detector_ad((50, 60, 550, 700)),
        [],
    )
    assert no_contact.rejected[0].reason == "kein_kontaktwert"


def test_contained_box_is_rejected_as_overlap():
    outer = (40, 40, 550, 650)
    inner = (300, 250, 500, 500)
    pdf = _pdf([{"ads": [outer, inner]}])
    client = FakeClient(
        [{"advertisements": [_detector_ad(outer), _detector_ad(inner)]}],
        [_verdict()],
    )

    result = detect_page(pdf, 1, None, client)

    assert len(result.accepted) == 1
    assert any(
        rejection.stage == "overlap" and rejection.reason == "ueberlappung"
        for rejection in result.rejected
    )
    assert len([call for call in client.calls if call[2] == 1600]) == 1


def test_tight_bbox_repair_and_unresolved_multiple_advertisements():
    rect = (40, 60, 560, 600)
    pdf = _pdf([{"ads": [rect]}])
    first = _verdict(
        content="multiple_advertisements",
        foreign=["right"],
        tight_bbox=[5, 5, 95, 95],
    )
    result, client = _run_one_page(
        pdf,
        _detector_ad(rect),
        [first, _verdict("Einzelkunde GmbH")],
    )
    assert len(result.accepted) == 1
    assert result.accepted[0].run50["action"] == "tight_bbox"
    assert result.accepted[0].run50["crop_check_second"]["content"] == "single_advertisement"
    assert len([call for call in client.calls if call[2] == 1600]) == 2

    unresolved, unresolved_client = _run_one_page(
        pdf,
        _detector_ad(rect),
        [
            first,
            _verdict(content="multiple_advertisements", foreign=["right"]),
            _verdict(content="multiple_advertisements", foreign=["right"]),
        ],
    )
    assert unresolved.rejected[0].reason == "mehrere_anzeigen_nicht_trennbar"
    assert len([call for call in unresolved_client.calls if call[2] == 1600]) == 3


def test_partial_bottom_grows_checked_crop_before_second_check():
    rect = (40, 60, 560, 600)
    pdf = _pdf([{"ads": [rect]}])
    result, client = _run_one_page(
        pdf,
        _detector_ad(rect),
        [
            _verdict(content="partial_advertisement", cut_off=["bottom"]),
            _verdict("Vollständige Anzeige GmbH"),
        ],
    )

    assert len(result.accepted) == 1
    assert result.accepted[0].run50["action"] == "grow"
    assert result.accepted[0].region["y"] + result.accepted[0].region["height"] > (
        rect[3] / 800
    )
    assert len([call for call in client.calls if call[2] == 1600]) == 2


def test_crop_check_can_grow_then_tighten_in_two_repair_rounds():
    rect = (40, 60, 560, 600)
    pdf = _pdf([{"ads": [rect]}])
    result, client = _run_one_page(
        pdf,
        _detector_ad(rect),
        [
            _verdict(content="partial_advertisement", cut_off=["bottom"]),
            _verdict(content="multiple_advertisements", foreign=["right"]),
            _verdict("Vollständige Anzeige GmbH"),
        ],
    )

    assert len(result.accepted) == 1
    provenance = result.accepted[0].run50
    assert provenance["actions"] == ["grow", "tight_bbox"]
    assert provenance["action"] == "grow"
    assert provenance["crop_check_second"]["content"] == "multiple_advertisements"
    assert len(provenance["crop_check_rounds"]) == 3
    assert len([call for call in client.calls if call[2] == 1600]) == 3


def test_crop_check_repair_limit_rejects_after_three_partial_verdicts():
    rect = (40, 60, 560, 600)
    pdf = _pdf([{"ads": [rect]}])
    result, client = _run_one_page(
        pdf,
        _detector_ad(rect),
        [
            _verdict(content="partial_advertisement", cut_off=["bottom"]),
            _verdict(content="partial_advertisement", cut_off=["bottom"]),
            _verdict(content="partial_advertisement", cut_off=["bottom"]),
        ],
    )

    rejection = next(item for item in result.rejected if item.stage == "crop_check")
    assert rejection.reason == "randschnitt_nicht_behebbar"
    assert rejection.run50["actions"] == ["grow", "grow"]
    assert len(rejection.run50["crop_check_rounds"]) == 3
    assert rejection.run50["glyph_randschnitt"] == []
    assert rejection.run50["bbox_promille_korrigiert"] is False
    assert len([call for call in client.calls if call[2] == 1600]) == 3


def test_editorial_is_rejected_without_second_call_and_low_confidence_fails():
    rect = (40, 60, 560, 600)
    pdf = _pdf([{"ads": [rect]}])
    editorial, editorial_client = _run_one_page(
        pdf,
        _detector_ad(rect),
        [_verdict(content="editorial")],
    )
    assert editorial.rejected[0].reason == "redaktionell_keine_anzeige"
    assert len([call for call in editorial_client.calls if call[2] == 1600]) == 1

    low_confidence, _ = _run_one_page(
        pdf,
        _detector_ad(rect),
        [_verdict(confidence=0.65)],
    )
    assert low_confidence.rejected[0].reason == "crop_check_nicht_bestanden"


@pytest.mark.parametrize(
    ("company", "reason", "accepted", "evidence"),
    [
        ("TSV Neumarkt e.V.", "veto:verein", False, []),
        ("Landratsamt Neumarkt", "veto:behoerde", False, []),
        ("Pfarrei St. Johannes", "veto:kirche", False, []),
        ("Stadt-Apotheke", None, True, []),
        ("Caritas Pflegedienst", None, True, ["hinweis:traeger"]),
    ],
)
def test_customer_exclusions_and_commercial_charity_exceptions(
    company, reason, accepted, evidence
):
    rect = (40, 60, 560, 600)
    pdf = _pdf([{"ads": [rect]}])
    result, _ = _run_one_page(
        pdf,
        _detector_ad(rect),
        [_verdict(company)],
    )

    assert bool(result.accepted) is accepted
    if reason:
        rejection = next(item for item in result.rejected if item.stage == "exclusion")
        assert rejection.reason == reason
    else:
        assert all(item.reason != "veto:behoerde" for item in result.rejected)
        assert all(item in result.accepted[0].region["evidence"] for item in evidence)


@pytest.mark.parametrize(
    ("company", "text", "expected"),
    [
        ("Lohn- und Einkommensteuer Hilfe-Ring Deutschland e.V.", "", "veto:verein"),
        ("Malteser Waischenfeld e.V.", "", "veto:verein"),
        ("DIE JOHANNITER", "", "veto:verein"),
        (
            "Bayerisches Rotes Kreuz Kreisverband Miltenberg-Obernburg",
            "",
            "veto:verein",
        ),
        ("CSU Winzer-Neßlbach", "", "veto:verein"),
        ("Johanniter Pflege gGmbH", "", None),
        ("Caritas Pflegedienst", "", None),
        ("Unabhängige Thaler Liste, Oberstaufen", "", "veto:verein"),
        ("Freiwilligenagentur Landshut (fala)", "", "veto:verein"),
        ("vhs Volkshochschulen Nürnberger Land", "", "veto:behoerde"),
        ("Preisliste Autohaus Müller GmbH", "", None),
        ("LINUS WITTICH MEDIEN", "", "veto:verlag"),
        ("Jobmesse Franken", "Veranstalter LINUS WITTICH Medien KG", "veto:verlag"),
        ("anzeigen.wittich.de", "", "veto:verlag"),
        ("VG-Creußen JOURNAL", "", "veto:behoerde"),
        ("GÄSTEPASS", "Kostenlose Angebote der Gemeinde Pfofeld", "veto:behoerde"),
        (
            "Soziales Netzwerk Thierhaupten",
            "Ihr Ansprechpartner: Marktgemeinde Thierhaupten",
            "veto:behoerde",
        ),
        ("Autohaus KÜRBIS GmbH", "Ihr Partner in der Gemeinde Pfofeld", None),
        ("Stadt-Apotheke", "", None),
        ("Wittichenau Bäckerei", "", None),
        ("DIVANO", "Der Ort in der Mitte der Stadt Friedberg", None),
    ],
)
def test_customer_exclusion_run50_patterns(company, text, expected):
    assert customer_exclusion(company, text) == expected


def test_document_deduplicates_same_advertiser_by_largest_crop():
    small, large = (60, 60, 250, 220), (40, 40, 560, 600)
    pdf = _pdf([{"ads": [small]}, {"ads": [large]}])
    pages = [
        {"page_number": 1, "text": "", "layout": None},
        {"page_number": 2, "text": "", "layout": None},
    ]
    client = FakeClient(
        [
            {"advertisements": [_detector_ad(small)]},
            {"advertisements": [_detector_ad(large)]},
        ],
        [_verdict("Muster Kunden GmbH"), _verdict("Muster Kunden")],
    )

    results = detect_document(pdf, pages, client, concurrency=1)

    assert [result.page_number for result in results] == [1, 2]
    assert results[0].accepted == []
    assert len(results[1].accepted) == 1
    assert any(item.reason == "kunde_doppelt" for item in results[0].rejected)


def test_umlaut_name_variants_deduplicate_by_largest_crop():
    small, large = (60, 60, 250, 220), (40, 40, 560, 600)
    pdf = _pdf([{"ads": [small]}, {"ads": [large]}])
    pages = [
        {"page_number": 1, "text": "", "layout": None},
        {"page_number": 2, "text": "", "layout": None},
    ]
    client = FakeClient(
        [
            {"advertisements": [_detector_ad(small)]},
            {"advertisements": [_detector_ad(large)]},
        ],
        [_verdict("Müller Haustechnik"), _verdict("Mueller Haustechnik")],
    )

    results = detect_document(pdf, pages, client, concurrency=1)

    assert _norm_name("Müller GmbH") == _norm_name("Mueller GmbH") == "mueller"
    assert _same_name("Bäckerei Groß", "Baeckerei Gross")
    assert results[0].accepted == []
    assert [item.company for item in results[1].accepted] == ["Mueller Haustechnik"]
    duplicate = next(item for item in results[0].rejected if item.stage == "dedupe")
    assert duplicate.reason == "kunde_doppelt"


def test_decomposed_umlauts_normalize_before_expansion():
    assert _norm_name("O\u0308l AG") == _norm_name("Oel AG") == "oel"
    assert _norm_name("Mu\u0308ller GmbH") == "mueller"


def test_order_form_detection_requires_marker_and_two_label_canonicals():
    assert is_order_form_page(
        "Anzeigenauftrag\nFirma: Beispiel GmbH\nTel.: 01234 567890\nE-Mail: info@example.de"
    )
    assert not is_order_form_page("Auftraggeber")


def test_detect_document_skips_order_forms_without_client_calls():
    pdf = _pdf([{"ads": []}])
    client = FakeClient()
    pages = [
        {
            "page_number": 1,
            "text": "Auftraggeber: Beispiel\nFirma: Beispiel GmbH\nTel.: 01234",
            "layout": None,
        }
    ]

    result = detect_document(pdf, pages, client)

    assert result == [Run50PageResult(1, [], [], [])]
    assert client.calls == []


def test_responses_client_retries_429_and_parses_output_content(monkeypatch):
    responses = [
        type(
            "Response",
            (),
            {
                "status_code": 429,
                "raise_for_status": lambda self: None,
            },
        )(),
        type(
            "Response",
            (),
            {
                "status_code": 200,
                "raise_for_status": lambda self: None,
                "json": lambda self: {
                    "usage": {"input_tokens": 4, "output_tokens": 2},
                    "output": [
                        {
                            "content": [
                                {
                                    "type": "output_text",
                                    "text": '{"advertisements":',
                                },
                                {"type": "text", "text": "[]}"},
                            ]
                        }
                    ],
                },
            },
        )(),
    ]
    sleeps = []
    requests = []

    def fake_post(*args, **kwargs):
        requests.append((args, kwargs))
        return responses.pop(0)

    monkeypatch.setattr(run50.httpx, "post", fake_post)
    client = ResponsesClient("test-key", sleep=sleeps.append)
    image = Image.new("RGB", (2400, 1200), "white")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    parsed, raw = client.ask("prompt", buffer.getvalue(), 2000)

    assert parsed == {"advertisements": []}
    assert raw["usage"] == {"input_tokens": 4, "output_tokens": 2}
    assert sleeps == [1]
    assert len(requests) == 2
    payload = requests[1][1]["json"]
    assert payload["input"][0]["content"][0] == {
        "type": "input_text",
        "text": "prompt",
    }
    assert payload["input"][0]["content"][1]["detail"] == "high"


def test_stateless_run50_returns_provenance_and_order_form_skips_client(monkeypatch):
    storage = FakeStorage()
    rect = (40, 60, 560, 600)
    pdf = _pdf([{"ads": [rect]}])
    page = _rendered_page(pdf)
    client = FakeClient(
        [{"advertisements": [_detector_ad(rect)]}],
        [_verdict("Stateless Kunde GmbH")],
    )
    monkeypatch.setattr(stateless, "storage", storage)
    monkeypatch.setattr(stateless, "render_and_extract", lambda _pdf: [page])
    monkeypatch.setattr(stateless, "ResponsesClient", lambda _key: client)
    monkeypatch.setattr(settings, "ad_detector", "run50", raising=False)
    monkeypatch.setattr(settings, "openai_api_key", "test-key")

    response = stateless.process_upload(
        file=type("Upload", (), {"file": io.BytesIO(pdf)})(),
        output_prefix="tenants/test",
        _token=None,
    )
    body = json.loads(response.body)
    result_page = body["pages"][0]

    assert result_page["detector"] == "run50"
    assert result_page["occurrences"][0]["run50"]["model"] == "gpt-5.1"
    assert result_page["occurrences"][0]["company"] == "Stateless Kunde GmbH"
    assert result_page["occurrences"][0]["bbox"]["x"] == pytest.approx(
        result_page["occurrences"][0]["run50"]["detector_ad"]["bbox"][0] / 100
    )
    assert result_page["image_key"] == "tenants/test/page-0001.png"

    order_text = "Anzeigenauftrag\nFirma: Muster GmbH\nTel.: 01234 567890"
    order_page = {
        **page,
        "text": order_text,
        "classification": "MIXED_CONTENT",
    }
    unused_client = FakeClient()
    monkeypatch.setattr(stateless, "render_and_extract", lambda _pdf: [order_page])
    monkeypatch.setattr(stateless, "ResponsesClient", lambda _key: unused_client)
    order_response = stateless.process_upload(
        file=type("Upload", (), {"file": io.BytesIO(pdf)})(),
        output_prefix="tenants/order",
        _token=None,
    )
    order_result = json.loads(order_response.body)["pages"][0]
    assert order_result["classification"] == "ORDER_FORM"
    assert order_result["occurrences"] == []
    assert order_result["detector"] == "run50"
    assert unused_client.calls == []


def test_stateless_run50_requires_openai_key(monkeypatch):
    monkeypatch.setattr(settings, "ad_detector", "run50", raising=False)
    monkeypatch.setattr(settings, "openai_api_key", None)
    pdf = _pdf([{"ads": []}])
    response = TestClient(app).post(
        "/api/v1/process",
        headers={"x-service-token": settings.service_token},
        files={"file": ("document.pdf", pdf, "application/pdf")},
        data={"output_prefix": "tenants/missing-key"},
    )

    assert response.status_code == 500
    assert "OPENAI_API_KEY" in response.json()["detail"]
