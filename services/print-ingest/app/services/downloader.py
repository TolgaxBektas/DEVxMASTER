import hashlib, re
import threading
import time
from urllib.parse import urljoin, urlparse
import requests
from app.core.config import settings
from app.services.policy import check_url_policy, close_checked_response, request_checked

class DownloadError(RuntimeError):
    pass

ARCHIVE_DOWNLOAD_TIMEOUT_SECONDS = 120
ARCHIVE_REQUEST_DELAY_SECONDS = 1.0
ARCHIVE_RETRY_DELAYS_SECONDS = (1.0, 2.0)
ARCHIVE_REQUEST_LOCK = threading.Lock()


def _archive_error_is_retryable(error: BaseException) -> bool:
    if isinstance(error, requests.RequestException):
        return True
    return isinstance(error, DownloadError) and str(error).startswith("http_5")


def _header(response: requests.Response, name: str) -> str:
    name = name.lower()
    return next(
        (str(value) for key, value in response.headers.items() if key.lower() == name),
        "",
    )


def download_pdf(
    url: str,
    *,
    archive_url: str | None = None,
    archive_length: int | None = None,
    max_redirects: int | None = None,
    _origin: str | None = None,
) -> tuple[bytes, dict]:
    max_bytes = settings.max_download_mb * 1024 * 1024
    headers = {'User-Agent': settings.crawl_user_agent, 'Accept': 'application/pdf,*/*;q=0.8'}
    attempts = [(
        url,
        _origin or "live",
    )]
    if archive_url and _origin != "archive":
        attempts.append((archive_url, "archive"))
    last_error = "Quellenabruf fehlgeschlagen"
    for candidate_url, origin in attempts:
        archive_attempts = len(ARCHIVE_RETRY_DELAYS_SECONDS) + 1 if origin == "archive" else 1
        for archive_attempt in range(archive_attempts):
            response = None
            archive_lock_held = False
            try:
                policy = check_url_policy(candidate_url)
                if policy['status'] != 'APPROVED':
                    raise DownloadError(f"policy blocked: {policy['reason']}")
                if origin == "archive":
                    ARCHIVE_REQUEST_LOCK.acquire()
                    archive_lock_held = True
                response = request_checked(
                    candidate_url,
                    policy=policy,
                    stream=True,
                    timeout=(
                        ARCHIVE_DOWNLOAD_TIMEOUT_SECONDS
                        if origin == "archive"
                        else settings.request_timeout_seconds
                    ),
                    headers=headers,
                    allow_redirects=False,
                    max_redirects=max_redirects,
                )
                if response.is_redirect or response.is_permanent_redirect:
                    location = _header(response, "Location")
                    remaining = settings.max_redirects if max_redirects is None else max_redirects
                    if not location or remaining <= 0:
                        raise DownloadError("redirect_limit_exceeded")
                    close_checked_response(response)
                    response = None
                    if archive_lock_held:
                        ARCHIVE_REQUEST_LOCK.release()
                        archive_lock_held = False
                    return download_pdf(
                        urljoin(candidate_url, location),
                        archive_url=archive_url,
                        archive_length=archive_length,
                        max_redirects=remaining - 1,
                        _origin=origin,
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
                content_length = _header(response, "Content-Length")
                if content_length and content_length.isdigit() and int(content_length) != len(data):
                    raise DownloadError(
                        f"download_truncated: content-length {content_length}, received {len(data)}",
                    )
                if origin == "archive":
                    warning = _header(response, "Warning").lower()
                    crawler_length = _header(
                        response,
                        "X-Archive-Orig-X-Crawler-Content-Length",
                    )
                    if "content truncated" in warning:
                        raise DownloadError(
                            f"download_truncated: archive warning {warning}",
                        )
                    if crawler_length.isdigit() and int(crawler_length) > len(data):
                        raise DownloadError(
                            "download_truncated: archive crawler-content-length "
                            f"{crawler_length}, received {len(data)}",
                        )
                if not data.startswith(b'%PDF-'):
                    raise DownloadError('not_a_real_pdf_signature')
                digest=hashlib.sha256(data).hexdigest()
                filename=urlparse(str(response.url)).path.rsplit('/',1)[-1] or f'{digest}.pdf'
                if not filename.lower().endswith('.pdf'):
                    filename += '.pdf'
                archive_match = re.search(r"/web/(20\d{12})id_/", candidate_url)
                metadata = {
                    'sha256': digest,
                    'filename': filename,
                    'size_bytes': len(data),
                    'final_url': str(response.url),
                    'origin': 'source-live' if origin == 'live' else (
                        f"source-archive-{archive_match.group(1) if archive_match else 'unknown'}"
                    ),
                }
                if origin == "archive" and archive_length is not None:
                    metadata["archive_index_length"] = archive_length
                return data, metadata
            except (DownloadError, requests.RequestException, RuntimeError) as error:
                last_error = f"{origin}_fetch_failed: {error}" if str(error) else f"{origin}_fetch_failed: unknown_error"
                if (
                    origin != "archive"
                    or archive_attempt >= archive_attempts - 1
                    or not _archive_error_is_retryable(error)
                ):
                    break
                time.sleep(max(
                    ARCHIVE_REQUEST_DELAY_SECONDS,
                    ARCHIVE_RETRY_DELAYS_SECONDS[archive_attempt],
                ))
            finally:
                if response is not None:
                    close_checked_response(response)
                if archive_lock_held:
                    ARCHIVE_REQUEST_LOCK.release()
    raise DownloadError(last_error)
