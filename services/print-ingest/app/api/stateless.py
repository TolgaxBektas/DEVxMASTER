import json
import re

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

from app.core.config import settings
from app.services.processor import (
    extract_contacts,
    extract_pdf_metadata,
    heuristic_ad_regions,
    load_page_gray,
    render_ad_crop_with_margin,
    render_and_extract,
)
from app.services.run50 import ResponsesClient, detect_document, is_order_form_page
from app.services.storage import storage
from app.services.downloader import download_pdf, DownloadError
from app.api.routes import _json_safe, require_service_token

router = APIRouter()


@router.post("/fetch")
def fetch_source(payload: dict, _token: None = Depends(require_service_token)):
    url = payload.get("url")
    if not isinstance(url, str):
        raise HTTPException(400, "url_required")
    archive_url = payload.get("archive_url")
    if not isinstance(archive_url, str):
        archive_url = None
    archive_length = payload.get("archive_length")
    if not isinstance(archive_length, int):
        archive_length = None
    archive_captures = payload.get("archive_captures")
    if not isinstance(archive_captures, list):
        archive_captures = None
    try:
        data, metadata = download_pdf(
            url,
            archive_url=archive_url,
            archive_length=archive_length,
            archive_captures=archive_captures,
        )
    except DownloadError as exc:
        raise HTTPException(400, str(exc)) from exc
    response_headers = {
        "X-Source-Url": metadata["final_url"],
        "X-Source-Sha256": metadata["sha256"],
        "X-Source-Origin": metadata["origin"],
        "Content-Disposition": f'attachment; filename="{metadata["filename"]}"',
    }
    if "archive_index_length" in metadata:
        response_headers["X-Archive-Index-Length"] = str(metadata["archive_index_length"])
    return Response(
        content=data,
        media_type="application/pdf",
        headers=response_headers,
    )


@router.post("/process")
def process_upload(
    file: UploadFile = File(...),
    output_prefix: str = Form(...),
    _token: None = Depends(require_service_token),
):
    if not re.fullmatch(r"[a-zA-Z0-9/_-]{1,200}", output_prefix):
        raise HTTPException(400, "invalid_output_prefix")
    data = file.file.read(settings.max_download_mb * 1024 * 1024 + 1)
    if len(data) > settings.max_download_mb * 1024 * 1024:
        raise HTTPException(413, "file_too_large")
    if not data.startswith(b"%PDF-"):
        raise HTTPException(400, "not_a_real_pdf")
    detector = settings.ad_detector
    if detector == "run50":
        if not settings.openai_api_key:
            raise HTTPException(
                500,
                "OPENAI_API_KEY is required when AD_DETECTOR=run50",
            )
    elif detector != "heuristic":
        raise HTTPException(500, f"Unsupported AD_DETECTOR: {detector}")
    try:
        pages = render_and_extract(data)
    except Exception as error:
        raise HTTPException(422, f"invalid_pdf: {error}") from error
    pdf_metadata = extract_pdf_metadata(data)
    run50_pages = {}
    if detector == "run50":
        run50_pages = {
            result.page_number: result
            for result in detect_document(
                data,
                pages,
                ResponsesClient(settings.openai_api_key),
                concurrency=settings.run50_concurrency,
            )
        }
    result = []
    for page in pages:
        number = page["page_number"]
        image_key = f"{output_prefix}/page-{number:04d}.png"
        text = page["text"]
        candidates = []
        order_form = is_order_form_page(text)
        rejected = []
        if detector == "run50":
            page_result = run50_pages[number]
            for index, ad in enumerate(page_result.accepted, start=1):
                region = ad.region
                ad_key = f"{output_prefix}/ad-{number:04d}-{index:02d}.png"
                storage.put_bytes(ad_key, ad.crop_png, "image/png")
                candidates.append(
                    {
                        "bbox": {
                            key: region[key]
                            for key in ("x", "y", "width", "height", "confidence")
                        },
                        "image_key": ad_key,
                        "confidence": region["confidence"],
                        "evidence": region.get("evidence", []),
                        "company": ad.company,
                        "preview": region.get("preview", ""),
                        "contacts": extract_contacts(ad.text),
                        "crop": ad.crop_info,
                        "run50": ad.run50,
                    }
                )
            rejected = [
                {
                    "stage": item.stage,
                    "reason": item.reason,
                    "company": item.company,
                    "bbox": (
                        {
                            key: item.region[key]
                            for key in ("x", "y", "width", "height", "confidence")
                        }
                        if item.region is not None
                        else None
                    ),
                }
                for item in page_result.rejected
            ]
        elif not order_form:
            regions = heuristic_ad_regions(page["image_bytes"], text, page.get("layout"))
            page_image = load_page_gray(page["image_bytes"])
            for index, region in enumerate(regions, start=1):
                ad_key = f"{output_prefix}/ad-{number:04d}-{index:02d}.png"
                crop_bytes, crop_info = render_ad_crop_with_margin(
                    data,
                    number,
                    region,
                    page.get("layout"),
                    regions,
                    page_image=page_image,
                )
                storage.put_bytes(ad_key, crop_bytes, "image/png")
                ad_text = " ".join(str(region.get("preview", "")).split())
                candidates.append(
                    {
                        "bbox": {
                            key: region[key]
                            for key in ("x", "y", "width", "height", "confidence")
                        },
                        "image_key": ad_key,
                        "confidence": region["confidence"],
                        "evidence": region.get("evidence", []),
                        "company": _company_from_text(ad_text),
                        "preview": ad_text[:1000],
                        "contacts": extract_contacts(ad_text),
                        "crop": crop_info,
                    }
                )
        if candidates:
            storage.put_bytes(image_key, page["image_bytes"], "image/png")
        page_result = {
            "page_number": number,
            "text": text,
            "image_key": image_key if candidates else None,
            "classification": "ORDER_FORM" if order_form else page["classification"],
            "ad_probability": page["ad_probability"],
            "occurrences": candidates,
            "title_candidates": page.get("title_candidates", []),
            "detector": detector,
        }
        if detector == "run50":
            page_result["rejected"] = rejected
        result.append(page_result)
    return Response(
        content=json.dumps(
            _json_safe({"metadata": pdf_metadata, "pages": result}),
            ensure_ascii=True,
        ),
        media_type="application/json",
    )


def _company_from_text(text: str) -> str:
    match = re.search(
        r"\b("
        r"[A-ZÄÖÜ][\wÄÖÜäöüß&.-]*(?:"
        r"\s+(?:[A-ZÄÖÜ][\wÄÖÜäöüß&.-]*|für|und|der|die|das|"
        r"des|von|vom|zur|zum|im|in|Stadt|Landkreis)"
        r"){0,10}\s+(?:GmbH|AG|KG|e\.\s*V\.)"
        r")",
        text,
    )
    if match:
        return match.group(1)
    return " ".join(text.split())[:255] or "Unbekannte Firma"
