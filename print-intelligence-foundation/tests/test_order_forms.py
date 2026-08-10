from app.services.order_forms import (
    merge_form_and_ad_fields,
    parse_order_form,
)


def _pdf(pages: list[list[str]]) -> bytes:
    if pages and isinstance(pages[0], str):
        pages = [pages]
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{ ' '.join(f'{3 + i * 3} 0 R' for i in range(len(pages))) }] /Count {len(pages)} >>".encode(),
    ]
    for page_index, lines in enumerate(pages):
        page_object = 3 + page_index * 3
        content_object = page_object + 2
        content = "BT /F1 10 Tf\n"
        for line_index, line in enumerate(lines):
            escaped = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            content += f"1 0 0 1 20 {760 - line_index * 20} Tm ({escaped}) Tj\n"
        content += "ET"
        objects.extend(
            [
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {page_object + 1} 0 R >> >> /Contents {content_object} 0 R >>".encode(),
                b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
                f"<< /Length {len(content.encode())} >>\nstream\n{content}\nendstream".encode(),
            ]
        )
    output = b"%PDF-1.4\n"
    offsets = []
    for number, obj in enumerate(objects, 1):
        offsets.append(len(output))
        output += f"{number} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref = len(output)
    output += (
        f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
        + b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets)
        + f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode()
    )
    return output


def test_synthetic_order_form_extracts_label_left_values_and_metadata(tmp_path):
    pdf = tmp_path / "synthetic-order-form.pdf"
    pdf.write_bytes(
        _pdf(
            [
                "PUBLIKATIONSVORSCHLAG",
                "FIRMA : Synthetic Bau GmbH",
                "STRASSE : Teststrasse 1",
                "PLZ/ORT : 12345 Teststadt",
                "ASP. : Frau Test",
                "TEL : 01234 56789",
                "FAX : 01234 56780",
                "E-MAIL : customer@example.de",
                "Datum : 01.01.2026",
                "Vorgang : SYN",
                "Berater : Unit",
            ]
        )
    )
    result = parse_order_form(pdf, 1)
    assert result.is_order_form
    assert result.complete
    assert result.fields == {
        "company": "Synthetic Bau GmbH",
        "contact_person": "Frau Test",
        "street": "Teststrasse 1",
        "postal_code": "12345",
        "city": "Teststadt",
        "phone": "01234 56789",
        "fax": "01234 56780",
        "email": "customer@example.de",
        "address": "Teststrasse 1, 12345 Teststadt",
    }
    assert result.metadata == {
        "datum": "01.01.2026",
        "vorgang": "SYN",
        "berater": "Unit",
    }


def test_synthetic_order_form_accepts_boxed_label_variants(tmp_path):
    pdf = tmp_path / "synthetic-kundendaten.pdf"
    pdf.write_bytes(
        _pdf(
            [
                "KUNDENDATEN ANZEIGENAUFTRAG",
                "Firma: Synthetic Apotheke",
                "Ansprechpartner: Herr Example",
                "Strasse-Hausnr: Musterweg 2",
                "PLZ-Ort: 54321 Beispielstadt",
                "Telefon: 09876 54321",
                "E-mail: boxed@example.de",
            ]
        )
    )
    result = parse_order_form(pdf, 1)
    assert result.is_order_form
    assert result.fields["company"] == "Synthetic Apotheke"
    assert result.fields["contact_person"] == "Herr Example"
    assert result.fields["street"] == "Musterweg 2"
    assert result.fields["postal_code"] == "54321"
    assert result.fields["city"] == "Beispielstadt"
    assert result.fields["address"] == "Musterweg 2, 54321 Beispielstadt"
    assert result.fields["phone"] == "09876 54321"
    assert result.fields["email"] == "boxed@example.de"


def test_publisher_response_and_footer_data_are_rejected(tmp_path):
    pdf = tmp_path / "synthetic-publisher-data.pdf"
    pdf.write_bytes(
        _pdf(
            [
                "PUBLIKATIONSVORSCHLAG",
                "FIRMA : Synthetic GmbH",
                "STRASSE : Kundenweg 3",
                "PLZ/ORT : 11111 Kundenstadt",
                "TEL : 01111 22222",
                "E-MAIL : info@pr-media.org",
                "ANTWORT per E-Mail an info@concept-media.org",
                "Rücksendung an: Email: druckabteilungmedien@gmail.com",
                "Auftragnehmer: ConceptMedia Studio LLC",
            ]
        )
    )
    result = parse_order_form(pdf, 1)
    assert result.fields["company"] == "Synthetic GmbH"
    assert "email" not in result.fields


def test_missing_header_field_is_incomplete_and_no_header_is_detected(tmp_path):
    missing = tmp_path / "synthetic-missing-field.pdf"
    missing.write_bytes(
        _pdf(
            [
                "BUERGERINFO-BROSCHUERE",
                "FIRMA : Synthetic GmbH",
                "STRASSE : Kundenweg 3",
                "PLZ/ORT : 11111 Kundenstadt",
            ]
        )
    )
    result = parse_order_form(missing, 1)
    assert result.is_order_form
    assert not result.complete

    no_header = tmp_path / "synthetic-no-header.pdf"
    no_header.write_bytes(
        _pdf(
            [
                "PUBLIKATIONSVORSCHLAG",
                "ANTWORT per E-Mail an info@pr-media.org",
            ]
        )
    )
    result = parse_order_form(no_header, 1)
    assert result.is_order_form
    assert result.fields == {}
    assert not result.complete


def test_header_and_advert_values_are_kept_as_conflicts():
    merged, conflicts = merge_form_and_ad_fields(
        {"company": "Synthetic GmbH", "phone": "01111"},
        {"company": "Other Synthetic GmbH", "phone": "02222", "email": "ad@example.de"},
    )
    assert merged["company"] == "Synthetic GmbH"
    assert merged["phone"] == "01111"
    assert merged["email"] == "ad@example.de"
    assert conflicts == {
        "company": {"header": "Synthetic GmbH", "advert": "Other Synthetic GmbH"},
        "phone": {"header": "01111", "advert": "02222"},
    }
