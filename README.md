# xMaster Center — Fundament

Dieses Repository enthält Stufe 1 des vereinheitlichten xMaster Center:
einen gemeinsamen Kernel, eine DB-basierte Lease-Queue, ein LLM-Gateway,
Integrationsadapter und die Verträge für spätere Fachmodule. Nutzerseitige
Fachtexte bleiben deutsch; Quellcode und Bezeichner sind englisch.

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
