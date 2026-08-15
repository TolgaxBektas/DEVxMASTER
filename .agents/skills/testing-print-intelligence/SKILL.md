---
name: testing-print-intelligence
description: How to run and end-to-end test the print-intelligence-foundation FastAPI ad-extraction service locally (recorded vision provider, SQLite + filesystem storage) and via docker compose.
---

# Testing the print-intelligence-foundation service

## Local API run (fastest, no Postgres/Redis/MinIO needed)

```bash
cd print-intelligence-foundation
python3 -m venv .venv-test && .venv-test/bin/pip install -r requirements.txt
mkdir -p /tmp/pif/data /tmp/pif/work
export VISION_PROVIDER=recorded \
       STORAGE_BACKEND=filesystem STORAGE_PATH=/tmp/pif/data \
       LOCAL_WORK_DIR=/tmp/pif/work \
       DATABASE_URL=sqlite:////tmp/pif/pif.db \
       SERVICE_TOKEN=test-token-abc123
.venv-test/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
```

- The app **refuses to start** without `SERVICE_TOKEN` unless `AUTH_DISABLED=true`
  (`RuntimeError: SERVICE_TOKEN must be configured...`). That is intended behaviour.
- `/health` is public; `/documents/*` and `/review-queue/*` need
  `Authorization: Bearer $SERVICE_TOKEN`.
- `/health` returns `status: degraded` (HTTP 200, never 500) when Redis or the vision provider
  is unreachable — use a second instance with `VISION_PROVIDER=ollama` on another port to see
  `"vision": false` without needing a GPU.
- Ollama/Qwen3-VL inference cannot be tested on a box without Ollama/GPU; only the degraded
  health path is verifiable there.

## Fixture facts worth knowing

- `tests/fixtures/Seniorenpost_Mai_Juni_2026.pdf` is 44 pages; the recorded vision provider only
  has `tests/fixtures/qwen/page_11.json`, so a correct run yields **exactly 4 ads, all on page 11**:
  Grau & Sohn, Altenzentrum Wetzlar-Pariser Gasse, AWO Kreisverband Lahn-Dill e.V., Pietät Ulm.
- The Altenzentrum ad is a raster image with no text layer → legitimately has only `company`
  and lands in the review queue with reason `incomplete contact fields`.
- The recorded provider is keyed **only by page number**, so any other PDF with ≥11 pages will
  produce the same page-11 ads. To test the "no fixture → 0 ads" path use a PDF with fewer than
  11 pages (e.g. a 1-page dummy PDF).
- Crops land in `$STORAGE_PATH/<sha256>/crops/page_11_<n>.png`; check `md5sum` of the four files
  to prove they are genuinely different regions, and view them side by side in a browser via
  `file:///path/to/sheet.png` if you need visual evidence.

## Useful inspection queries

```bash
sqlite3 /tmp/pif/pif.db "select stage,state,attempts,error from jobs order by id"
sqlite3 /tmp/pif/pif.db "select count(*) from pages; select count(*) from ad_occurrences"
```
Idempotent state for one upload of the fixture: documents 1, pages 44, ad_occurrences 4,
companies 4, jobs 6, review_items 1 — re-upload and `POST /documents/{id}/reprocess` must not
change these.

## Testing the crash/resume path

Always use a **fresh DB** for the kill test: the script that waits for
`select state from jobs where stage='render'` will fire instantly if an earlier document already
left a succeeded render job, and the kill then happens after the pipeline is done (silent
false pass). Start an upload, poll every 0.1 s, `kill -9` uvicorn as soon as render succeeds,
then restart and re-upload the same PDF. Verify pages == 44 and all ads still on page **11**
(the resume path globs `page_*.png`, where lexicographic order ≠ numeric order).

## docker compose

`docker compose` needs env-provided credentials; write a `.env` based on `.env.example` plus
`POSTGRES_PASSWORD`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `SERVICE_TOKEN`. All five services
come up healthy and `/health` reports `status: ok` with `redis: true`.
Caveat: the API image runs as non-root `appuser` while `.env.example` sets
`LOCAL_WORK_DIR=/work/print-intelligence` with no writable volume, so uploads may fail with
`PermissionError: [Errno 13] Permission denied: '/work'`. Workaround: point `LOCAL_WORK_DIR`
at a writable path such as `/tmp/work` (or add a volume/`mkdir`+`chown` in the Dockerfile).
Also free port 8000 (stop any local uvicorn) before `docker compose up`.

## Testing discovery (crawler) without touching real websites

Never crawl real municipal sites. Stand up a local fixture site instead, but note the crawler
runs every request through the SSRF validator, which rejects loopback/private/link-local
targets — so a server on `127.0.0.1` is unreachable *by design*. Workaround: bind the fixture
server to a carbon-grade shared address that Python does not classify as private, e.g.

```bash
sudo ip addr add 100.64.0.7/32 dev lo
cd /tmp/site && python3 -m http.server 8080 --bind 100.64.0.7
```

A good fixture site contains: `robots.txt` with a `Disallow:` path, an index page, a nested
page, a dead PDF link (404), the same PDF served under two different URLs (proves content
sha256 dedupe → one document), a `sitemap.xml` sitemapindex pointing at a valid child and a
malformed child, and links to `127.0.0.1` / `169.254.169.254` / `10.0.0.5` (must never be
fetched — verify against the fixture server's access log, not just the candidate list).

Route caveat: `POST /discovery/sources/{id}/crawl` may be **shadowed** by the
`POST /discovery/sources/{id}/{action}` route declared before it (returns
`400 action must be enable or disable`). If so, drive crawls with `POST /discovery/crawl`
(all enabled sources) and isolate a source by disabling the others.

## Testing the Redis queue and worker

Use a real Redis (`docker run -d --name pif-redis -p 6379:6379 redis:7-alpine`); `docker compose`
interpolates required MinIO/Postgres env vars before starting even a single service, so a
standalone container is cheaper. Give each API instance its own `REDIS_QUEUE` and shorten
`REDIS_VISIBILITY_TIMEOUT=5`, `REDIS_BACKOFF_SECONDS=1` so recovery/backoff is observable.
Run the worker with the same env as the API: `python -m app.workers.worker`.

- Kill-mid-item: an already-processed document re-processes in well under a second (succeeded
  jobs are skipped), so log-polling then `kill -9` always fires too late. Instead enqueue work
  that is genuinely new and kill based on progress, e.g. poll
  `ls $LOCAL_WORK_DIR/*/pages/*.png | wc -l` and kill at ~6 of 44.
- Poison item for the dead-letter path: you need a job row that actually fails. Pre-create
  `$LOCAL_WORK_DIR/<sha256-of-pdf>/pages` with `chmod 500`, then upload that PDF — render fails
  with `PermissionError`, leaving a `failed` render job to enqueue and watch die.

## Order forms and restored artwork

`tests/test_order_forms.py::_pdf` is a handy synthetic-PDF builder (list of pages, each a list
of text lines) — import it to craft adversarial forms (publisher-only header, publisher email
next to a label, empty value cell, ordinary ad page).
Point an instance at a custom recorded-vision dir with `VISION_RECORDED_DIR=/path/to/qwen`
containing `page_<n>.json` with `{"advertisements":[{"company_name":…,"bbox":[l,t,r,b],
"image_size":[w,h],"confidence":…}]}`; at the default `render_dpi=120` a 612x792pt page is
1020x1320 px. A box covering nearly the whole sheet on an order-form page must be rejected by
the plausibility gate (review reason `order-form advert box failed geometric plausibility
check`, artwork endpoint 404); a box with area ratio ≤0.75, top ≥12% and bottom ≤92% of the
page passes.
Artwork lands in `$STORAGE_PATH/<sha>/artwork/page_<n>_<i>.png` plus `_trimmed.png`
(8 files for the 4 page-11 ads) and is served by
`GET /documents/{id}/ads/{ad_id}/artwork`. Expect ~2.5x the crop resolution (300/120 DPI).

## Known fragile areas to probe

- Malformed uploads (non-PDF bytes, 0-byte, truncated PDF) may return HTTP 500 from an uncaught
  `pypdfium2 PdfiumError` and still persist a Document row plus a failed render job.
- Crawl-ingested documents interrupted mid-pipeline may never converge: the queue requeues the
  stale in-flight item, but `DiscoveryCrawler.process_candidate()` finds the half-written
  Document by content sha256 and marks the candidate `skipped` without resuming the pipeline,
  leaving 0 pages and a `render` job stuck in `running`. Workaround for testing/recovery:
  `POST /queue/documents/{id}` (the document path does resume). Always check pages/ads counts
  after a kill test, not just the queue counters.
- Concurrent duplicate uploads of the same PDF can fail with 500s and have crashed the process
  with `malloc(): unsorted double linked list corrupted` (pypdfium2 is not thread-safe across
  the same document). Run each concurrency attempt against a fresh instance and check `pgrep`
  afterwards to see whether the server survived.

## Testing the real Ollama vision path

If `ollama` is installed on the box (`systemctl is-active ollama`, `ollama list` should show
`qwen3-vl:4b`), the real provider can be exercised — but note the config default is
`ollama_url = http://host.docker.internal:11434`, which does **not** resolve outside Docker.
Always override it:

```bash
OLLAMA_URL=http://127.0.0.1:11434 OLLAMA_MODEL=qwen3-vl:4b OLLAMA_TIMEOUT=600 \
STAGE_TIMEOUT_SECONDS=1200 VISION_PROVIDER=ollama ... uvicorn app.main:app --port 8200
```

- CPU-only inference costs roughly 15–50 s per `detect_ads`/`extract_fields` call, so a
  44-page document is impractical. Build a **single-page PDF** instead and upload that:
  `pdfium.PdfDocument.new()` + `import_pages(src, [10])` gives page 11 as a 1-page file.
- Direct provider calls are the cheapest way to measure variance:
  `OllamaVisionProvider('http://127.0.0.1:11434','qwen3-vl:4b').detect_ads(png, page)`.
  Compare boxes against the human-verified page-11 ground truth with `app.services.bbox.iou`.
- Expected behaviour, not a bug: names vary between repeats (`Beerdigungsinsitut`,
  `PIETÄT UL M`, `Wetzar`), boxes wander by a few percent (IoU ~0.85–0.96 vs ground truth),
  and the cover page yields a consistent false positive. The model returns no `confidence`,
  so every ollama-detected ad lands in the review queue as `low confidence`, and
  model-extracted fields are noisier than the PDF text layer.

## Recorded-fixture gotchas (cost hours if missed)

- Fixture `bbox` values are interpreted as **0–1000 normalised** coordinates unless the
  detection also carries `image_size` (`app/services/bbox.py:normalize_bbox`). A fixture box
  of `[100,200,800,900]` becomes `102,264,816,1188` on a 1020x1320 render.
- The order-form plausibility gate (`pipeline._order_form_box_is_plausible`) rejects boxes with
  `top < 12 %` or `bottom > 92 %` of page height, area > 75 %, width > 95 %, height > 82 %.
  To test the *positive* case use something like `[100,200,800,900]`; anything hugging the top
  edge is rejected and the ad gets no artwork.
- After editing fixtures you must **delete the SQLite DB, storage and work dirs** and restart
  the API. Re-uploading the same PDF hits the sha256 dedupe and returns the old document with
  the old bboxes, which looks exactly like the new fixture having no effect.
- `pkill -f "port 8300"` also matches the shell running the command and kills your own session.
  Resolve the pid instead:
  `PID=$(ss -ltnp | grep ':8300' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)`.
- Before any kill/resume test, kill whatever is already listening on the target port. A stale
  instance keeps the port and an open handle on the deleted DB, so your requests silently hit
  the old process and the test passes without ever exercising the resume path.

## Probing native aborts and handle leaks (PDFium)

CI has aborted with `Trace/breakpoint trap (core dumped)` / exit 133 *after* pytest reported
success. To probe it, run the suite several times capturing the shell status of each run
separately (`rc=$?`) and grep the output for `core dumped|Trace/breakpoint|Aborted|malloc\(\)`.
For leaks, hammer `POST /documents/{id}/reprocess` (each call re-renders every page) and watch
the API process: `ls /proc/<pid>/fd | wc -l` and `VmRSS` from `/proc/<pid>/status`. A healthy
run keeps the FD count flat (e.g. 16) and RSS within a few hundred kB over a dozen rounds.

## Testing the Data-Factory import endpoint (`POST /imports/print-batch`)

The endpoint takes two file parts (`original`, `restored`) plus a **plain form field**
`metadata` holding the JSON as a *string*. With curl, `-F "metadata=@file.json"` is wrong and
fails with `422 {"detail":[{"type":"string_type","loc":["body","metadata"]...}]}`; use
`-F "metadata=<file.json"` (or `-F "metadata=$(cat file.json)"`).

Real cases live under `/home/ubuntu/run50/kunden/<case>/` (`original.png`, `restauriert.png`,
`restaurierung.json`, `evidence.json`, `plan.json`). A valid metadata body can be assembled from
them: `prompt_hash`, `usage`, `cost`, `output_size` (= `requested_size`) come from
`restaurierung.json`, `evidence` from `evidence.json`, `plan_digest` can be any non-empty string
(e.g. the sha256 of `plan.json`). Do **not** read `.project-config.json` from the AnzeigenWerk
folder — it holds credentials.

- The returned `artwork_url` / `restoration_url` serve the stored bytes verbatim
  (`app/api/documents.py:134-167`), so `sha256` of the download must equal the source file's —
  that is the cheapest proof the two uploads were not swapped or truncated.
- The identity/idempotency key is `sha256(company_name + source + bbox)`; changing *only* the
  company spelling creates a **new document** but must reuse the existing company row.
- Fragile area found in PR #20: production `SessionLocal` is built with **`autoflush=False`**
  (`app/db/session.py:12`), so a freshly `session.add()`-ed `AdOccurrence` has `id is None`
  until something flushes. When the company already exists (no `session.flush()` in that branch)
  the `ReviewItem` is stored with `ad_id = NULL` and a later re-import inserts a *second* review
  row for the same ad. The unit tests miss this because `tests/test_print_batch_import.py`
  builds its own `sessionmaker(...)` with the default `autoflush=True`. When testing anything
  that creates rows in one request, always assert on the DB (`select id, ad_id from
  review_items`) with the *real* app session, not only on the HTTP response.
- `max_download_bytes` defaults to 50 MB; a 51 MB part must yield `413 {"detail":"file too
  large"}` in ~0.1 s. Check *both* parts — the original and the restored image are two separate
  `read_limited` call sites.
- `source.page` is a `PositiveInt`: missing / `null` / `"vier"` / `0` / `-3` must all give
  `422 {"detail":"invalid print-batch metadata"}` with unchanged row counts.

## Reaching the generative restoration manifest without a real model

`generative.normalization` (incl. `normalized_size`) is only written by
`pipeline._try_generative_restoration`, i.e. **not** by the import endpoint (there the manifest is
whatever the client posted). To see it locally, run an instance with
`RESTORATION_ENABLED=true IMAGE_EDIT_PROVIDER=recorded IMAGE_EDIT_RECORDED_DIR=<dir>`, upload the
Seniorenpost fixture, and read the manifest: the first run reports
`generative.reason = "image edit provider failed: recorded image edit fixture is missing:
<digest>"`. Write `<dir>/<digest>.json` = `{"image":"stub.png","model":"stub-image-model",
"reported_cost":100}` plus any PNG, then `POST /documents/{id}/reprocess`. Even when the stub has
the wrong dimensions (verification `failed`) the manifest still contains the full
`normalization` block. Note `IMAGE_EDIT_HARD_STOP_CENTS` (default 100) stops after the first ad,
so raise it if you need more than one.

## Devin Secrets Needed

None — everything runs locally with a self-chosen `SERVICE_TOKEN`.
