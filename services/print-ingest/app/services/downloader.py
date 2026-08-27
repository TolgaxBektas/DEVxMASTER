import hashlib, re
from urllib.parse import urljoin, urlparse
import requests
from app.core.config import settings
from app.services.policy import check_url_policy, close_checked_response, request_checked

class DownloadError(RuntimeError):
    pass

def download_pdf(
    url: str,
    *,
    archive_url: str | None = None,
    max_redirects: int | None = None,
) -> tuple[bytes, dict]:
    max_bytes = settings.max_download_mb * 1024 * 1024
    headers = {'User-Agent': settings.crawl_user_agent, 'Accept': 'application/pdf,*/*;q=0.8'}
    attempts = [(url, "live")]
    if archive_url:
        attempts.append((archive_url, "archive"))
    last_error = "Quellenabruf fehlgeschlagen"
    for candidate_url, origin in attempts:
        try:
            policy = check_url_policy(candidate_url)
            if policy['status'] != 'APPROVED':
                raise DownloadError(f"policy blocked: {policy['reason']}")
            response = request_checked(
                candidate_url,
                policy=policy,
                stream=True,
                timeout=settings.request_timeout_seconds,
                headers=headers,
                allow_redirects=False,
                max_redirects=max_redirects,
            )
            try:
                if response.is_redirect or response.is_permanent_redirect:
                    location = response.headers.get("location")
                    remaining = settings.max_redirects if max_redirects is None else max_redirects
                    if not location or remaining <= 0:
                        raise DownloadError("redirect_limit_exceeded")
                    close_checked_response(response)
                    return download_pdf(
                        urljoin(candidate_url, location),
                        archive_url=archive_url,
                        max_redirects=remaining - 1,
                    )
                if response.status_code >= 400:
                    raise DownloadError(f"http_{response.status_code}")
                chunks=[]; total=0
                for chunk in response.iter_content(1024*1024):
                    if not chunk:
                        continue
                    total += len(chunk)
                    if total > max_bytes:
                        raise DownloadError('file_too_large')
                    chunks.append(chunk)
                data=b''.join(chunks)
                if not data.startswith(b'%PDF-'):
                    raise DownloadError('not_a_real_pdf_signature')
                digest=hashlib.sha256(data).hexdigest()
                filename=urlparse(str(response.url)).path.rsplit('/',1)[-1] or f'{digest}.pdf'
                if not filename.lower().endswith('.pdf'):
                    filename += '.pdf'
                metadata = {
                    'sha256': digest,
                    'filename': filename,
                    'size_bytes': len(data),
                    'final_url': str(response.url),
                    'origin': 'source-live' if origin == 'live' else (
                        f"source-archive-{(re.search(r'/web/(20\d{12})id_/', candidate_url) or [None, 'unknown'])[1]}"
                    ),
                }
                return data, metadata
            finally:
                close_checked_response(response)
        except (DownloadError, requests.RequestException, RuntimeError) as error:
            last_error = str(error)
    raise DownloadError(last_error)
