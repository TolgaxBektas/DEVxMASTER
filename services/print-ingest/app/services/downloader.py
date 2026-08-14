import hashlib, mimetypes
from urllib.parse import urljoin, urlparse
import requests
from app.core.config import settings
from app.services.policy import check_url_policy, close_checked_response, request_checked

class DownloadError(RuntimeError):
    pass

def download_pdf(url: str, *, max_redirects: int | None = None) -> tuple[bytes, dict]:
    policy = check_url_policy(url)
    if policy['status'] != 'APPROVED':
        raise DownloadError(f"policy blocked: {policy['reason']}")
    max_bytes = settings.max_download_mb * 1024 * 1024
    headers = {'User-Agent': settings.crawl_user_agent, 'Accept': 'application/pdf,*/*;q=0.8'}
    with request_checked(
        url,
        policy=policy,
        stream=True,
        timeout=settings.request_timeout_seconds,
        headers=headers,
        allow_redirects=False,
    ) as r:
        if r.is_redirect or r.is_permanent_redirect:
            target = r.headers.get('location')
            if not target:
                raise DownloadError('redirect_without_location')
            remaining = settings.max_redirects if max_redirects is None else max_redirects
            if remaining <= 0:
                raise DownloadError('redirect_limit_exceeded')
            target = urljoin(url, target)
            target_policy = check_url_policy(target)
            if target_policy['status'] != 'APPROVED':
                raise DownloadError(f"policy blocked: {target_policy['reason']}")
            close_checked_response(r)
            return download_pdf(target, max_redirects=remaining - 1)
        r.raise_for_status()
        chunks=[]; total=0
        for chunk in r.iter_content(1024*1024):
            if not chunk: continue
            total += len(chunk)
            if total > max_bytes:
                raise DownloadError('file_too_large')
            chunks.append(chunk)
    data=b''.join(chunks)
    close_checked_response(r)
    if not data.startswith(b'%PDF-'):
        raise DownloadError('not_a_real_pdf_signature')
    digest=hashlib.sha256(data).hexdigest()
    filename=urlparse(str(r.url)).path.rsplit('/',1)[-1] or f'{digest}.pdf'
    if not filename.lower().endswith('.pdf'): filename += '.pdf'
    return data, {'sha256': digest, 'filename': filename, 'size_bytes': len(data), 'final_url': str(r.url)}
