from contextlib import contextmanager
from threading import Lock
from typing import BinaryIO, Iterator

from app.services.pdfium import open_document

_locks: dict[str, Lock] = {}
_locks_guard = Lock()


class UploadTooLargeError(ValueError):
    """Raised when an uploaded stream exceeds the configured byte limit."""


def read_limited(stream: BinaryIO, max_bytes: int) -> bytes:
    data = bytearray()
    while chunk := stream.read(1024 * 1024):
        data.extend(chunk)
        if len(data) > max_bytes:
            raise UploadTooLargeError("file too large")
    return bytes(data)


def validate_pdf(data: bytes) -> None:
    try:
        with open_document(data) as pdf:
            if len(pdf) == 0:
                raise ValueError("PDF contains no pages")
            pdf[0]
    except Exception as exc:
        raise ValueError("uploaded file is not a valid, loadable PDF") from exc


@contextmanager
def content_lock(digest: str) -> Iterator[None]:
    with _locks_guard:
        lock = _locks.setdefault(digest, Lock())
    with lock:
        yield
