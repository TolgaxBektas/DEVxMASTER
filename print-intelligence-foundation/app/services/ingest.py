from contextlib import contextmanager
from threading import Lock
from typing import Iterator

import pypdfium2 as pdfium

_locks: dict[str, Lock] = {}
_locks_guard = Lock()


def validate_pdf(data: bytes) -> None:
    pdf = None
    try:
        pdf = pdfium.PdfDocument(data)
        if len(pdf) == 0:
            raise ValueError("PDF contains no pages")
        pdf[0]
    except Exception as exc:
        raise ValueError("uploaded file is not a valid, loadable PDF") from exc
    finally:
        if pdf is not None:
            pdf.close()


@contextmanager
def content_lock(digest: str) -> Iterator[None]:
    with _locks_guard:
        lock = _locks.setdefault(digest, Lock())
    with lock:
        yield
