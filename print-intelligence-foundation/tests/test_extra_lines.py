from PIL import Image, ImageChops, ImageDraw, ImageFont

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


def test_social_brand_substrings_remain_plain_websites():
    values = extra_lines._contact_values("boxing.de mixing.de")

    assert values == [("website", "boxing.de"), ("website", "mixing.de")]
    assert extra_lines._channel_value("boxing.de")[0] == "website"
    assert extra_lines._channel_value("mixing.de")[0] == "website"


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
    assert len(blocks[2]["rows"]) == 1
    assert all(row["logo_used"] for row in blocks[2]["rows"])
    assert blocks[2]["top"] - (
        blocks[1]["top"] + result.manifest["line_height"]
    ) == result.manifest["block_gap"]


def test_alignment_is_inherited_for_left_right_and_centred_contacts(monkeypatch):
    image = Image.new("RGB", (600, 180), (20, 80, 140))
    values = [("website", "example.de"), ("facebook", "facebook.com/acme")]
    for expected in ("left", "right", "centred"):
        anchor = {**_anchor(left=40, right=180), "alignment": expected}
        monkeypatch.setattr(extra_lines, "_anchor", lambda _image, anchor=anchor: anchor)
        result = compose_extra_lines(image, values)
        assert result.manifest["alignment"] == expected
        rows = [row for block in result.manifest["blocks"] for row in block["rows"]]
        if expected == "centred":
            frame_center = 110
            assert all(
                abs(row["position"][0] + row["width"] / 2 - frame_center) <= 1
                for row in rows
            )
        elif expected == "right":
            frame_right = result.manifest["content_bounds"][1]
            assert all(
                row["position"][0] + row["width"] <= frame_right
                for row in rows
            )
            ends = [row["position"][0] + row["width"] for row in rows]
            assert max(ends) - min(ends) <= 1
        else:
            assert len({row["position"][0] for row in rows}) == 1


def test_alignment_uses_contact_column_reference_edges(monkeypatch):
    image = Image.new("RGB", (700, 180), (20, 80, 140))
    values = [("website", "example.de"), ("facebook", "facebook.com/acme")]
    cases = [
        ("left", {"left": 170, "right": 300, "alignment_left": 170}, "left"),
        ("right", {"left": 400, "right": 530, "alignment_right": 530}, "right"),
        ("centred", {"left": 280, "right": 420}, "centred"),
    ]
    for expected, geometry, mode in cases:
        alignment_fields = {
            key: geometry.pop(key)
            for key in ("alignment_left", "alignment_right")
            if key in geometry
        }
        anchor = {
            **_anchor(**geometry),
            **alignment_fields,
            "alignment": expected,
        }
        monkeypatch.setattr(extra_lines, "_anchor", lambda _image, anchor=anchor: anchor)
        result = compose_extra_lines(image, values)
        rows = [row for block in result.manifest["blocks"] for row in block["rows"]]
        assert result.manifest["alignment"] == expected
        if mode == "left":
            assert all(row["position"][0] == 170 for row in rows)
        elif mode == "right":
            assert all(abs(row["position"][0] + row["width"] - 530) <= 1 for row in rows)
        else:
            assert all(
                abs(row["position"][0] + row["width"] / 2 - 350) <= 1
                for row in rows
            )


def test_pairing_and_social_packing_use_available_width():
    image = Image.new("RGB", (1000, 100), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(extra_lines._font_path(False), 20)
    values = [
        ("phone", "06441 12345"),
        ("fax", "06441 98765"),
        ("email", "info@example.de"),
        ("website", "example.de"),
        ("facebook", "facebook.com/a"),
        ("instagram", "instagram.com/a"),
        ("linkedin", "linkedin.com/a"),
    ]

    wide = extra_lines._group_lines(values, draw, font, 20, 600)
    assert len(wide[0]["rows"][0]["parts"]) == 2
    assert len(wide[1]["rows"][0]["parts"]) == 2
    assert len(wide[2]["rows"]) == 1
    assert all(part["logo_used"] for part in wide[2]["rows"][0]["parts"])

    barely_wide = extra_lines._group_lines(
        [item for item in values if item[0] not in {"phone", "fax", "email", "website"}],
        draw,
        font,
        20,
        560,
    )
    assert len(barely_wide[0]["rows"]) == 1
    assert {part["font"].size for part in barely_wide[0]["rows"][0]["parts"]} == {18}

    narrow = extra_lines._group_lines(
        [item for item in values if item[0] not in {"phone", "fax", "email", "website"}],
        draw,
        font,
        20,
        300,
    )
    assert len(narrow[0]["rows"]) == 3
    assert all(part["font"].size == 20 for row in narrow[0]["rows"] for part in row["parts"])


def test_tiny_social_font_stacks_without_constructing_zero_size_font():
    image = Image.new("RGB", (100, 40), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(extra_lines._font_path(False), 1)
    values = [
        ("facebook", "facebook.com/a"),
        ("instagram", "instagram.com/a"),
        ("linkedin", "linkedin.com/a"),
    ]

    blocks = extra_lines._group_lines(values, draw, font, 1, 1)

    assert len(blocks[0]["rows"]) == 3


def test_phone_and_fax_use_short_labels_and_preserve_number_text(monkeypatch):
    image = Image.new("RGB", (600, 120), "white")
    ImageDraw.Draw(image).rectangle((0, 40, 599, 119), fill=(20, 80, 140))
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: _anchor(right=580))

    result = compose_extra_lines(
        image,
        [("phone", "Telefon: 06441 / 905-15"), ("fax", "Fax - 06441 / 905-16")],
    )

    row = result.manifest["blocks"][0]["rows"][0]
    assert [part["display_value"] for part in row["parts"]] == [
        "T 06441 / 905-15",
        "F 06441 / 905-16",
    ]


def test_existing_phone_leaves_only_labeled_fax(monkeypatch):
    image = Image.new("RGB", (400, 120), "white")
    ImageDraw.Draw(image).rectangle((0, 40, 399, 119), fill=(20, 80, 140))
    anchor = _anchor(right=380)
    anchor["ocr_lines"] = [{**anchor, "text": "Telefon 06441 / 905-15"}]
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)

    result = compose_extra_lines(
        image,
        [("phone", "06441 / 905-15"), ("fax", "06441 / 905-16")],
    )

    assert [part["display_value"] for part in result.manifest["blocks"][0]["rows"][0]["parts"]] == [
        "F 06441 / 905-16"
    ]


def test_all_communication_rows_are_individually_centered_with_social_logo(
    monkeypatch,
):
    image = Image.new("RGB", (600, 160), "white")
    ImageDraw.Draw(image).rectangle((0, 40, 599, 159), fill=(20, 80, 140))
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: _anchor(right=580))

    result = compose_extra_lines(
        image,
        [
            ("phone", "06441 12345"),
            ("fax", "06441 98765"),
            ("email", "info@example.de"),
            ("website", "www.example.de"),
            ("instagram", "www.instagram.com/example"),
        ],
    )

    rows = [row for block in result.manifest["blocks"] for row in block["rows"]]
    content_left, content_right = result.manifest["content_bounds"]
    frame_center = (content_left + content_right) / 2
    assert result.manifest["alignment"] == "centred"
    for row in rows:
        assert abs(row["position"][0] + row["width"] / 2 - frame_center) <= 1
    social_part = result.manifest["blocks"][-1]["rows"][0]["parts"][0]
    assert social_part["display_value"] == "instagram.com/example"
    assert social_part["logo_size"][1] > result.manifest["cap_height"]
    logo_y = social_part["logo_position"][1]
    text_bbox = ImageFont.truetype(
        extra_lines._font_path(result.manifest["bold"]),
        result.manifest["font_size"],
    ).getbbox(social_part["display_value"])
    text_center = social_part["position"][1] + (text_bbox[1] + text_bbox[3]) / 2
    logo_center = logo_y + social_part["logo_size"][1] / 2
    assert abs(logo_center - text_center) <= 1


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


def test_all_supported_social_channels_are_detected_and_display_stripped():
    text = (
        "facebook.com/acme instagram.com/acme linkedin.com/acme "
        "youtube.com/@acme tiktok.com/@acme xing.com/profile"
    )
    values = extra_lines._contact_values(text)

    assert [channel for channel, _value in values] == [
        "facebook",
        "instagram",
        "linkedin",
        "youtube",
        "tiktok",
        "xing",
    ]
    assert extra_lines._display_value("linkedin", "https://www.linkedin.com/acme") == (
        "linkedin.com/acme"
    )
    assert extra_lines._display_value("youtube", "www.youtube.com/@acme") == (
        "youtube.com/@acme"
    )
    assert extra_lines._display_value("tiktok", "https://tiktok.com/@acme") == (
        "tiktok.com/@acme"
    )
    assert extra_lines._display_value("xing", "www.xing.com/profile") == (
        "xing.com/profile"
    )


def test_block_reset_rows_are_centered_individually(monkeypatch):
    image = Image.new("RGB", (600, 180), (20, 80, 140))
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(extra_lines._font_path(False), 10)
    draw.text((30, 40), "Telefon 06441 12345", font=font, fill="white")
    draw.text((30, 55), "E-Mail info@example.de", font=font, fill="white")
    anchor = _reset_anchor()
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)
    monkeypatch.setattr(extra_lines, "_content_bounds", lambda *_args: (0, 600))

    result = compose_extra_lines(
        image,
        [
            ("fax", "06441 98765"),
            ("website", "example.de"),
            ("linkedin", "linkedin.com/acme"),
            ("youtube", "youtube.com/@acme"),
        ],
    )

    assert result.manifest["mode"] == "block_reset"
    assert result.manifest["alignment"] == "centred"
    frame_center = 275
    content_left, content_right = result.manifest["content_bounds"]
    for block in result.manifest["blocks"]:
        for row in block["rows"]:
            assert abs(row["position"][0] + row["width"] / 2 - frame_center) <= 1
            assert row["position"][0] >= content_left
            assert row["position"][0] + row["width"] <= content_right
    assert all(
        part["logo_used"]
        for row in result.manifest["blocks"][-1]["rows"]
        for part in row["parts"]
    )


def test_reset_preserves_phone_and_fax_with_identical_digits(monkeypatch):
    image = Image.new("RGB", (600, 180), (20, 80, 140))
    segment = {
        "text": "Telefon 06441 12345 / Fax 06441 12345",
        "left": 30,
        "top": 40,
        "right": 520,
        "bottom": 55,
    }
    reset = {
        "segments": [segment],
        "values": [
            ("phone", "06441 12345"),
            ("fax", "06441 12345"),
        ],
        "left": 30,
        "top": 40,
        "right": 520,
        "bottom": 55,
    }
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: _anchor())
    monkeypatch.setattr(extra_lines, "_reset_block", lambda _anchor: reset)
    monkeypatch.setattr(extra_lines, "_content_bounds", lambda *_args: (0, 600))
    monkeypatch.setattr(extra_lines, "_inline_fax_area", lambda *_args: None)

    result = compose_extra_lines(image, [("fax", "06441 98765")])

    assert result.manifest["mode"] == "block_reset"
    phone_rows = result.manifest["blocks"][0]["rows"]
    assert [
        (part["channel"], part["value"])
        for row in phone_rows
        for part in row["parts"]
    ][:2] == [
        ("phone", "06441 12345"),
        ("fax", "06441 12345"),
    ]
    assert {
        (item["channel"], item["value"])
        for item in result.manifest["removed_communication_values"]
    } == {
        ("phone", "06441 12345"),
        ("fax", "06441 12345"),
    }


def test_reset_falls_back_when_erased_value_guard_reports_missing(monkeypatch):
    image = Image.new("RGB", (600, 140), (20, 80, 140))
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(extra_lines._font_path(False), 10)
    draw.text((30, 40), "Telefon 06441 12345", font=font, fill="white")
    before = image.copy()
    anchor = _reset_anchor()
    reset = {
        "segments": anchor["contact_segments"],
        "values": [("phone", "06441 12345")],
        "left": 30,
        "top": 40,
        "right": 520,
        "bottom": 65,
    }
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)
    monkeypatch.setattr(extra_lines, "_reset_block", lambda _anchor: reset)
    original_group_lines = extra_lines._group_lines
    monkeypatch.setattr(
        extra_lines,
        "_group_lines",
        lambda values, *args: original_group_lines(
            [item for item in values if item[0] != "phone"],
            *args,
        ),
    )

    result = compose_extra_lines(image, [("fax", "06441 98765")])

    assert result.manifest["mode"] == "append"
    assert result.manifest["placement"] == "appended_strip"
    assert result.manifest["block_reset_skipped_reason"] == (
        "removed_value_not_preserved"
    )
    assert (
        ImageChops.difference(
            result.image.crop((0, 0, image.width, 70)),
            before.crop((0, 0, image.width, 70)),
        ).getbbox()
        is None
    )
    assert all(
        block["top"] >= anchor["bottom"]
        for block in result.manifest["blocks"]
    )


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


def test_whole_image_anchor_controls_alignment_while_band_detects_duplicate(
    monkeypatch,
):
    image = Image.new("RGB", (400, 140), "white")
    ImageDraw.Draw(image).rectangle((0, 40, 399, 139), fill=(20, 80, 140))
    whole = {
        **_anchor(left=100, right=220),
        "text": "Telefon 06441 12345",
        "ocr_source": "whole_image",
    }
    band = {
        **_anchor(left=20, right=180),
        "text": "www.example.de",
        "ocr_source": "band",
    }
    monkeypatch.setattr(
        extra_lines,
        "_ocr_lines",
        lambda _image: ([whole, band], {"bands_used": 1}),
    )

    result = compose_extra_lines(
        image,
        [("website", "www.example.de"), ("fax", "06441 9876")],
    )

    assert result.manifest["status"] == "composed"
    assert result.manifest["anchor_box"][0] == 100
    assert result.manifest["discarded"][0]["reason"] == "already_present"
    row = result.manifest["blocks"][0]["rows"][0]
    content_left, content_right = result.manifest["content_bounds"]
    assert result.manifest["alignment"] == "left"
    assert row["position"][0] >= content_left
    assert row["position"][0] + row["width"] <= content_right


def test_split_contact_segments_ignore_right_hand_logo_for_alignment(monkeypatch):
    image = Image.new("RGB", (600, 180), "white")
    ImageDraw.Draw(image).rectangle((0, 40, 599, 179), fill=(20, 80, 140))
    lines = [
        {
            "text": "06441 42071 MÖBEL SCHMIDT",
            "left": 355,
            "top": 80,
            "right": 560,
            "bottom": 95,
            "ocr_source": "whole_image",
            "words": [
                {"text": "06441", "left": 355, "top": 80, "right": 385, "bottom": 95, "height": 15},
                {"text": "42071", "left": 390, "top": 80, "right": 425, "bottom": 95, "height": 15},
                {"text": "MÖBEL", "left": 500, "top": 80, "right": 535, "bottom": 95, "height": 15},
                {"text": "SCHMIDT", "left": 540, "top": 80, "right": 600, "bottom": 95, "height": 15},
            ],
        },
        {
            "text": "Hintergasse 13 35576 Wetzlar",
            "left": 355,
            "top": 100,
            "right": 500,
            "bottom": 115,
            "ocr_source": "whole_image",
            "words": [
                {"text": "Hintergasse", "left": 355, "top": 100, "right": 420, "bottom": 115, "height": 15},
                {"text": "13", "left": 425, "top": 100, "right": 440, "bottom": 115, "height": 15},
                {"text": "35576", "left": 445, "top": 100, "right": 480, "bottom": 115, "height": 15},
                {"text": "Wetzlar", "left": 485, "top": 100, "right": 530, "bottom": 115, "height": 15},
            ],
        },
    ]
    monkeypatch.setattr(
        extra_lines,
        "_ocr_lines",
        lambda _image: (lines, {"bands_used": 0}),
    )

    result = compose_extra_lines(image, [("fax", "06441 9876")])

    assert result.manifest["status"] == "composed"
    assert result.manifest["centred"] is False
    assert result.manifest["alignment"] == "left"
    assert result.manifest["anchor_box"][0] == 355
    assert result.manifest["fax_inline"] is True
    assert result.manifest["fax_inline_target"]["box"][0] == 355


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


def test_postal_and_house_numbers_are_not_phone_values():
    assert extra_lines._contact_values("Hintergasse 13 | 35576 Wetzlar") == []


def test_inline_fax_rejects_when_rendered_text_does_not_fit(monkeypatch):
    image = Image.new("RGB", (260, 120), (20, 80, 140))
    anchor = _anchor(left=30, right=80, bottom=55)
    anchor["contact_segments"] = [
        {
            "text": "06441 42071 | schmidt.example.de",
            "left": 30,
            "top": 40,
            "right": 80,
            "bottom": 55,
            "ocr_source": "whole_image",
            "confidence": 95,
        }
    ]
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)
    monkeypatch.setattr(extra_lines, "_reset_block", lambda _anchor: None)
    monkeypatch.setattr(extra_lines, "_content_bounds", lambda *_args: (0, 260))
    monkeypatch.setattr(
        extra_lines,
        "_inline_fax_area",
        lambda *_args: (90, 105, 40, (20, 80, 140)),
    )

    result = compose_extra_lines(image, [("fax", "06441 987654321")])

    assert result.manifest["fax_inline"] is False
    assert result.manifest["fax_inline_reason"] == "rendered_text_does_not_fit"


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

    assert result.manifest["status"] == "skipped"
    assert result.manifest["reason"] == "font_below_readability_threshold"
    assert result.image.tobytes() == image.tobytes()
    assert result.manifest["font_minimum_scale"] == (
        extra_lines.FONT_MINIMUM_SCALE
    )


def test_right_aligned_anchor_shrinks_social_line_inside_right_margin(monkeypatch):
    image = Image.new("RGB", (500, 140), "white")
    ImageDraw.Draw(image).rectangle((0, 40, 499, 139), fill=(20, 80, 140))
    anchor = _anchor(left=440, right=490)
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)

    result = compose_extra_lines(
        image,
        [("instagram", "instagram.com/profile")],
    )

    assert result.manifest["status"] == "composed"
    probe = extra_lines._fit_font(
        "X", result.manifest["cap_height"], result.manifest["bold"]
    )
    assert probe is not None
    assert result.manifest["font_size"] == probe.size
    margin = max(round(image.width * 0.04), result.manifest["cap_height"])
    for block in result.manifest["blocks"]:
        for row in block["rows"]:
            assert margin <= row["position"][0]
            assert row["position"][0] + row["width"] <= image.width - margin
    assert all(not block["shifted"] for block in result.manifest["blocks"])


def test_descender_on_last_line_has_full_glyph_clearance(monkeypatch):
    image = Image.new("RGB", (220, 80), "white")
    ImageDraw.Draw(image).rectangle((20, 30, 199, 45), fill=(20, 80, 140))
    anchor = _anchor(bottom=45)
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)

    result = compose_extra_lines(image, [("fax", "ggg")])

    assert result.manifest["status"] == "composed"
    part = result.manifest["blocks"][-1]["rows"][-1]["parts"][0]
    font_path = extra_lines._font_path(result.manifest["bold"])
    assert font_path is not None
    font = ImageFont.truetype(font_path, result.manifest["font_size"])
    glyph_bottom = part["position"][1] + font.getbbox(part["value"])[3]
    assert glyph_bottom + result.manifest["bottom_air"] <= result.image.height


def test_blocks_use_inner_frame_bounds_instead_of_image_edges(monkeypatch):
    image = Image.new("RGB", (400, 150), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((60, 30, 339, 120), outline=(20, 80, 140), width=3)
    anchor = _anchor(left=305, right=335)
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)

    result = compose_extra_lines(
        image,
        [("instagram", "instagram.com/x")],
    )

    assert result.manifest["status"] == "composed"
    content_left, content_right = result.manifest["content_bounds"]
    assert content_left <= 60
    assert content_right >= 339
    margin = max(round(image.width * 0.04), result.manifest["cap_height"])
    row = result.manifest["blocks"][0]["rows"][0]
    assert row["position"][0] >= content_left + margin
    assert row["position"][0] + row["width"] <= content_right - margin


def test_appended_strip_fits_font_after_final_centering(monkeypatch):
    image = Image.new("RGB", (500, 140), "white")
    ImageDraw.Draw(image).rectangle((0, 30, 499, 60), fill=(20, 80, 140))
    anchor = _anchor(left=80, right=140, bottom=60)
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)

    result = compose_extra_lines(image, [("website", "www.example.de")])

    assert result.manifest["status"] == "composed"
    assert result.manifest["placement"] == "appended_strip"
    assert result.manifest["centred"] is False
    assert result.manifest["alignment"] == "left"
    row = result.manifest["blocks"][0]["rows"][0]
    content_left, content_right = result.manifest["content_bounds"]
    assert result.manifest["alignment"] == "left"
    assert row["position"][0] >= content_left
    assert row["position"][0] + row["width"] <= content_right
    probe = extra_lines._fit_font(
        "X", result.manifest["cap_height"], result.manifest["bold"]
    )
    assert probe is not None
    assert result.manifest["font_size"] == probe.size


def _reset_anchor(mixed: bool = False):
    segments = [
        {
            "text": "Telefon 06441 12345",
            "heights": [("Telefon", 10), ("06441", 10)],
            "left": 30,
            "top": 40,
            "right": 520,
            "bottom": 50,
            "ocr_source": "whole_image",
            "confidence": 95,
        },
        {
            "text": (
                "Telefon 06441 12345 Öffnungszeiten 9-17"
                if mixed
                else "E-Mail info@example.de"
            ),
            "heights": [("E-Mail", 10), ("info@example.de", 10)],
            "left": 30,
            "top": 55,
            "right": 520,
            "bottom": 65,
            "ocr_source": "whole_image",
            "confidence": 95,
        },
    ]
    return {
        "text": segments[-1]["text"],
        "heights": segments[-1]["heights"],
        "left": segments[-1]["left"],
        "top": segments[-1]["top"],
        "right": segments[-1]["right"],
        "bottom": segments[-1]["bottom"],
        "contact_segments": segments,
        "ocr_lines": segments,
    }


def test_resets_existing_communication_block_and_keeps_removed_values(
    monkeypatch,
):
    image = Image.new("RGB", (600, 140), (20, 80, 140))
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(extra_lines._font_path(False), 10)
    draw.text((30, 40), "Telefon 06441 12345", font=font, fill="white")
    draw.text((30, 55), "E-Mail info@example.de", font=font, fill="white")
    anchor = _reset_anchor()
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)
    monkeypatch.setattr(extra_lines, "_content_bounds", lambda *_args: (0, 600))

    result = compose_extra_lines(
        image,
        [
            ("fax", "06441 98765"),
            ("website", "www.example.de"),
        ],
    )

    assert result.manifest["mode"] == "block_reset"
    assert result.manifest["placement"] == "block_reset"
    removed = {
        (item["channel"], item["value"])
        for item in result.manifest["removed_communication_values"]
    }
    assert ("phone", "06441 12345") in removed
    set_values = {
        (item["channel"], item["value"]) for item in result.manifest["set_values"]
    }
    assert removed <= set_values
    rows = [row for block in result.manifest["blocks"] for row in block["rows"]]
    assert rows[0]["parts"][0]["display_value"].startswith("T ")
    assert rows[0]["parts"][1]["display_value"].startswith("F ")
    assert all(
        abs(row["position"][0] + row["width"] / 2 - 275) <= 1
        for row in rows
    )


def test_mixed_contact_content_is_not_removed_and_falls_back_to_append(monkeypatch):
    image = Image.new("RGB", (600, 140), (20, 80, 140))
    font = ImageFont.truetype(extra_lines._font_path(False), 10)
    draw = ImageDraw.Draw(image)
    draw.text(
        (30, 40),
        "Telefon 06441 12345",
        font=font,
        fill="white",
    )
    draw.text(
        (30, 55),
        "Telefon 06441 12345 Öffnungszeiten 9-17",
        font=font,
        fill="white",
    )
    anchor = _reset_anchor(mixed=True)
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)
    monkeypatch.setattr(extra_lines, "_content_bounds", lambda *_args: (0, 600))

    result = compose_extra_lines(
        image,
        [
            ("fax", "06441 98765"),
            ("website", "example.de"),
            ("facebook", "facebook.com/example"),
            ("instagram", "instagram.com/example"),
        ],
    )

    assert result.manifest["mode"] == "append"
    assert result.manifest["placement"] != "block_reset"
    assert result.manifest["block_reset_skipped_reason"] == (
        "mixed_or_uncertain_contact_block"
    )


def test_non_homogeneous_contact_background_falls_back_to_append(monkeypatch):
    image = Image.new("RGB", (600, 140), (20, 80, 140))
    draw = ImageDraw.Draw(image)
    for y in range(38, 68, 2):
        draw.line((25, y, 540, y), fill=(y * 3 % 255, 20, 40))
    anchor = _reset_anchor()
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)
    monkeypatch.setattr(extra_lines, "_content_bounds", lambda *_args: (0, 600))

    result = compose_extra_lines(image, [("fax", "06441 98765")])

    assert result.manifest["mode"] == "append"
    assert result.manifest["block_reset_skipped_reason"] == (
        "non_homogeneous_background"
    )


def test_reset_growth_continues_each_column_from_seam(monkeypatch):
    image = Image.new("RGB", (600, 180), (20, 80, 140))
    draw = ImageDraw.Draw(image)
    draw.line((0, 0, 0, 179), fill=(220, 20, 20), width=2)
    draw.line((599, 0, 599, 179), fill=(20, 20, 220), width=2)
    font = ImageFont.truetype(extra_lines._font_path(False), 10)
    draw.text((30, 40), "Telefon 06441 12345", font=font, fill="white")
    draw.text((30, 55), "E-Mail info@example.de", font=font, fill="white")
    anchor = _reset_anchor()
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)
    monkeypatch.setattr(extra_lines, "_content_bounds", lambda *_args: (0, 600))

    result = compose_extra_lines(
        image,
        [
            ("fax", "06441 98765"),
            ("website", "example.de"),
            ("facebook", "facebook.com/example"),
            ("instagram", "instagram.com/example"),
        ],
    )

    assert result.manifest["mode"] == "block_reset"
    assert result.image.getpixel((0, 66)) == image.getpixel((0, 65))
    assert result.image.getpixel((599, 66)) == image.getpixel((599, 65))


def test_reset_does_not_move_nonhomogeneous_artwork(monkeypatch):
    image = Image.new("RGB", (600, 80), (20, 80, 140))
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(extra_lines._font_path(False), 10)
    draw.text((30, 40), "Telefon 06441 12345", font=font, fill="white")
    draw.text((30, 55), "E-Mail info@example.de", font=font, fill="white")
    for y in range(66, 80):
        draw.line((0, y, 599, y), fill=(y * 7 % 255, 30, 90))
    anchor = _reset_anchor()
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)
    monkeypatch.setattr(extra_lines, "_content_bounds", lambda *_args: (0, 600))

    result = compose_extra_lines(image, [("fax", "06441 98765")])

    assert result.manifest["mode"] == "append"
    assert result.manifest["block_reset_skipped_reason"] in {
        "no_room_without_moving_artwork",
        "non_homogeneous_background",
        "elements_overlap_existing_content",
    }


def test_inline_fax_rejects_nonhomogeneous_right_hand_area(monkeypatch):
    image = Image.new("RGB", (600, 140), (20, 80, 140))
    draw = ImageDraw.Draw(image)
    draw.rectangle((30, 40, 300, 55), fill="white")
    for y in range(35, 61):
        draw.line((301, y, 590, y), fill=(y * 5 % 255, 30, 90))
    anchor = {
        "text": "06441 12345 | schmidt.example.de",
        "heights": [("06441", 10), ("12345", 10)],
        "left": 30,
        "top": 40,
        "right": 300,
        "bottom": 55,
        "contact_segments": [
            {
                "text": "06441 12345 | schmidt.example.de",
                "heights": [("06441", 10), ("12345", 10)],
                "left": 30,
                "top": 40,
                "right": 300,
                "bottom": 55,
                "ocr_source": "whole_image",
                "confidence": 95,
            }
        ],
        "ocr_lines": [],
    }
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)
    monkeypatch.setattr(extra_lines, "_content_bounds", lambda *_args: (0, 600))

    result = compose_extra_lines(image, [("fax", "06441 98765")])

    assert result.manifest["fax_inline"] is False
    assert result.manifest["fax_inline_reason"] == "no_homogeneous_space"


def test_reset_band_uses_homogeneous_rows_around_removed_block():
    image = Image.new("RGB", (120, 100), (240, 220, 180))
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 10, 119, 14), fill=(10, 20, 30))
    draw.rectangle((0, 45, 119, 49), fill=(10, 20, 30))
    reset = {"left": 30, "right": 90, "top": 20, "bottom": 40}

    assert extra_lines._reset_band(image, reset, (240, 220, 180), 10) == (15, 45)


def test_inline_fax_area_reserves_cap_height_before_foreign_content():
    image = Image.new("RGB", (240, 80), (240, 220, 180))
    draw = ImageDraw.Draw(image)
    draw.rectangle((190, 25, 239, 55), fill=(20, 30, 40))
    segment = {"left": 20, "right": 80, "top": 30, "bottom": 45}

    area = extra_lines._inline_fax_area(image, segment, 240, 0, 10)

    assert area is not None
    assert area[1] <= 180


def test_all_rendered_rows_are_centered_in_the_content_frame(monkeypatch):
    image = Image.new("RGB", (600, 140), (20, 80, 140))
    draw = ImageDraw.Draw(image)
    draw.rectangle((30, 40, 300, 55), fill="white")
    anchor = _anchor(left=30, right=300, bottom=55)
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)

    result = compose_extra_lines(
        image,
        [
            ("fax", "06441 98765"),
            ("facebook", "facebook.com/example"),
            ("instagram", "instagram.com/example"),
        ],
    )

    content_left, content_right = result.manifest["content_bounds"]
    frame_center = (content_left + content_right) / 2
    for block in result.manifest["blocks"]:
        for row in block["rows"]:
            assert abs(row["position"][0] + row["width"] / 2 - frame_center) <= 1


def test_reset_rejects_element_over_existing_artwork():
    image = Image.new("RGB", (160, 100), (230, 220, 190))
    ImageDraw.Draw(image).rectangle((70, 30, 130, 60), fill=(20, 30, 40))
    reset = {
        "segments": [{"left": 20, "right": 60, "top": 40, "bottom": 55}],
    }
    assert not extra_lines._reset_elements_fit(
        image,
        reset,
        (230, 220, 190),
        [(40, 35, 110, 55)],
        20,
        80,
        0,
        0,
        160,
        20,
    )


def test_group_lines_keeps_communication_channel_order():
    image = Image.new("RGB", (600, 100), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(extra_lines._font_path(False), 20)

    blocks = extra_lines._group_lines(
        [
            ("instagram", "instagram.com/example"),
            ("website", "example.de"),
            ("fax", "06441 98765"),
            ("email", "info@example.de"),
            ("phone", "06441 12345"),
        ],
        draw,
        font,
        20,
        600,
    )

    assert [block["name"] for block in blocks] == ["phone", "email_web", "social"]
    assert [part["channel"] for part in blocks[0]["rows"][0]["parts"]] == [
        "phone",
        "fax",
    ]
    assert [part["channel"] for part in blocks[1]["rows"][0]["parts"]] == [
        "email",
        "website",
    ]


def test_reset_clears_padded_removed_glyph_area(monkeypatch):
    image = Image.new("RGB", (600, 140), (20, 80, 140))
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(extra_lines._font_path(False), 10)
    draw.text((30, 40), "Telefon 06441 12345", font=font, fill="white")
    draw.text((30, 55), "E-Mail info@example.de", font=font, fill="white")
    anchor = _reset_anchor()
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)
    monkeypatch.setattr(extra_lines, "_content_bounds", lambda *_args: (0, 600))

    result = compose_extra_lines(
        image,
        [("fax", "06441 98765"), ("website", "example.de")],
    )
    assert result.manifest["mode"] == "block_reset"
    background = result.manifest["background"]
    for y in range(37, 68):
        for x in range(450, 523):
            assert result.image.getpixel((x, y)) == tuple(background)


def test_reset_growth_delta_uses_last_planned_glyph_box(monkeypatch):
    image = Image.new("RGB", (600, 160), (20, 80, 140))
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(extra_lines._font_path(False), 10)
    draw.text((30, 40), "Telefon 06441 12345", font=font, fill="white")
    draw.text((30, 55), "E-Mail info@example.de", font=font, fill="white")
    anchor = _reset_anchor()
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)
    monkeypatch.setattr(extra_lines, "_content_bounds", lambda *_args: (0, 600))
    monkeypatch.setattr(extra_lines, "_reset_band", lambda *_args: (20, 80))
    calls = []

    def capture_fit(*args):
        calls.append(args)
        return True

    monkeypatch.setattr(extra_lines, "_reset_elements_fit", capture_fit)
    result = compose_extra_lines(
        image,
        [("fax", "06441 98765"), ("website", "example.de")],
    )

    assert result.manifest["mode"] == "block_reset"
    boxes = calls[0][3]
    cap_height = calls[0][9]
    expected_delta = max(
        0,
        max(box[3] for box in boxes)
        + round(cap_height * 0.15)
        + result.manifest["bottom_air"]
        - 80,
    )
    assert calls[0][6] == expected_delta
    assert result.image.height == image.height + expected_delta


def test_reset_uses_topmost_safe_candidate(monkeypatch):
    image = Image.new("RGB", (600, 180), (20, 80, 140))
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(extra_lines._font_path(False), 10)
    draw.text((30, 40), "Telefon 06441 12345", font=font, fill="white")
    draw.text((30, 55), "E-Mail info@example.de", font=font, fill="white")
    anchor = _reset_anchor()
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)
    monkeypatch.setattr(extra_lines, "_content_bounds", lambda *_args: (0, 600))
    monkeypatch.setattr(extra_lines, "_reset_band", lambda *_args: (20, 120))
    calls = []

    def accept_second_candidate(*args):
        calls.append(args)
        return len(calls) == 2

    monkeypatch.setattr(extra_lines, "_reset_elements_fit", accept_second_candidate)
    result = compose_extra_lines(image, [("fax", "06441 98765")])

    assert result.manifest["mode"] == "block_reset"
    assert result.manifest["blocks"][0]["top"] == 40 + 5
    assert len(calls) >= 2


def test_reset_growth_over_image_limit_falls_back(monkeypatch):
    image = Image.new("RGB", (600, 100), (20, 80, 140))
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(extra_lines._font_path(False), 10)
    draw.text((30, 40), "Telefon 06441 12345", font=font, fill="white")
    draw.text((30, 55), "E-Mail info@example.de", font=font, fill="white")
    anchor = _reset_anchor()
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)
    monkeypatch.setattr(extra_lines, "_content_bounds", lambda *_args: (0, 600))
    monkeypatch.setattr(extra_lines, "_reset_band", lambda *_args: (20, 20))
    monkeypatch.setattr(extra_lines, "_reset_elements_fit", lambda *_args: True)

    result = compose_extra_lines(image, [("fax", "06441 98765")])

    assert result.manifest["mode"] == "append"
    assert result.manifest["block_reset_skipped_reason"]


def test_layout_geometry_matches_every_drawn_part_and_logo():
    image = Image.new("RGB", (700, 180), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(extra_lines._font_path(False), 24)
    blocks = extra_lines._group_lines(
        [
            ("phone", "06441 12345"),
            ("fax", "06441 98765"),
            ("email", "info@example.de"),
            ("website", "example.de"),
            ("facebook", "facebook.com/example"),
            ("instagram", "instagram.com/example"),
        ],
        draw,
        font,
        24,
        600,
    )

    layout = extra_lines._layout_elements(
        blocks,
        font,
        draw,
        80,
        40,
        42,
        22,
        24,
    )

    for block_layout in layout["blocks"]:
        for row_layout in block_layout["rows"]:
            for part_layout in row_layout["parts"]:
                part = part_layout["part"]
                assert part_layout["text_box"] == draw.textbbox(
                    part_layout["text_position"],
                    part["display_value"],
                    font=part.get("font", font),
                )
                if part_layout["logo_box"] is not None:
                    left, top, right, bottom = part_layout["logo_box"]
                    assert (right - left, bottom - top) == part["logo"].size
                    assert part_layout["logo_position"] == (left, top)


def test_reset_fallback_does_not_duplicate_inline_fax(monkeypatch):
    image = Image.new("RGB", (600, 140), (20, 80, 140))
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(extra_lines._font_path(False), 10)
    draw.text((30, 40), "Telefon 06441 12345", font=font, fill="white")
    draw.text((30, 55), "E-Mail info@example.de", font=font, fill="white")
    anchor = _reset_anchor()
    reset_segment = anchor["contact_segments"][1]
    reset = {
        "segments": [reset_segment],
        "values": [("email", "info@example.de")],
        "left": reset_segment["left"],
        "top": reset_segment["top"],
        "right": reset_segment["right"],
        "bottom": reset_segment["bottom"],
    }
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)
    monkeypatch.setattr(extra_lines, "_reset_block", lambda _anchor: reset)
    monkeypatch.setattr(extra_lines, "_content_bounds", lambda *_args: (0, 600))
    monkeypatch.setattr(
        extra_lines,
        "_inline_fax_area",
        lambda *_args: (220, 500, 40, (20, 80, 140)),
    )
    monkeypatch.setattr(extra_lines, "_reset_elements_fit", lambda *_args: False)

    result = compose_extra_lines(image, [("fax", "06441 98765")])

    fax_values = [
        item["value"]
        for item in result.manifest["set_values"]
        if item["channel"] == "fax"
    ]
    assert result.manifest["mode"] == "append"
    assert fax_values == ["06441 98765"]


def test_inline_fax_is_not_used_for_a_reset_segment(monkeypatch):
    image = Image.new("RGB", (600, 140), (20, 80, 140))
    segment = {
        "text": "06441 12345",
        "left": 30,
        "top": 40,
        "right": 180,
        "bottom": 55,
        "ocr_source": "whole_image",
        "confidence": 95,
    }
    anchor = _anchor(left=30, right=180, bottom=55)
    anchor["contact_segments"] = [segment]
    reset = {
        "segments": [segment],
        "values": [("phone", "06441 12345")],
        "left": 30,
        "top": 40,
        "right": 180,
        "bottom": 55,
    }
    monkeypatch.setattr(extra_lines, "_anchor", lambda _image: anchor)
    monkeypatch.setattr(extra_lines, "_reset_block", lambda _anchor: reset)
    monkeypatch.setattr(
        extra_lines,
        "_inline_fax_area",
        lambda *_args: (190, 350, 40, (20, 80, 140)),
    )

    result = compose_extra_lines(image, [("fax", "06441 98765")])

    assert result.manifest["fax_inline"] is False
    assert result.manifest["fax_inline_reason"] == "no_homogeneous_space"


def test_seam_repeatability_requires_a_real_comparison_window():
    image = Image.new("RGB", (80, 40), (20, 80, 140))

    assert not extra_lines._seam_repeatable(image, 10, 10, 0, 40)
    assert extra_lines._seam_repeatable(image, 10, 16, 0, 40)
