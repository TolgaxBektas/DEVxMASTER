from PIL import Image, ImageChops, ImageDraw

from app.services import extra_lines
from app.services.extra_lines import compose_extra_lines


def _anchor(left=20, top=40, right=180, bottom=50):
    return {
        "text": "Telefon 06441 12345",
        "heights": [("Telefon", 10), ("06441", 10)],
        "left": left,
        "top": top,
        "right": right,
        "bottom": bottom,
    }


def test_composes_measured_lines_into_uniform_contact_bar(monkeypatch):
    image = Image.new("RGB", (200, 100), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 40, 199, 99), fill=(20, 80, 140))
    draw.rectangle((20, 40, 179, 49), fill="white")
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: _anchor())

    result = compose_extra_lines(image, ["Fax 06441 9876"])

    assert result.manifest["status"] == "composed"
    assert result.manifest["placement"] == "contact_bar"
    assert result.manifest["background"] == [20, 80, 140]
    assert result.manifest["text_colour"] == [255, 255, 255]
    assert result.manifest["font_size"] > 0
    assert result.manifest["lines"] == ["Fax 06441 9876"]
    assert result.image.height > image.height
    assert result.image.crop((0, 0, image.width, image.height // 2)) == image.crop(
        (0, 0, image.width, image.height // 2)
    )


def test_appends_strip_when_no_uniform_contact_bar_exists(monkeypatch):
    image = Image.new("RGB", (200, 100), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((20, 40, 179, 49), fill="black")
    draw.rectangle((0, 50, 199, 99), fill=(230, 230, 230))
    draw.point((20, 50), fill=(0, 0, 0))
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: _anchor())

    result = compose_extra_lines(image, ["www.facebook.com/example"])

    assert result.manifest["placement"] == "appended_strip"
    assert result.manifest["centred"] is True
    assert result.manifest["background"] == [230, 230, 230]
    assert result.image.height > image.height


def test_fails_closed_without_contact_line(monkeypatch):
    image = Image.new("RGB", (120, 80), (12, 34, 56))
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: None)

    result = compose_extra_lines(image, ["Fax 123"])

    assert result.manifest == {
        "status": "skipped",
        "reason": "no_contact_line",
        "lines": ["Fax 123"],
    }
    assert ImageChops.difference(result.image, image).getbbox() is None


def test_original_upper_half_remains_pixel_identical(monkeypatch):
    image = Image.new("RGB", (200, 120), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 50, 199, 119), fill=(30, 60, 90))
    draw.rectangle((20, 50, 179, 59), fill="white")
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: _anchor(bottom=60))

    result = compose_extra_lines(image, ["Instagram example"])

    upper = (0, 0, image.width, image.height // 2)
    assert (
        ImageChops.difference(result.image.crop(upper), image.crop(upper)).getbbox()
        is None
    )
