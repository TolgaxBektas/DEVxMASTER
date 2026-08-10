import hashlib, mimetypes
from urllib.parse import urlparse
import requests
from app.core.config import settings
from app.services.policy import check_url_policy

class DownloadError(RuntimeError):
    pass

def download_pdf(url: str) -> tuple[bytes, dict]:
    policy = check_url_policy(url)
    if policy['status'] != 'APPROVED':
        raise DownloadError(f"policy blocked: {policy['reason']}")
    max_bytes = settings.max_download_mb * 1024 * 1024
    headers = {'User-Agent': settings.crawl_user_agent, 'Accept': 'application/pdf,*/*;q=0.8'}
    with requests.get(url, stream=True, timeout=settings.request_timeout_seconds, headers=headers, allow_redirects=False) as r:
        if r.is_redirect or r.is_permanent_redirect:
            target = r.headers.get('location')
            if not target:
                raise DownloadError('redirect_without_location')
            redirect_policy = check_url_policy(target)
            if redirect_policy['status'] != 'APPROVED':
                raise DownloadError(f"policy blocked: {redirect_policy['reason']}")
            return download_pdf(target)
        r.raise_for_status()
        chunks=[]; total=0
        for chunk in r.iter_content(1024*1024):
            if not chunk: continue
            total += len(chunk)
            if total > max_bytes:
                raise DownloadError('file_too_large')
            chunks.append(chunk)
    data=b''.join(chunks)
    if not data.startswith(b'%PDF-'):
        raise DownloadError('not_a_real_pdf_signature')
    digest=hashlib.sha256(data).hexdigest()
    filename=urlparse(str(r.url)).path.rsplit('/',1)[-1] or f'{digest}.pdf'
    if not filename.lower().endswith('.pdf'): filename += '.pdf'
    return data, {'sha256': digest, 'filename': filename, 'size_bytes': len(data), 'final_url': str(r.url)}
