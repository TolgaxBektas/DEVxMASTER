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
    image = Image.new("RGB", (200, 70), "white")
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


def test_groups_blocks_and_keeps_social_profiles_stacked(monkeypatch):
    image = Image.new("RGB", (500, 120), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 40, 499, 119), fill=(20, 80, 140))
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: _anchor(right=480))

    result = compose_extra_lines(
        image,
        [
            ("phone", "06441 12345"),
            ("fax", "06441 98765"),
            ("email", "info@example.de"),
            ("website", "www.example.de"),
            ("facebook", "www.facebook.com/example"),
            ("instagram", "www.instagram.com/example"),
        ],
    )

    blocks = result.manifest["blocks"]
    assert [block["name"] for block in blocks] == ["phone", "email_web", "social"]
    assert len(blocks[0]["rows"]) == 1
    assert len(blocks[1]["rows"]) == 1
    assert len(blocks[2]["rows"]) == 2
    assert all(row["logo_used"] for row in blocks[2]["rows"])
    assert blocks[2]["top"] - (
        blocks[1]["top"] + result.manifest["line_height"]
    ) == result.manifest["block_gap"]


def test_phone_and_fax_stack_when_the_available_width_is_too_small(monkeypatch):
    image = Image.new("RGB", (120, 100), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 40, 119, 99), fill=(20, 80, 140))
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: _anchor(right=100))

    result = compose_extra_lines(
        image,
        [
            ("phone", "06441 555555555"),
            ("fax", "06441 987654321"),
        ],
    )

    assert result.manifest["status"] in {"composed", "skipped"}
    assert len(result.manifest["blocks"][0]["rows"]) == 2
    assert all(row["width"] <= 120 - 2 * max(5, result.manifest["cap_height"]) for row in result.manifest["blocks"][0]["rows"])


def test_long_value_is_fit_within_image_bounds(monkeypatch):
    image = Image.new("RGB", (100, 80), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 30, 99, 79), fill=(30, 60, 90))
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: _anchor(right=90, bottom=40))

    result = compose_extra_lines(
        image, [("website", "www.example.de/this-is-a-very-long-address")]
    )

    if result.manifest["status"] == "composed":
        margin = max(round(image.width * 0.04), result.manifest["cap_height"])
        assert all(
            margin <= row["position"][0]
            and row["position"][0] + row["width"] <= image.width - margin
            for block in result.manifest["blocks"]
            for row in block["rows"]
        )


def test_anchor_at_bottom_fails_closed_or_composes_without_crashing(monkeypatch):
    image = Image.new("RGB", (160, 50), "white")
    monkeypatch.setattr(
        extra_lines, "_anchor", lambda _image: _anchor(top=40, bottom=50, right=150)
    )

    result = compose_extra_lines(image, [("fax", "06441 12345")])

    assert result.manifest["status"] in {"composed", "skipped"}


def test_missing_font_fails_closed(monkeypatch):
    image = Image.new("RGB", (200, 100), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 40, 199, 99), fill=(20, 80, 140))
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: _anchor())
    monkeypatch.setattr(extra_lines, "_font_path", lambda _bold: None)

    result = compose_extra_lines(image, [("fax", "06441 9876")])

    assert result.manifest["status"] == "skipped"
    assert result.manifest["reason"] == "font_not_found"
    assert ImageChops.difference(result.image, image).getbbox() is None


def test_rejects_domain_already_present_with_normalized_spelling(monkeypatch):
    image = Image.new("RGB", (220, 100), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 40, 219, 99), fill=(230, 230, 230))
    anchor = _anchor()
    anchor["ocr_lines"] = [
        {
            "text": "www.haack-immobilien-wetzlar.de",
            "heights": [("www.haack-immobilien-wetzlar.de", 10)],
            "left": 20,
            "top": 40,
            "right": 200,
            "bottom": 50,
        }
    ]
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)

    result = compose_extra_lines(
        image, [("website", "https://haack-immobilien-wetzlar.de")]
    )

    assert result.manifest["status"] == "skipped"
    assert result.manifest["reason"] == "all_lines_already_present"
    assert result.manifest["discarded"] == [
        {
            "channel": "website",
            "value": "https://haack-immobilien-wetzlar.de",
            "reason": "already_present",
        }
    ]
    assert ImageChops.difference(result.image, image).getbbox() is None


def test_rejects_fax_with_different_separators(monkeypatch):
    image = Image.new("RGB", (220, 100), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 40, 219, 99), fill=(230, 230, 230))
    anchor = _anchor()
    anchor["ocr_lines"] = [{**anchor, "text": "Fax 06441-905-15"}]
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)

    result = compose_extra_lines(image, [("fax", "06441 / 905 15")])

    assert result.manifest["status"] == "skipped"
    assert result.manifest["discarded"][0]["reason"] == "already_present"


def test_appended_strip_is_near_content_not_bottom_margin(monkeypatch):
    image = Image.new("RGB", (220, 220), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((20, 40, 199, 80), fill=(20, 80, 140))
    anchor = _anchor(bottom=50)
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)

    result = compose_extra_lines(image, [("fax", "06441 9876")])

    assert result.manifest["placement"] == "appended_strip"
    assert result.manifest["band_end"] < image.height
    assert result.manifest["band_end"] - result.manifest["line_height"] <= 81
    assert result.manifest["grew"] is False
    assert result.image.height == image.height
    added = result.image.height - image.height
    assert result.image.getpixel((0, image.height - 1 + added)) == image.getpixel(
        (0, image.height - 1)
    )


def test_band_ocr_rejects_value_read_only_from_content_band(monkeypatch):
    image = Image.new("RGB", (240, 100), "white")
    ImageDraw.Draw(image).rectangle((0, 40, 239, 59), fill=(40, 40, 40))

    def band_lines(candidate, *, config="", offset=(0, 0)):
        if config != "--psm 6":
            return []
        return [
            {
                "text": "www.example.de",
                "heights": [("www.example.de", 10)],
                "left": 20 + offset[0],
                "top": 44 + offset[1],
                "right": 170 + offset[0],
                "bottom": 54 + offset[1],
            }
        ]

    monkeypatch.setattr(extra_lines, "_lines", band_lines)

    result = compose_extra_lines(image, [("website", "https://www.example.de")])

    assert result.manifest["status"] == "skipped"
    assert result.manifest["reason"] == "all_lines_already_present"
    assert result.manifest["discarded"][0]["reason"] == "already_present"
    assert result.manifest["ocr"]["bands_used"] == 1


def test_digits_are_compared_as_contained_sequence(monkeypatch):
    image = Image.new("RGB", (240, 100), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 40, 239, 99), fill=(230, 230, 230))
    anchor = _anchor()
    anchor["ocr_lines"] = [{**anchor, "text": "Straße 12 | 35578 Wetzlar | Telefon 06441 / 905-11"}]
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)

    result = compose_extra_lines(image, [("fax", "06441-905-11")])

    assert result.manifest["status"] == "skipped"
    assert result.manifest["discarded"][0]["reason"] == "already_present"


def test_short_postal_or_house_number_does_not_count_as_duplicate(monkeypatch):
    image = Image.new("RGB", (240, 100), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 40, 239, 99), fill=(230, 230, 230))
    anchor = _anchor()
    anchor["ocr_lines"] = [{**anchor, "text": "Straße 12 | 35578 Wetzlar"}]
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)

    result = compose_extra_lines(image, [("fax", "35578")])

    assert result.manifest["status"] == "composed"
    assert result.manifest.get("discarded", []) == []


def test_reference_height_uses_all_contact_lines_not_only_anchor(monkeypatch):
    image = Image.new("RGB", (500, 160), "white")
    ImageDraw.Draw(image).rectangle((0, 40, 499, 159), fill=(20, 80, 140))
    anchor = _anchor(bottom=60)
    anchor["ocr_lines"] = [
        {**anchor, "text": "Telefon 06441 12345", "heights": [("Telefon", 10), ("06441", 10)]},
        {
            **anchor,
            "text": "www.example.de",
            "heights": [("www.example.de", 60)],
            "top": 70,
            "bottom": 130,
        },
    ]
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)

    result = compose_extra_lines(image, [("fax", "06441 9876")])

    assert result.manifest["status"] == "composed"
    assert result.manifest["anchor_height"] == 10
    assert result.manifest["reference_height"] == 10
    assert result.manifest["cap_height"] == 10


def test_appended_lines_reuse_sufficient_lower_margin_without_growth(monkeypatch):
    image = Image.new("RGB", (220, 140), "white")
    ImageDraw.Draw(image).rectangle((20, 40, 199, 60), fill=(20, 80, 140))
    anchor = _anchor(bottom=60)
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)

    result = compose_extra_lines(image, [("fax", "06441 9876")])

    assert result.manifest["placement"] == "appended_strip"
    assert result.manifest["grew"] is False
    assert result.image.size == image.size
    assert result.manifest["insertion_gap"] == result.manifest["line_height"] // 2
    assert ImageChops.difference(
        result.image.crop((0, 0, image.width, result.manifest["band_end"])),
        image.crop((0, 0, image.width, result.manifest["band_end"])),
    ).getbbox() is None


def test_appended_lines_grow_only_for_missing_height(monkeypatch):
    image = Image.new("RGB", (220, 80), "white")
    ImageDraw.Draw(image).rectangle((20, 40, 199, 60), fill=(20, 80, 140))
    anchor = _anchor(bottom=60)
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)

    result = compose_extra_lines(image, [("fax", "06441 9876")])

    assert result.manifest["placement"] == "appended_strip"
    assert result.manifest["grew"] is True
    assert result.image.width == image.width
    assert result.image.height > image.height
    assert result.manifest["band_end"] - result.manifest["content_end"] == (
        result.manifest["line_height"] // 2
    )


def test_font_size_matches_height_probe_when_width_is_available(monkeypatch):
    image = Image.new("RGB", (600, 140), "white")
    ImageDraw.Draw(image).rectangle((0, 40, 599, 139), fill=(20, 80, 140))
    anchor = _anchor(left=80, right=520)
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)

    result = compose_extra_lines(image, [("fax", "06441 9876")])

    assert result.manifest["status"] == "composed"
    probe = extra_lines._fit_font(
        "X", result.manifest["cap_height"], result.manifest["bold"]
    )
    assert probe is not None
    assert result.manifest["font_size"] == probe.size


def test_long_value_uses_smaller_font_and_stays_within_margins(monkeypatch):
    image = Image.new("RGB", (180, 120), "white")
    ImageDraw.Draw(image).rectangle((0, 40, 179, 119), fill=(20, 80, 140))
    anchor = _anchor(left=25, right=155)
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)

    result = compose_extra_lines(
        image,
        [("website", "www.example.de/a-very-long-address-that-needs-fitting")],
    )

    assert result.manifest["status"] == "composed"
    probe = extra_lines._fit_font(
        "X", result.manifest["cap_height"], result.manifest["bold"]
    )
    assert probe is not None
    assert result.manifest["font_size"] < probe.size
    margin = max(round(image.width * 0.04), result.manifest["cap_height"])
    assert all(
        margin <= row["position"][0]
        and row["position"][0] + row["width"] <= image.width - margin
        for block in result.manifest["blocks"]
        for row in block["rows"]
    )


def test_right_aligned_anchor_shrinks_social_line_inside_right_margin(monkeypatch):
    image = Image.new("RGB", (240, 140), "white")
    ImageDraw.Draw(image).rectangle((0, 40, 239, 139), fill=(20, 80, 140))
    anchor = _anchor(left=230, right=239)
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)

    result = compose_extra_lines(
        image,
        [("instagram", "www.instagram.com/a-very-long-profile-name")],
    )

    assert result.manifest["status"] == "composed"
    margin = max(round(image.width * 0.04), result.manifest["cap_height"])
    for block in result.manifest["blocks"]:
        for row in block["rows"]:
            assert margin <= row["position"][0]
            assert row["position"][0] + row["width"] <= image.width - margin
    assert any(block["shifted"] for block in result.manifest["blocks"])
