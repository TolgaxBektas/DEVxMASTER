from contextlib import contextmanager
from pathlib import Path
from threading import Lock
from typing import Iterator

import pypdfium2 as pdfium


_PDFIUM_LOCK = Lock()


@contextmanager
def open_document(source: str | Path | bytes) -> Iterator[object]:
    with _PDFIUM_LOCK:
        document = pdfium.PdfDocument(source)
        try:
            yield document
        finally:
            document.close()
