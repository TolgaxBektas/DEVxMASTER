from sqlalchemy.orm import Session
from app.core.config import settings
from app.models.entities import Document, Page, AdOccurrence
from app.services.storage import storage
from app.services.processor import (
    heuristic_ad_regions,
    load_page_gray,
    render_ad_crop_with_margin,
    render_and_extract,
)
from app.services.run50 import ResponsesClient, detect_document, is_order_form_page

def process_document(db: Session, document: Document):
    document.state='PROCESSING'; db.commit()
    try:
        pdf=storage.get_bytes(document.storage_key)
        pages=render_and_extract(pdf)
        document.page_count=len(pages)
        detector=settings.ad_detector
        run50_results={}
        if detector == 'run50':
            api_key=settings.openai_api_key
            if not api_key:
                raise RuntimeError('OPENAI_API_KEY is required when AD_DETECTOR=run50')
            run50_results={
                result.page_number: result
                for result in detect_document(
                    pdf,
                    pages,
                    ResponsesClient(api_key),
                    concurrency=settings.run50_concurrency,
                )
            }
        elif detector != 'heuristic':
            raise RuntimeError(f'Unsupported AD_DETECTOR: {detector}')
        for p in pages:
            img_key=f'pages/{document.sha256}/page-{p["page_number"]:04d}.png'
            storage.put_bytes(img_key,p['image_bytes'],'image/png')
            order_form=is_order_form_page(p['text'])
            classification='ORDER_FORM' if order_form else p['classification']
            page=Page(document_id=document.id,page_number=p['page_number'],image_key=img_key,text=p['text'],classification=classification,ad_probability=p['ad_probability'])
            db.add(page); db.flush()
            if detector == 'run50':
                detections=run50_results[p['page_number']].accepted
                region_items=[(ad.region,ad.crop_png,ad.crop_info,ad.run50) for ad in detections]
            elif order_form:
                region_items=[]
            else:
                regions = heuristic_ad_regions(p['image_bytes'], p['text'], p.get('layout'))
                page_image = load_page_gray(p["image_bytes"])
                region_items=[]
                for reg in regions:
                    crop_bytes, crop_info = render_ad_crop_with_margin(
                        pdf,
                        p["page_number"],
                        reg,
                        p.get("layout"),
                        regions,
                        page_image=page_image,
                    )
                    region_items.append((reg,crop_bytes,crop_info,None))
            for index, (reg,crop_bytes,crop_info,run50_metadata) in enumerate(region_items, start=1):
                ad_key=f'ads/{document.sha256}/page-{p["page_number"]:04d}-{index:02d}.png'
                storage.put_bytes(ad_key, crop_bytes, 'image/png')
                extracted_json={
                    "evidence": reg.get("evidence", []),
                    "preview": reg.get("preview", ""),
                    "crop": crop_info,
                }
                if run50_metadata is not None:
                    extracted_json["run50"]=run50_metadata
                db.add(AdOccurrence(
                    page_id=page.id,
                    bbox={
                        key: reg[key]
                        for key in ("x", "y", "width", "height", "confidence")
                    },
                    image_key=ad_key,
                    confidence=reg['confidence'],
                    validation_status='REVIEW_REQUIRED',
                    extracted_json=extracted_json,
                ))
        document.state='REVIEW_REQUIRED'; document.error=None; db.commit()
        return {'document_id':document.id,'pages':len(pages),'state':document.state}
    except Exception as exc:
        document.state='FAILED'; document.error=str(exc); db.commit(); raise
