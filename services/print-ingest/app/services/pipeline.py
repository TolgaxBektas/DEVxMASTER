from sqlalchemy.orm import Session
from app.models.entities import Document, Page, AdOccurrence
from app.services.storage import storage
from app.services.processor import render_and_extract, heuristic_ad_regions

def process_document(db: Session, document: Document):
    document.state='PROCESSING'; db.commit()
    try:
        pdf=storage.get_bytes(document.storage_key)
        pages=render_and_extract(pdf)
        document.page_count=len(pages)
        for p in pages:
            img_key=f'pages/{document.sha256}/page-{p["page_number"]:04d}.png'
            storage.put_bytes(img_key,p['image_bytes'],'image/png')
            page=Page(document_id=document.id,page_number=p['page_number'],image_key=img_key,text=p['text'],classification=p['classification'],ad_probability=p['ad_probability'])
            db.add(page); db.flush()
            for reg in heuristic_ad_regions(p['image_bytes'],p['text']):
                ad_key=f'ads/{document.sha256}/page-{p["page_number"]:04d}-full.png'
                storage.put_bytes(ad_key,p['image_bytes'],'image/png')
                db.add(AdOccurrence(page_id=page.id,bbox=reg,image_key=ad_key,confidence=reg['confidence'],validation_status='REVIEW_REQUIRED',extracted_json={}))
        document.state='REVIEW_REQUIRED'; document.error=None; db.commit()
        return {'document_id':document.id,'pages':len(pages),'state':document.state}
    except Exception as exc:
        document.state='FAILED'; document.error=str(exc); db.commit(); raise
