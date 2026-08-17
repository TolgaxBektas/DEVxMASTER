FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tesseract-ocr \
        tesseract-ocr-deu \
        tesseract-ocr-eng \
        fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir -r requirements.txt
COPY app app
COPY tests tests
COPY alembic alembic
COPY alembic.ini .
RUN useradd --create-home appuser \
    && mkdir -p /work/print-intelligence \
    && chown -R appuser:appuser /work
USER appuser
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0"]
