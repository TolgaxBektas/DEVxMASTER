import pikepdf
from PIL import Image
from types import SimpleNamespace

from app.services import qr_objects
from app.services.pipeline import Pipeline


def _pdf_with_images(tmp_path, count=1):
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(100, 100))
    resources = pikepdf.Dictionary()
    xobjects = pikepdf.Dictionary()
    for index in range(count):
        image = pdf.make_stream(b"\x00")
        image["/Type"] = pikepdf.Name("/XObject")
        image["/Subtype"] = pikepdf.Name("/Image")
        image["/Width"] = 1
        image["/Height"] = 1
        image["/ColorSpace"] = pikepdf.Name("/DeviceGray")
        image["/BitsPerComponent"] = 8
        name = pikepdf.Name(f"/Im{index}")
        xobjects[name] = image
    resources["/XObject"] = xobjects
    page["/Resources"] = resources
    operators = "\n".join(
        f"q 20 0 0 20 {10 + index * 30} 10 cm /Im{index} Do Q"
        for index in range(count)
    )
    page["/Contents"] = pdf.make_stream(operators.encode())
    path = tmp_path / "source.pdf"
    pdf.save(path)
    return path


def test_remove_confirmed_qr_removes_only_unique_matching_image(tmp_path, monkeypatch):
    source = _pdf_with_images(tmp_path)
    cleaned = tmp_path / "cleaned.pdf"
    monkeypatch.setattr(
        qr_objects,
        "_image_payloads",
        lambda _image: {"https://example.de"},
    )

    result = qr_objects.remove_confirmed_qr(
        source,
        cleaned,
        1,
        ["https://example.de"],
        {"left": 10, "bottom": 10, "right": 30, "top": 30},
    )

    assert result is not None
    with pikepdf.Pdf.open(cleaned) as pdf:
        assert [
            str(operator)
            for _, operator in pikepdf.parse_content_stream(pdf.pages[0])
        ] == ["q", "cm", "Q"]


def test_remove_confirmed_qr_fails_closed_for_ambiguous_images(
    tmp_path, monkeypatch
):
    source = _pdf_with_images(tmp_path, count=2)
    cleaned = tmp_path / "cleaned.pdf"
    monkeypatch.setattr(
        qr_objects,
        "_image_payloads",
        lambda _image: {"https://example.de"},
    )

    result = qr_objects.remove_confirmed_qr(
        source,
        cleaned,
        1,
        ["https://example.de"],
        {"left": 0, "bottom": 0, "right": 100, "top": 100},
    )

    assert result is None
    assert not cleaned.exists()


def test_pipeline_ignores_heuristic_without_decoder_confirmation(
    tmp_path, monkeypatch
):
    artwork = tmp_path / "artwork.png"
    Image.new("RGB", (40, 40), "white").save(artwork)
    pipeline = Pipeline(None, None, None, local_work_dir=tmp_path)
    monkeypatch.setattr(
        "app.services.pipeline.extract_content_anchors",
        lambda *_args, **_kwargs: {
            "qr_present": False,
            "qr_presence_score": 0.99,
            "qr_detection": "available",
            "qr_codes": [],
            "qr_region": None,
        },
    )

    assert (
        pipeline._prepare_qr_removal(
            tmp_path / "source.pdf",
            "digest",
            SimpleNamespace(id=1),
            1,
            None,
            artwork,
            None,
        )
        is None
    )
