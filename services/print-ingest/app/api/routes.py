from urllib.parse import urlparse
import re
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.security import APIKeyHeader
from app.core.config import settings
from sqlalchemy.orm import Session
from sqlalchemy import select
import hashlib
from app.db.session import SessionLocal
from app.models.entities import Source, Document, Page, AdOccurrence
from app.schemas.api import DiscoverRequest, DownloadRequest, ProcessRequest, AutoDiscoverRequest, RevisitRequest
from app.services.discovery import discover_pdf_links
from app.services.policy import DiscoveryBudget, check_url_policy, close_checked_response, read_limited_response, request_checked
from app.services.downloader import download_pdf, DownloadError
from app.services.storage import storage
from app.services.pipeline import process_document
from app.services.autodiscovery import discover_proposals, run_discovery

router=APIRouter()
token_header = APIKeyHeader(name='x-service-token', auto_error=False)

def require_service_token(token: str | None = Depends(token_header)):
    if token != settings.service_token:
        raise HTTPException(401, 'service token required')

def get_db():
    db=SessionLocal()
    try: yield db
    finally: db.close()

@router.get('/health')
def health(): return {'status':'ok', 'service':'print-ingest'}

@router.post('/sources/discover')
def discover(req: DiscoverRequest, db: Session=Depends(get_db), _token: None=Depends(require_service_token)):
    results=[]
    for raw in req.urls:
        url=str(raw)
        for item in discover_pdf_links(url):
            domain=urlparse(item['url']).hostname or ''
            src=db.scalar(select(Source).where(Source.url==item['url']))
            if not src:
                src=Source(url=item['url'],domain=domain,status='DISCOVERED',score=item['score'],metadata_json={'anchor_text':item['anchor_text'],'found_on':url})
                db.add(src); db.flush()
            results.append({'id':src.id,**item})
    db.commit(); return {'results':results}


@router.post('/discovery/run')
def autodiscover(req: AutoDiscoverRequest, db: Session=Depends(get_db), _token: None=Depends(require_service_token)):
    return run_discovery(
        db,
        [str(x) for x in req.seed_pages],
        req.search_terms,
        req.max_results,
        req.area_name,
        req.archive_domains,
    )

@router.post('/discovery/proposals')
def proposals(req: AutoDiscoverRequest, _token: None=Depends(require_service_token)):
    rejected: list[dict] = []
    items = discover_proposals(
        [str(x) for x in req.seed_pages], req.search_terms, req.max_results,
        req.area_name, rejected, req.archive_domains,
    )
    return {'proposals': items, 'rejected': rejected}

@router.post('/sources/revisit')
def revisit(req: RevisitRequest, _token: None=Depends(require_service_token)):
    url = str(req.url)
    policy = check_url_policy(url)
    if policy['status'] != 'APPROVED':
        raise HTTPException(400, 'Quelle ist für die Prüfung nicht zugelassen')
    budget = DiscoveryBudget(max_requests=10, max_depth=1)
    try:
        if url.lower().split('?', 1)[0].endswith('.pdf'):
            response = request_checked(url, policy=policy, budget=budget, stream=True,
                                       timeout=settings.request_timeout_seconds, allow_redirects=False)
            try:
                if response.status_code >= 400:
                    return {
                        'http_status': response.status_code,
                        'new_pdf_urls': [],
                        'new_pdf_count': 0,
                        'changed': False,
                        'fingerprint': req.fingerprint,
                        'note': f'Zielquelle antwortete mit HTTP {response.status_code}',
                    }
                signature = response.headers.get('ETag') or response.headers.get('Last-Modified')
                if not signature:
                    signature = hashlib.sha256(read_limited_response(
                        response, settings.max_download_mb * 1024 * 1024,
                    )).hexdigest()
                return {
                    'http_status': response.status_code,
                    'new_pdf_urls': [],
                    'new_pdf_count': 0,
                    'changed': req.fingerprint is not None and signature != req.fingerprint,
                    'fingerprint': signature,
                    'note': 'PDF-Signatur geprüft',
                }
            finally:
                close_checked_response(response)
        links = discover_pdf_links(url, budget=budget)
        signature = hashlib.sha256('|'.join(item['url'] for item in links).encode()).hexdigest()
        changed = req.fingerprint is not None and signature != req.fingerprint
        return {
            'http_status': 200,
            'new_pdf_urls': [item['url'] for item in links] if changed or req.fingerprint is None else [],
            'new_pdf_count': len(links) if changed or req.fingerprint is None else 0,
            'changed': changed,
            'fingerprint': signature,
            'note': 'PDF-Links der Übersichtsseite geprüft',
        }
    except RuntimeError as exc:
        match = re.fullmatch(r"discovery_http_error:(\d+)", str(exc))
        if match:
            status = int(match.group(1))
            return {
                'http_status': status,
                'new_pdf_urls': [],
                'new_pdf_count': 0,
                'changed': False,
                'fingerprint': req.fingerprint,
                'note': f'Zielquelle antwortete mit HTTP {status}',
            }
        raise HTTPException(400, 'Quellenprüfung fehlgeschlagen') from exc
    except Exception as exc:
        raise HTTPException(400, 'Quellenprüfung fehlgeschlagen') from exc

@router.get('/sources')
def list_sources(db: Session=Depends(get_db), _token: None=Depends(require_service_token)):
    rows=db.scalars(select(Source).order_by(Source.score.desc()).limit(500)).all()
    return [{'id':x.id,'url':x.url,'domain':x.domain,'status':x.status,'score':x.score} for x in rows]

@router.get('/review')
def review_queue(db: Session=Depends(get_db), _token: None=Depends(require_service_token)):
    rows=db.scalars(select(AdOccurrence).where(AdOccurrence.validation_status=='REVIEW_REQUIRED').limit(200)).all()
    return [{'ad_id':a.id,'page_id':a.page_id,'confidence':a.confidence,'image_key':a.image_key,'bbox':a.bbox} for a in rows]

@router.post('/documents/download')
def download(req: DownloadRequest, db: Session=Depends(get_db), _token: None=Depends(require_service_token)):
    try: data,meta=download_pdf(str(req.url))
    except DownloadError as e: raise HTTPException(400,str(e))
    existing=db.scalar(select(Document).where(Document.sha256==meta['sha256']))
    if existing: return {'document_id':existing.id,'deduplicated':True,'state':existing.state}
    key=f'originals/{meta["sha256"]}/{meta["filename"]}'
    storage.put_bytes(key,data,'application/pdf')
    doc=Document(source_id=req.source_id,original_url=meta['final_url'],filename=meta['filename'],sha256=meta['sha256'],size_bytes=meta['size_bytes'],storage_key=key,state='DOWNLOADED')
    db.add(doc); db.commit(); db.refresh(doc)
    return {'document_id':doc.id,'deduplicated':False,'state':doc.state}

@router.post('/documents/upload')
async def upload(file: UploadFile=File(...), db: Session=Depends(get_db), _token: None=Depends(require_service_token)):
    data=await file.read()
    if not data.startswith(b'%PDF-'): raise HTTPException(400,'not_a_real_pdf')
    digest=hashlib.sha256(data).hexdigest()
    existing=db.scalar(select(Document).where(Document.sha256==digest))
    if existing: return {'document_id':existing.id,'deduplicated':True,'state':existing.state}
    key=f'originals/{digest}/{file.filename or "upload.pdf"}'
    storage.put_bytes(key,data,'application/pdf')
    doc=Document(filename=file.filename or 'upload.pdf',sha256=digest,size_bytes=len(data),storage_key=key,state='UPLOADED')
    db.add(doc); db.commit(); db.refresh(doc)
    return {'document_id':doc.id,'deduplicated':False,'state':doc.state}

@router.post('/documents/process')
def process(req: ProcessRequest, db: Session=Depends(get_db), _token: None=Depends(require_service_token)):
    doc=db.get(Document, req.document_id)
    if not doc: raise HTTPException(404,'document_not_found')
    return process_document(db,doc)

@router.get('/documents/{document_id}')
def document_status(document_id:int, db:Session=Depends(get_db), _token: None=Depends(require_service_token)):
    doc=db.get(Document,document_id)
    if not doc: raise HTTPException(404,'document_not_found')
    pages=db.scalars(select(Page).where(Page.document_id==document_id)).all()
    ad_count=0
    for p in pages:
        ad_count += len(db.scalars(select(AdOccurrence).where(AdOccurrence.page_id==p.id)).all())
    return {'id':doc.id,'filename':doc.filename,'state':doc.state,'page_count':doc.page_count,'ad_candidates':ad_count,'error':doc.error}
