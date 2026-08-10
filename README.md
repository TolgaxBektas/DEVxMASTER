# xMaster Center — Fundament

Dieses Repository enthält Stufe 1 des vereinheitlichten xMaster Center:
einen gemeinsamen Kernel, eine DB-basierte Lease-Queue, ein LLM-Gateway,
Integrationsadapter und die Verträge für spätere Fachmodule. Nutzerseitige
Fachtexte bleiben deutsch; Quellcode und Bezeichner sind englisch.

## Architektur und Entscheidungen

Die vollständige visuelle Architektur- und Entscheidungsübersicht steht in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Die offline lesbare HTML-Ansicht
mit eingebetteten Diagrammen liegt unter
[`docs/architecture/index.html`](docs/architecture/index.html).

## Struktur

- `packages/contracts` — Zod-Schemas für IDs, Mandanten, Benutzer, Rechte,
  Fehler, Events, Pagination und Geldbeträge.
- `packages/kernel` — MySQL/TiDB-Drizzle-Schema, Umgebungsvalidierung,
  Identität, RBAC, Tenant-Scope, Audit-Hashkette, Outbox, Einstellungen,
  Modulregister und tRPC-Bausteine.
- `packages/jobs` — Lease-Queue, Retry/Backoff mit Jitter, Scheduler und
  Worker-Loop.
- `packages/ai` — Provider-Registry, freigegebene Prompt-Versionen,
  Kosten-Ledger, Budget-Hardstops, Jury und Content Anchors.
- `packages/integrations` — Storage, Mail, Telegram, PDF und signierte
  Webhooks hinter austauschbaren Interfaces.
- `apps/api` — Express-/tRPC-Gateway mit lokaler Anmeldung und Health-Endpunkt.
- `apps/worker` — Lease-Worker, Scheduler und Event-Dispatcher.
- `modules/system` — Betriebsübersicht für Audit, Jobs, KI-Kosten und Policies.
- `modules/crm` — Mandantenbezogenes CRM für Kunden, Adressen, Branchen und
  Projekte.
- `modules/billing` — Aussteller, Rechnungen, Zahlungen und Mahnwesen mit
  unveränderlichen Belegen und Decimal-String-Arithmetik.
- `modules/ingestion` — Quellen, Dokumente und erkannte Anzeigen-Fundstellen;
  der PIF-Dienst bleibt als Python-Verarbeitungsmaschine gekapselt.
- `modules/assistant` — ALEXIS-Briefing, Chat und policy-gesteuerte
  Aktionsvorschläge.
- `services/print-ingest` — übernommener Python-Dienst für PDF, OCR,
  Verarbeitung und SSRF-geschützten Abruf.

## Start

Voraussetzungen sind Node 22, Corepack und pnpm 10.4.1:

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm check
pnpm test
pnpm build
```

Für Tests wird keine Datenbank und kein Netzwerk benötigt. Die Tests verwenden
In-Memory-Repositories und No-Op-Adapter. Der produktive MySQL-Adapter wird erst
von einer späteren App oder einem Worker instanziiert.

## Lokale Plattform

MySQL läuft reproduzierbar über Docker Compose auf Port `3307`:

```bash
docker compose up -d mysql
export DATABASE_URL=mysql://xmaster:xmaster_dev_password@127.0.0.1:3307/xmaster_center
export JWT_SECRET=replace-with-a-long-random-secret
export PUBLIC_APP_ORIGIN=http://localhost:3000
export ADMIN_PIN=1907
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm dev:api
# in einem zweiten Terminal:
pnpm dev:worker
```

Die API lauscht auf `PORT` (standardmäßig `3000`). `GET /api/health` ist ohne
Anmeldung erreichbar. Die lokale Anmeldung erfolgt mit `externalId=admin` und
dem Wert aus `ADMIN_PIN`; sie setzt das HttpOnly-Cookie `xmc_session`.

## Neues Modul andocken

Ein Modul exportiert genau eine `ModuleDefinition` und registriert sie beim
Start der API:

```ts
export const crm = defineModule({
  id: "crm",
  title: "CRM",
  icon: "users",
  version: "1.0.0",
  schema: { customers },
  router: crmRouter,
  nav: [{ id: "crm.customers", label: "Kunden", href: "/kunden",
    permission: "crm.customer.read" }],
  permissions: [{ permission: "crm.customer.read", title: "Kunden lesen" }],
  jobs: [{ name: "crm.customer.enrich", handle: enrichCustomer }],
  events: [{ name: "customer.created", direction: "published" }],
  health: () => ({ id: "crm", status: "healthy" }),
});
```

`createRegistry([crm, ...])` schlägt bei doppelten Modul-IDs, Rechten oder
Job-Namen hart fehl. Das Register liefert den kombinierten Router unter
`modules.<id>`, rechtegefilterte Navigation, Permission-Registry, Jobs,
Event-Abonnements und aggregierte Health-Daten.

### Verbindliche Folge-Verträge

- **Job-Handler:** `{ name, handle(payload, ctx), maxAttempts?, timeoutMs? }`.
  `ctx` enthält `job`, `signal` und `heartbeat()`. Handler müssen wiederholbar
  und idempotent sein.
- **Events:** Veröffentlichung erfolgt über die Outbox in derselben
  Transaktion wie die Fachänderung. Zustellung ist mindestens einmal;
  Konsumenten deduplizieren über Event-ID oder Idempotency-Key.
- **AI-Gateway:** Module nutzen ausschließlich `AiGateway.chat(...)` bzw. die
  Provider-Funktionen; Prompt-Key/Version, Tenant, Objekt und Budget werden
  mitgegeben. Nur `approved`-Prompts dürfen laufen; Budgetüberschreitung und
  Anchor-Verstöße brechen fail-closed ab.
- **ModuleDefinition:** `id`, `title`, `icon`, `version`, `schema`, `router`,
  optional `rest`, `nav`, `permissions`, `jobs`, `events`, `health`.

## Datenbank

Die Plattform-Datenbank ist MySQL/TiDB mit Drizzle und `mysqlTable`. Der Kernel
definiert ausschließlich die zentralen Tabellen; Fachtabellen gehören in die
jeweiligen Module. `DATABASE_URL` wird beim Erzeugen des DB-Clients benötigt.

## Laufzeit und Wertstrom

Der Web-Dev-Server läuft auf Port `3020`:

```bash
npm exec --yes pnpm@10.4.1 -- --filter @xmaster-center/web dev
```

Der Print-Ingest-Dienst läuft intern auf Port `8000` und wird lokal nur über
`127.0.0.1:8010` veröffentlicht:

```bash
docker compose up -d mysql print-ingest
```

Geschützte PIF-Aufrufe verwenden den Header `x-service-token`. Der Downloader
prüft URLs vor dem Abruf gegen private, Loopback-, Link-Local- und reservierte
Adressen und validiert jeden Redirect erneut. Die Pytest-Suite läuft mit:

```bash
services/print-ingest/.venv/bin/pytest services/print-ingest/tests -q
```

`ingestion` publiziert `document.ingested` und `advertisement.detected`. Das
CRM abonniert die Fundstelle und legt daraus einen Lead mit Herkunftsnachweis
auf Dokument und Fundstelle an. ALEXIS liest Modulzusammenfassungen über
schmale Abfragen, zeigt überfällige Rechnungen und neue Leads und protokolliert
Freigabe sowie Ausführung von Vorschlägen in der globalen Audit-Kette. Für
lokale Demos steht ein Mock-Provider zur Verfügung.

## Grenzen des Fundaments

- Die Ingestion-Browserdemo erzeugt derzeit ein Demo-Dokument; ein vollständiger
  Upload-/Download-Workflow aus der Weboberfläche folgt als Ausbau.
- Der Ingestion-Bestand liegt jetzt persistent in MySQL; der Inhalts-Hash ist
  je Mandant eindeutig und überlebt API-/Worker-Neustarts. Die Browseraufnahme
  bleibt für diese Stufe ein Demo-Dokument.
- Die Discovery- und Verarbeitungsläufe sind als Scheduler-Jobs registriert
  und werden vom Worker verarbeitet; echte externe Quellen und ein vollständiger
  Upload-Workflow bleiben noch aus.
- ALEXIS verwendet für die lokale Demo einen Mock-Kontext und einfache
  Modulzusammenfassungen; produktive Providerqualität und vollständige
  Modulaktionen müssen noch ausgebaut werden.
- Der Python-Dienst ist pytest-verifiziert, aber die Docker-Ausführung und ein
  realer externer PDF-Download sind wegen fehlender externer Quellen nicht
  fachlich durchgetestet.
- Der Mock-KI-Provider prüft Orchestrierung, Prompt-/Policy-Verträge und
  Auditierung, nicht die Qualität oder Kosten realer Provider.
- SEPA, E-Rechnung, DATEV/GoBD-Export, Angebote und Settlement-Import bleiben
  spätere Ausbaustufen.
