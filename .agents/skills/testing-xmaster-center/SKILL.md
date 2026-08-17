---
name: testing-xmaster-center
description: How to bring up and end-to-end test the xMaster Center monorepo (system/crm/billing/ingestion/assistant modules) locally, including login, ports, DB inspection and known test-fixture traps.
---

# Testing xMaster Center locally

## Bring up the stack
Node on the box is 20.18.1 and corepack is broken — always call pnpm as
`npm exec --yes pnpm@10.4.1 -- <command>`. Vite warns about the Node version but works.

```bash
cd /home/ubuntu/repos/xmaster-center
docker compose up -d              # mysql :3307, print-ingest 127.0.0.1:8010, minio :9000/:9001 (bucket xmaster-center auto-created)
export DATABASE_URL=mysql://xmaster:xmaster_dev_password@127.0.0.1:3307/xmaster_center
export JWT_SECRET=replace-with-a-long-random-secret   # must match the stored admin secret_hash
export PUBLIC_APP_ORIGIN=http://localhost:3020 ADMIN_PIN=1907 PORT=3010
# storage + stateless PDF machine (without these the upload route fails)
export S3_ENDPOINT=http://127.0.0.1:9000 S3_ACCESS_KEY=minioadmin S3_SECRET_KEY=minioadmin S3_BUCKET=xmaster-center
export PIF_BASE_URL=http://127.0.0.1:8010 PIF_SERVICE_TOKEN=local-print-ingest-token
# shrink the upload limit so oversized-file rejection is testable without a 25 MB fixture
export INGESTION_MAX_UPLOAD_BYTES=102400
npm exec --yes pnpm@10.4.1 -- dev:api      # :3010, health at /api/health (lists module health)
npm exec --yes pnpm@10.4.1 -- dev:worker   # job loop + scheduler + event dispatcher (REQUIRED for cross-module events)
npm exec --yes pnpm@10.4.1 -- --filter @xmaster-center/web dev   # :3020
```
Start each with `setsid nohup ... &` so they survive the shell. Verify with
`curl localhost:3010/api/health` and `curl -o /dev/null -w '%{http_code}' localhost:3020/`.
print-ingest health is `GET /api/v1/health` (NOT `/health` or `/healthz`, those return 404).

## Testing the real PDF upload (replaces the removed demo ingest)
UI: page **Dokumente** (`/ingestion`) → button **„PDFs auswählen“** opens a hidden `multiple`
file input; card **„Upload-Ergebnisse“** shows one row per file with `Aufgenommen` /
`Bereits vorhanden` / the German rejection message. Drive it with computer-use: click the button,
then type the absolute path(s) into the GTK file dialog (`ctrl+l`, path, Enter). For multiple files
type them space-separated in quotes.

API: `POST /api/ingestion/documents/upload`, multipart field `file`, permission
`ingestion.document.upload`. Server computes sha256 over the real bytes, stores them at
`tenants/<tenant>/originals/<sha256>/<name>` in MinIO, dedups on `(tenantId, sha256)`, and enqueues
`ingestion.processing.run`. Rejections: `Keine gültige PDF-Datei` (checked on the `%PDF-` signature,
not the extension) and `Datei zu groß (maximal <limit>)`.

Generate unique fixtures rather than reusing sample PDFs, so you can prove the text really came
from the file: put a company name that cannot exist in the source tree (`grep` it first) plus
`Telefon`, `Angebot:` and a `www.` line — print-ingest needs >= 4 advertisement signals
(`services/print-ingest/app/services/processor.py`) to emit an occurrence. Then look for that exact
string in `/ingestion/occurrences` and in the CRM lead.

## Requeue (Wiedervorlage) on /system/jobs
- The `Erneut einreihen` button only renders for `status = 'dead'`, `Erneut zustellen` only for
  dead-letter events; both are additionally gated on `system.jobs.requeue` /
  `system.events.requeue`, and the server returns `Berechtigung erforderlich` without them.
- Guards (only reachable via tRPC): `Nur tote Jobs können erneut eingereiht werden` and
  `Nur Dead Letters können erneut zugestellt werden`.
- To seed a running job for the lease guard, insert with
  `status='processing', lease_token='lease-abc', lease_expires_at=date_add(now(), interval 5 minute)`.
- To force a genuine dead letter, install a temporary MySQL trigger that fails only the CRM insert
  for one unique company name — this needs the ROOT user (`-uroot -pxmaster_root_password` from
  `docker-compose.yml`), because the app user lacks SUPER with binlog enabled. Drop it afterwards.
- print-ingest outage path: `docker stop xmaster-center-print-ingest`, upload a valid PDF, and the
  document must reach state `failed` with `PDF-Verarbeitung ist nicht erreichbar`; after
  `docker start` the dead job can be requeued and the document reaches `processed`.

## Multi-tenant testing
Extra users can be seeded in the DB (`user_identities` + `role_assignments` + `roles`); a useful set
is `operator` (tenant 1, no requeue rights) and `mandant2` (tenant 2, admin). Check effective rights
with a join over `user_identities`/`role_assignments`/`roles`/`role_permissions` before concluding
that UI gating is wrong.
Tenant of a job should come from the `jobs` row (`context.job.tenantId`), never from the payload and
never with a fallback to tenant 1. If a tenant-2 ingest looks stuck, check `jobs.payload`/`tenant_id`
and the worker log first; a silent fallback to tenant 1 shows up as `Dokument nicht gefunden` plus a
document stuck in `uploaded`. `advertisement.detected` idempotency keys must contain the tenant
(`advertisement.detected:<tenant>:<sha256>:<firma>`), otherwise the same PDF in tenant 1 suppresses
the occurrence AND the lead in tenant 2 — always upload identical bytes in BOTH orders.

## Document classification (Einordnung, `/ingestion`)
- Derived fields live in `ingestion_document_classifications` (unique on `(tenant_id, document_id)`),
  five field groups each with its own `*_source` (`filename`, `pdf-metadata`, `title-page`,
  `first-pages`, `manual`) and `*_confidence`. Derivation: `modules/ingestion/src/classification.ts`,
  invoked from `modules/ingestion/src/module.ts` during `ingestion.processing.run`.
- Manual precedence is per field GROUP: `upsertDerivedClassification` skips a group whose
  `*_source === 'manual'`. Beware: the UI form (`ui/IngestionPage.tsx`) always submits **all** fields,
  so one UI correction marks every group `manual`. A genuinely mixed state (one group manual, the rest
  derived) is only reachable via a tRPC call that sends a single field.
- Correcting needs `ingestion.document.classify` (in the `admin` role via migration
  `drizzle/0011_...sql`; `operator` does NOT have it). `documents.capabilities` returns
  `{correct: boolean}` and gates the form. Audit action: `ingestion.document.classification.corrected`.
- Filters (`documents.list` input `type`, `regionState`, `regionDistrict`, `periodYear`) are applied
  in JS in the repository, exact-match and case-sensitive; documents without a classification row are
  excluded from any active filter. `periodYear` needs BOTH `period_start_year` and `period_end_year`.
- Correction validation is thin: the zod schema accepts any int year (e.g. `12345`, `-1`) and any
  string for `regionState`; MySQL runs with `STRICT_TRANS_TABLES`, so strings longer than the column
  (`type` 64, `edition_label` 128, `publication_name`/region 255) are likely to surface a raw
  `Data too long for column` error — check whether that reaches the UI verbatim.
- To trigger a RE-processing of an existing document (needed to prove manual precedence): find its
  `ingestion.processing.run` job in `jobs`, set it to `status='dead'`, then click „Erneut einreihen“ on
  `/system/jobs` — there is no reprocess button on `/ingestion`.
- print-ingest now also returns `metadata` (PDF title/subject/creationDate) and per-page
  `title_candidates` with font size; the pif client attaches them as a NON-enumerable `pdfMetadata`
  property on the pages array.
- Real test issues live in the dev DB (`ingestion_documents` ids ~1104–1107, tenant 1, origin
  `source`); real PDFs for a fresh upload are in `/home/ubuntu/classification-evidence/`
  (`starnberg-amtsblatt.pdf` 142 KB, `paderborn-messekatalog.pdf` 4 MB, `goerlitz-magazin.pdf` 10 MB).
  Do NOT set `INGESTION_MAX_UPLOAD_BYTES=102400` when testing with these — the default is 25 MB.
- `docker compose up -d` now also starts SearXNG (`127.0.0.1:8081`, health `/healthz` via compose).

## Login
Local provider, user `admin`, PIN from `ADMIN_PIN` (dev value `1907`). Browser login form at
`/`; API endpoint is `POST /api/auth/local` with `{"externalId":"admin","secret":"1907"}`
(NOT `/api/auth/login`). Session cookie `xmc_session`. Five failed attempts trigger a lockout.
If login fails with `UNAUTHORIZED` after changing `JWT_SECRET`, the stored `secret_hash` no longer
matches — either restore the old secret or recompute the admin hash in the dev DB.

## tRPC from the shell (for guard rails the UI cannot reach)
Inputs must be wrapped in `json`:
```bash
curl -s -b cookie.txt -X POST localhost:3010/api/trpc/modules.billing.invoices.issue \
  -H 'content-type: application/json' -d '{"json":{"id":8}}'
```
Use this only for checks the UI blocks (e.g. disabled buttons); prefer the UI otherwise.

## DB inspection
```bash
docker exec xmaster-center-mysql mysql -uxmaster -pxmaster_dev_password xmaster_center -e "<sql>"
```
Useful tables: `billing_invoices` (`status`, `paid_amount`), `billing_payments`,
`billing_dunning_log` (`fee_amount`, `interest_amount`, `total_due`), `audit_log` (`seq`, `action`),
`jobs`, `event_outbox` (`idempotency_key`, `published_at`, `successful_handlers`, `dead_letter`),
`ingestion_documents/_occurrences/_sources`, `customers`.

## Test-fixture traps
- The demo ingest always uses content hash `demo-<tenant>-1`. Events are published with
  idempotency keys `document.ingested:<hash>` / `advertisement.detected:<hash>`, and the outbox
  key is UNIQUE. If you clear `ingestion_*` tables but leave the outbox rows, a "first" ingest
  publishes nothing and NO CRM lead is created — the test looks broken though the code is fine.
  Reset both:
  `delete from event_outbox where idempotency_key like '%demo-1-%';` plus the ingestion tables
  and the `Beispiel GmbH` customer.
- ALEXIS proposal state is in-memory (`modules/assistant/src/router.ts`). Restart the API to get
  the proposal back to `approval_required` before testing the approval gate.
- To make an invoice overdue for a dunning run:
  `update billing_invoices set due_date = DATE_SUB(NOW(), INTERVAL 30 DAY) where id=<id>;`
  Level 1 is fee 5.00 + 5 %/a interest on the OUTSTANDING amount
  (238.00 − 100.00 = 138.00 → 5.00 + 0.57 → 143.57).
- Only dunning level 1 is configured, so a second Mahnlauf must add no row (idempotency by level).
- Billing rejections (re-issue an issued invoice, pay more than outstanding) now surface visibly as
  `Nur Entwürfe können ausgestellt werden` / `Zahlung übersteigt offenen Betrag`, and the message
  replaces any earlier success text. If you see a silent no-op instead, that is a regression.
- `/ingestion/occurrences` is its own page (`Erkannte Fundstellen`, no upload area). `/billing`,
  `/ingestion` and other module ROOT pages legitimately show the combined module overview — only
  compare named subpages when checking for duplicate rendering.
- The browser logout/login sequence is flaky under automation: after clicking Abmelden, verify the
  login form is actually rendered and re-check the user name in the sidebar footer afterwards,
  otherwise you may keep testing under the previous identity (5 wrong PINs cause a lockout, so do
  not blind-retype).
- Concurrency is the sharpest test here. `audit_log.seq` is chained (unique `seq`, `prev_hash`), so
  overlapping writes collide. `appendAudit` retries on errno 1062/1213/1205 and the ingestion upload
  retries the WHOLE transaction up to 5×. That holds for multi-file UI imports (4–6 files) and for
  moderate parallelism, but the retry budget is finite: with ~16 and reliably at 24–32 truly
  simultaneous uploads the budget is exhausted and requests return HTTP 500
  `{"code":"UPLOAD_REJECTED","message":"Upload konnte nicht gespeichert werden"}` — the file is then
  lost. Always escalate pressure until you can state the carrying capacity; a single green round
  proves nothing for a race. Reproduce with two cookie jars:
  `curl -c /tmp/c1.txt -X POST :3010/api/auth/local -d '{"externalId":"admin","secret":"1907"}'`
  then N `curl -b ... -F file=@uniq-N.pdf :3010/api/ingestion/documents/upload` in `( ... & ... & wait )`.
  Raw SQL (`insert into`, `params:`, `Failed query`) must never appear in a response or in the UI —
  business messages (invalid PDF, file too large) must stay in plain German.
- Chain invariants after a load run (all must be empty/zero):
  `select seq from audit_log group by seq having count(*)>1`,
  `select prev_hash from audit_log group by prev_hash having count(*)>1`,
  `max(seq)-min(seq)+1-count(*)` over the range created in the run, plus document↔audit correspondence
  (`ingestion.document.uploaded` rows vs `ingestion_documents.id`). Note older DB state can already
  contain orphan upload-audit rows pointing at deleted documents — check `created_at`/seq before
  blaming the current run.
- Global chain verdict is NOT reachable from the UI: `system.audit.verify` always passes
  `ctx.auth.tenantId`, so even an administrator only gets `Mandantenabschnitt intakt … (globale Kette
  nicht geprüft)` (`scoped:true, complete:false`). To get the global judgement, run
  `verifyAuditChain(repo)` without a tenant from a throwaway script **inside `packages/kernel`**
  (elsewhere `mysql2` does not resolve): `npx tsx verifychain.tmp.ts` with `DATABASE_URL` set.
- Tenant isolation: `audit.list`, `ai.costs`, `flags` and `policies` in
  `modules/system/src/router.ts` must all filter on `ctx.auth.tenantId`. `feature_flags`,
  `automation_policies` and `ai_usage_ledger` are usually EMPTY, so a filter test is vacuous — insert
  one distinguishable row per tenant first. Also smuggle `{"tenantId":1}` into the tRPC input from a
  tenant-2 session; the result must not change.
- A job row with `tenant_id = NULL` must die with `Mandant für Job fehlt`, without falling back to
  tenant 1, and `onFailure` must resolve the tenant from the document so the document becomes visibly
  `failed` with that reason (column `error` in `ingestion_documents`, not `state_message`). Then upload
  a valid PDF to prove the worker survived. Seed such a job with
  `insert into jobs (id,tenant_id,name,payload,status,attempts,max_attempts) values (uuid(),NULL,'ingestion.processing.run','{"documentId":<id>}','pending',0,1);`
  German umlauts make `grep` treat mysql output as binary — use `grep -a` or `cat -v`.
- `mysql -uroot` may fail (`Access denied`); the app user `xmaster/xmaster_dev_password` works.
  Table names: `customers` (not `crm_customers`), `billing_invoices` (`invoice_number`, `total`),
  `ingestion_occurrences` (`company`, `preview`).
- ALEXIS: clicking `Ausführen` while `Freigabe ausstehend` is a silent no-op (no error message);
  verify via `audit_log` that no `assistant.proposal.executed` row appeared, then Freigeben → Ausführen.
- Old `dead` rows for `ingestion.discovery.run` / `ingestion.processing.run`
  ("Kein Handler für Job ...") can linger from runs where the enqueuing process had no handlers;
  check `jobs.created_at` before blaming the current run.

## Devin Secrets Needed
None — all credentials are local dev values (see above).
