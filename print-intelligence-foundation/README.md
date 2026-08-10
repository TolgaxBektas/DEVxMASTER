# Print Intelligence Foundation

Greenfield FastAPI pipeline for extracting advertisements from German print media.

## Architecture

`app/core` contains settings; `db` and `models` contain SQLAlchemy persistence; `services` contains discovery, download/SSRF checks, local storage, PDF rendering, bounding-box/crop math, parsing, extraction, dedupe, and the synchronous pipeline. Vision is behind `VisionProvider`, with recorded fixtures for CI and Ollama Qwen3-VL for the Mac runtime. `api` exposes health, upload, document and review endpoints, and `workers` is the Redis worker entry point.

Pipeline: discover → download → deduplicate → render → classify → detect ads → crop → extract fields → structure → dedupe companies → store → review.

## Configuration and running

Copy `.env.example` to `.env`. Configuration includes `DATABASE_URL`, `STORAGE_BACKEND`, `STORAGE_PATH`, `LOCAL_WORK_DIR`, `S3_ENDPOINT_URL`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION`, `VISION_PROVIDER=recorded|ollama`, `VISION_RECORDED_DIR`, `OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_TIMEOUT`, `RENDER_DPI`, `CONFIDENCE_THRESHOLD`, `MAX_DOWNLOAD_BYTES`, `BBOX_IOU_THRESHOLD`, `MAX_JOB_ATTEMPTS`, `STAGE_TIMEOUT_SECONDS`, `REDIS_URL`, and `REDIS_QUEUE`.

On the Mac, install Docker Desktop and Ollama, pull `qwen3-vl:4b` (or 8b), set `VISION_PROVIDER=ollama`, then run `docker compose up --build`. Ollama stays outside Compose at `http://host.docker.internal:11434`.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
VISION_PROVIDER=recorded .venv/bin/pytest -q
```

## Remaining limitations

Coarse 0–1000 bounding boxes and duplicated or clipped glyph copies in source PDFs make text-layer attribution approximate at ad-box boundaries. The page-11 AWO extraction still contains garbled fragments from the source PDF's duplicated text layer.

Authentication requires `SERVICE_TOKEN` in deployed environments. Set `AUTH_DISABLED=true` only for explicit local development. Uploads are streamed and capped before pipeline processing. URL downloads validate every resolved A/AAAA address and every redirect target, including reserved, link-local, unspecified, multicast, and IPv4-mapped addresses. httpx connection pinning is not currently practical here, so a DNS-rebinding race remains a residual risk. Ollama inference is not exercised on this VM because it has no Ollama service or GPU. Discovery remains a modest HTML PDF-link finder rather than a full sitemap crawler. Redis queue consumption is implemented, but production scheduling/observability and dead-letter operations still need deployment policy. S3/MinIO storage is implemented behind the storage interface, while artifact lifecycle/retention policies remain deployment concerns. No OpenAI provider is implemented. Text-layer extraction is deterministic where the PDF has text; image-only ads still depend on the configured vision provider or review. Stage deadlines are cooperative and checked between pages/advertisements; long-running single operations cannot be forcibly interrupted.

## Changelog

### Pipeline core hardening

- Added lifespan-based FastAPI startup and separated health, document, and review routers.
- Added Redis queue health/consumption, S3/MinIO storage, URL ingestion, reprocessing, and real Alembic DDL.
- Added resumable per-document stage jobs with retry/dead transitions and timeouts.
- Added PDF text-layer extraction per advertisement, deterministic recorded crop fields, and heuristic page classification.
- Expanded parser, bbox, job, API, and page-11 regression coverage.
