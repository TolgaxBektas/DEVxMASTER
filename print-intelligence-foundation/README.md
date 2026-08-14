# Print Intelligence Foundation

Greenfield FastAPI pipeline for extracting advertisements from German print media.

## Architecture

`app/core` contains settings; `db` and `models` contain SQLAlchemy persistence; `services` contains discovery, download/SSRF checks, local storage, PDF rendering, bounding-box/crop math, parsing, extraction, dedupe, and the synchronous pipeline. Vision is behind `VisionProvider`, with recorded fixtures for CI and Ollama Qwen3-VL for the Mac runtime. `api` exposes health, upload, document, review, discovery, and queue endpoints, and `workers` is the Redis worker entry point.

Pipeline: discover → download → deduplicate → render → classify → detect ads → crop → restore artwork → extract fields → structure → dedupe companies → store → review.

## Configuration and running

Copy `.env.example` to `.env`. Configuration includes `DATABASE_URL`, `STORAGE_BACKEND`, `STORAGE_PATH`, `LOCAL_WORK_DIR`, `S3_ENDPOINT_URL`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION`, `VISION_PROVIDER=recorded|ollama`, `VISION_RECORDED_DIR`, `OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_TIMEOUT`, `VISION_CONSENSUS_RUNS`, `RESTORATION_ENABLED`, `IMAGE_EDIT_PROVIDER=none|recorded|openai`, `IMAGE_EDIT_RECORDED_DIR`, `IMAGE_EDIT_BASE_URL`, `IMAGE_EDIT_MODEL`, `IMAGE_EDIT_API_KEY`, `IMAGE_EDIT_TIMEOUT`, `IMAGE_EDIT_MAX_COST_CENTS`, `IMAGE_EDIT_HARD_STOP_CENTS`, `IMAGE_EDIT_MAX_ATTEMPTS`, `IMAGE_EDIT_COLOR_TOLERANCE`, `RENDER_DPI`, `ARTWORK_DPI`, `ARTWORK_PADDING`, `ARTWORK_TRIM_CAP`, `CONFIDENCE_THRESHOLD`, `MAX_DOWNLOAD_BYTES`, `BBOX_IOU_THRESHOLD`, `MAX_JOB_ATTEMPTS`, `STAGE_TIMEOUT_SECONDS`, `REDIS_URL`, and `REDIS_QUEUE`.

`VISION_CONSENSUS_RUNS` defaults to `1`, preserving the existing single-run
behaviour. Values above one run vision detection repeatedly and retain only
boxes seen in a majority of runs; unstable detections are sent to review.
For multiple runs, stored confidence is a frequency-dominant agreement score
that combines detection frequency with model confidence; it feeds review
thresholds and compatibility-API ad probability and is not directly
comparable with single-run model confidence.

OCR fallback is enabled by default with `OCR_ENABLED=true`. Set
`OCR_ENABLED=false` to disable it, or change `OCR_LANGUAGES` from the default
`deu+eng`; `OCR_CONFIDENCE_THRESHOLD` controls review routing for OCR-derived
fields. OCR requires the Tesseract binary and both language-data packages;
missing local dependencies are logged and skipped without failing ingestion.
Search-backed proposals are disabled unless `SEARXNG_URL` is configured.
`SEARCH_PROVIDER=auto` (the default) enables the SearXNG-compatible provider
when that URL is present; `SEARCH_PROVIDER=none` explicitly disables it.
Search results remain read-only proposals and are subject to the existing SSRF,
robots, rate, and crawl-bound limits.

On the Mac, install Docker Desktop and Ollama, pull `qwen3-vl:4b` (or 8b), set `VISION_PROVIDER=ollama`, then run `docker compose up --build`. Ollama stays outside Compose at `http://host.docker.internal:11434`. The worker can also be run directly with `.venv/bin/python -m app.workers.worker`.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
VISION_PROVIDER=recorded .venv/bin/pytest -q
```

### Discovery

Register an authenticated source with `POST /discovery/sources` using
`{"base_url":"https://example.invalid/","label":"Example","crawl_strategy":"sitemap"}`.
The sitemap strategy starts at `/sitemap.xml` and follows bounded sitemap indexes.
The HTML strategy follows same-host links to a bounded depth and page count. An
optional SearXNG provider can add Germany-wide search-result pages when
`SEARXNG_URL` is configured; search hits retain their query origin and are
validated before any fetch or proposal response. Both
strategies persist normalized PDF candidates, skip candidates already known by URL,
honour `robots.txt`, enforce the SSRF URL checks, and apply
`DISCOVERY_REQUEST_DELAY` between requests to a host. Trigger a crawl with
`POST /discovery/sources/{id}/crawl`; newly found candidates are queued when Redis
is available. Candidate download and content-SHA-256 deduplication happen in the
worker, so a PDF found at another URL reuses the existing document.

### Worker queue

`POST /queue/documents/{document_id}` enqueues a document and
`GET /queue` reports ready depth, in-flight count, dead-letter count, and counters.
Start the worker with:

```bash
.venv/bin/python -m app.workers.worker
```

Redis uses a ready list plus a processing list. Consumption reserves an item,
stale reservations are requeued after `REDIS_VISIBILITY_TIMEOUT`, retries use
bounded exponential backoff, and exhausted items are copied to a dead-letter
list. Duplicate enqueue requests are deduplicated while an item is outstanding.
SIGTERM/SIGINT releases the current reservation before stopping. The synchronous
document API remains available independently of the worker.

### Auftrag forms and restored artwork

Pages with labelled order-form headers are recorded as `is_order_form` pages and
ads on those pages expose the parsed customer header under `form_header`. The
parser accepts extendable label aliases such as `ASP.`/`Ansprechpartner`,
`PLZ/ORT`/`PLZ-Ort`, and `E-MAIL`/`E-mail`. Publisher response/footer data is
excluded using region and label context, with a maintained publisher blocklist
as defence in depth. A contact person belongs to ad-occurrence fields, not the
company deduplication key, so different contacts do not split one company.

Each ad retains its detector crop and may also have a restored artwork artifact.
Restored artwork is rendered from the source PDF at `ARTWORK_DPI` (300 by
default), cropped with `ARTWORK_PADDING`, and stored as lossless PNG. A
conservative trimmed copy is stored separately; the untrimmed copy is retained.
`ARTWORK_TRIM_CAP` is the maximum number of near-white edge pixels removed per
side, not the amount of whitespace to preserve.

`RESTORATION_ENABLED` defaults to `false`. When enabled, the pipeline emits a
separate, pixel-only Level 1 restoration proposal and manifest; it never
replaces the existing artwork. Proposals are review-gated, and uncertain
text-layer, background, or forbidden-content findings are refused rather than
written as a clean result.
Fetch it with `GET /documents/{document_id}/ads/{ad_id}/artwork`. Restoration
proposals are available with `GET /documents/{document_id}/ads/{ad_id}/restoration`
and their manifest with the corresponding `/manifest` endpoint. Restoration
manifests always include `geometry_quality` and a
`qr_detection_unavailable` finding. Geometry quality is marked `assessed` when
restoration analysis ran, including refusals after that analysis. Refusals
before analysis mark it `not_assessed` and retain the QR capability finding
with `action: "review_required"`; these fields do not imply that either
analysis ran.
When a level-one image is produced, an independent verification gate runs
before the image is stored. Its `verification` manifest entry records the
verdict and checks for boundary containment, dimensions, source text anchors,
new content, and duplicated content. A refusal before verification records
`verification.status: "not_assessed"`; it never implies verification passed.
If the pixel-only level-one proposal is refused and `IMAGE_EDIT_PROVIDER` is
configured, exactly one generative cascade stage may receive only the approved
advertisement crop. Its result is composited back into a copy of the artwork;
the outside is therefore unchanged and is checked again. The generative
verifier measures dimensions, boundary containment, OCR-backed communication
anchors (exactly once), absence of new OCR tokens, and dominant quantized
brand colors. If the original is not OCR-assessable, the verdict is
`not_assessed`, never `passed`. A passed generative result is still stored only
with a pending human review item and records provider, model, prompt version
and digest, image hashes, attempt, and cost. A missing provider leaves the
existing pixel-only behavior unchanged. Calls are reserved against
`IMAGE_EDIT_HARD_STOP_CENTS` before execution and fail closed when the next
upper bound would exceed it. The hard stop applies per document run and is
reset when ingestion of a document begins.
Restoration does not upscale source detail, remove backgrounds, sharpen, or add
transparency. Order-form artwork is only exported when the framed advert has
sufficient detector confidence and passes a cheap geometric plausibility check.
We do not detect or prove the visual advert frame; a failed geometric check is
reported as `order-form advert box failed geometric plausibility check`, while
low detector confidence remains a separate `low confidence` review reason.

## Remaining limitations

Coarse 0–1000 bounding boxes and duplicated or clipped glyph copies in source PDFs make text-layer attribution approximate at ad-box boundaries. The page-11 AWO extraction still contains garbled fragments from the source PDF's duplicated text layer.

Authentication requires `SERVICE_TOKEN` in deployed environments. Set `AUTH_DISABLED=true` only for explicit local development. Uploads are streamed and capped before pipeline processing. URL downloads validate every resolved A/AAAA address and every redirect target, including reserved, link-local, unspecified, multicast, and IPv4-mapped addresses. httpx connection pinning is not currently practical here, so a DNS-rebinding race remains a residual risk. Ollama inference was exercised against a real `qwen3-vl:4b` on CPU: the provider, availability check, and parser handle real responses, but detection is not deterministic across repeated calls — repeated page-11 runs varied between the correct four regions, duplicated or mislocalized boxes, and misspelled company names, and a non-ad page produced a false positive. The real vision path is therefore usable only with the review queue as a safeguard, and it has not been evaluated on a GPU or across a full document. Discovery does not persist a complete per-request crawl log; malformed pages and dead links are tolerated and candidate download failures are retained on the candidate. Redis queue counters are process-agnostic Redis counters, but alerting and operational dead-letter replay policy remain deployment concerns. S3/MinIO storage is implemented behind the storage interface, while artifact lifecycle/retention policies remain deployment concerns. The OpenAI-compatible image-edit provider is opt-in and requires an API key; recorded fixtures remain the deterministic test path. Text-layer extraction is deterministic where the PDF has text; image-only ads still depend on the configured vision provider or review. Stage deadlines are cooperative and checked between pages/advertisements; long-running single operations cannot be forcibly interrupted.
Embedded PDF image extraction is deliberately not used for restored artwork:
the measured documents compose ads from multiple XObjects and vector content,
while some ads are vector-only. High-DPI page rendering plus cropping is the
correctness path. Deskew, transparency, background removal, sharpening, and
automatic artwork reconstruction are intentionally left out.

## Changelog

### Real Ollama verification

- Structured requests send `think: false`; Qwen otherwise spends the generation budget on prose and truncates before emitting JSON.
- Detections accept `bbox` and `bbox_2d`, coerce string coordinates, and drop malformed boxes instead of failing downstream normalization.

### Pipeline core hardening

- Added lifespan-based FastAPI startup and separated health, document, and review routers.
- Added Redis queue health/consumption, S3/MinIO storage, URL ingestion, reprocessing, and real Alembic DDL.
- Added resumable per-document stage jobs with retry/dead transitions and timeouts.
- Added PDF text-layer extraction per advertisement, deterministic recorded crop fields, and heuristic page classification.
- Expanded parser, bbox, job, API, and page-11 regression coverage.
