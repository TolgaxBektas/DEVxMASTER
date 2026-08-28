import re

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

from app.core.config import settings
from app.services.processor import (
    extract_contacts,
    extract_pdf_metadata,
    heuristic_ad_regions,
    render_ad_crop,
    render_and_extract,
)
from app.services.storage import storage
from app.services.downloader import download_pdf, DownloadError
from app.api.routes import require_service_token

router = APIRouter()


@router.post("/fetch")
async def fetch_source(payload: dict, _token: None = Depends(require_service_token)):
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
async def process_upload(
    file: UploadFile = File(...),
    output_prefix: str = Form(...),
    _token: None = Depends(require_service_token),
):
    if not re.fullmatch(r"[a-zA-Z0-9/_-]{1,200}", output_prefix):
        raise HTTPException(400, "invalid_output_prefix")
    data = await file.read(settings.max_download_mb * 1024 * 1024 + 1)
    if len(data) > settings.max_download_mb * 1024 * 1024:
        raise HTTPException(413, "file_too_large")
    if not data.startswith(b"%PDF-"):
        raise HTTPException(400, "not_a_real_pdf")
    try:
        pages = render_and_extract(data)
    except Exception as error:
        raise HTTPException(422, f"invalid_pdf: {error}") from error
    pdf_metadata = extract_pdf_metadata(data)
    result = []
    for page in pages:
        number = page["page_number"]
        image_key = f"{output_prefix}/page-{number:04d}.png"
        storage.put_bytes(image_key, page["image_bytes"], "image/png")
        text = page["text"]
        candidates = []
        for index, region in enumerate(
            heuristic_ad_regions(page["image_bytes"], text, page.get("layout")),
            start=1,
        ):
            ad_key = f"{output_prefix}/ad-{number:04d}-{index:02d}.png"
            storage.put_bytes(ad_key, render_ad_crop(data, number, region), "image/png")
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
                }
            )
        result.append(
            {
                "page_number": number,
                "text": text,
                "image_key": image_key,
                "classification": page["classification"],
                "ad_probability": page["ad_probability"],
                "occurrences": candidates,
                "title_candidates": page.get("title_candidates", []),
            }
        )
    return {"metadata": pdf_metadata, "pages": result}


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
