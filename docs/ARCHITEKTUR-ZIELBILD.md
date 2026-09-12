# Architektur: Zielbild und Weg dorthin

Dieses Dokument plant die Architektur neu. Es beschreibt zuerst den gemessenen Ist-Stand,
dann die Fehler, die daraus folgen, dann den Zielschnitt und die Reihenfolge der Schritte.
Alle Angaben zum Ist-Stand sind am Code beziehungsweise am laufenden Dienst nachgesehen.

## 1. Ist-Stand (gemessen)

Es gibt drei Datenhaltungen mit überlappenden Begriffen:

| Ort | Technik | Enthält |
| --- | --- | --- |
| Center | MySQL, Drizzle | `ingestion_areas`, `ingestion_sources`, `ingestion_documents`, `ingestion_pages`, `ingestion_occurrences`, `ingestion_document_classifications`; dazu `crm.customers`, `billing.quotes/invoices`, Kernel (Audit, Jobs, Outbox) |
| `services/print-ingest` | Python, SQLite, 2.669 Zeilen | `sources`, `documents`, `pages`, `ad_occurrences`, `processing_jobs` |
| `print-intelligence-foundation` | Python, eigene DB, Alembic (10 Migrationen), 9.307 Zeilen | `documents`, `pages`, `companies`, `ad_occurrences`, `review_items`, `deferred_channels`, `sources`, `discovered_candidates`, `jobs` |

Damit existieren `sources`, `documents`, `pages` und Anzeigenvorkommen **dreifach**,
Firmen/Kunden **dreifach** (`print-intelligence-foundation.companies`, `crm.customers`,
Freitextfeld `ingestion_occurrences.company`) und eine Prüf-/Freigabestufe **zweifach**
(`ingestion_occurrences.status` und `review_items`).

Fachlich verteilt sich die Kette so:

- Nur `services/print-ingest` hat Gebiets- und Quellensuche (`discovery`, `autodiscovery`,
  `archive_index`, `sitemap`, `downloader`) und den strengen Inserenten-Test samt
  Dokumenttor und Geometrieprüfung (`app/services/processor.py`).
- Nur `print-intelligence-foundation` hat Feldgewinnung, Rekonstruktion/Auffrischung,
  Wasserzeichen- und QR-Behandlung, Prüffälle, `deferred_channels`, Auftragsformulare und
  den Datenquellen-Begriff `xdata_nb_high_quality` / `xdata_germany`.
- Der Kundensatz und die Geldbelege liegen bereits im Center und zeigen auf ein
  Center-Vorkommen: `crm.customers.source_occurrence_id` und `billing.quotes.occurrence_id`.

Betrieb: `docker-compose.yml` startet MySQL, MinIO, SearXNG und **`print-ingest`**.
`print-intelligence-foundation` ist nicht Teil des Compose-Aufbaus.

## 2. Fehler, die daraus folgen

**F1 — Die Prüfseite kann nicht funktionieren.** `apps/web` routet `/ingestion/review`,
und `modules/ingestion/src/review-client.ts` fragt `/api/v1/reviews/open`,
`/reviews/{id}`, `/reviews/{id}/decision`, `/reviews/{id}/original|restored` gegen
`PIF_BASE_URL` ab. Diese Endpunkte gibt es nur in `print-intelligence-foundation`
(`app/api/compat_reviews.py`); `services/print-ingest` hat sie nicht. Gemessen am
laufenden Dienst:

```
GET http://127.0.0.1:8010/api/v1/health        -> 200
GET http://127.0.0.1:8010/api/v1/reviews/open  -> 404
```

Eine einzige Variable `PIF_BASE_URL` bedient also zwei verschiedene, nicht austauschbare
Dienste. Umgekehrt fehlt `print-intelligence-foundation` der Endpunkt
`/api/v1/sources/revisit`, den `apps/worker` braucht — keiner der beiden Dienste kann
beide Aufgaben.

**F2 — Zwei Anzeigenerkennungen, nur eine ist streng.** Der Inserenten-Test existiert
ausschließlich in `services/print-ingest/app/services/processor.py`. In
`print-intelligence-foundation` kommt kein Begriff daraus vor; dort erkennt ein Bildmodell
(`app/services/vision/*.detect_ads`). Was dort erkannt wird, kann ein Behördenkasten sein
und läuft trotzdem in die Rekonstruktion.

**F3 — Es gibt keinen Übergabeweg für einen frischen Fund.** Der einzige Eingang von
außen in `print-intelligence-foundation` ist `POST /api/v1/imports/print-batch`, und der
verlangt zusätzlich zum Original ein **bereits restauriertes** Bild samt
Restaurierungsmanifest. Ein gerade ausgeschnittener Internetfund erfüllt das nicht.

**F4 — Der Herkunftssatz entsteht nirgends vollständig.** Gebiet hängt an der Quelle,
Heft/Ausgabe/Jahrgang an der Dokumentklassifikation, Seite und Box am Vorkommen, und eine
Deklaration `data_source` führt `ingestion_occurrences` überhaupt nicht. Für eine Übergabe
je Fall muss dieser Satz an einer Stelle zusammenkommen.

**F5 — Kein Besitzer des Kundensatzes ist erklärt.** Faktisch ist das Center Besitzer
(`crm.customers`, `billing`), aber `print-intelligence-foundation.companies` verhält sich
wie ein zweiter Master.

## 3. Zielschnitt

Zwei Dienste, klar getrennte Aufgaben, keine gemeinsamen Begriffe mit zwei Wahrheiten.

**Center (TypeScript, MySQL) — Wahrheit, Steuerung, Entscheidung.**
Gebiete, Quellen, Dokumente, Vorkommen, Klassifikation, Kundensatz, Angebote und
Rechnungen, Audit. Genau eine Prüf- und Freigabeoberfläche. Das Center hält die
autoritative Fassung von allem, was fachlich zählt.

**Dienst „Fund" (`services/print-ingest`) — finden, abrufen, erkennen, schneiden.**
Quellensuche, Archivindex, Abruf, OCR, Inserenten-Test, Dokumenttor, Geometrieprüfung,
Zuschnitt. Seine SQLite ist ausdrücklich **Arbeitsspeicher, keine Wahrheit**: nichts wird
von dort gelesen, was nicht im Center steht.

**Dienst „Bearbeitung" (`print-intelligence-foundation`) — Felder, Rekonstruktion, Prüffall.**
Bekommt fertige Ausschnitte mit vollständigem Herkunftsmanifest, gewinnt belegte Felder,
rekonstruiert inhaltsgleich, führt `deferred_channels`, legt Prüffälle an.
**Keine eigene Anzeigenerkennung im Regelweg** — der Inserenten-Test in Dienst „Fund" ist
das einzige Tor. Die Bildmodell-Erkennung bleibt nur für den Auftragsformular-Pfad, wo es
keine Fremdpublikation und damit keinen Inserenten-Test gibt.
`companies` dort ist Projektion des Center-Kundensatzes, kein Master.

Daraus folgen vier Regeln, die die heutigen Fehler unmöglich machen:

1. Eine Anzeige entsteht genau einmal — im Dienst „Fund", nach dem Inserenten-Test.
2. Der Herkunftssatz entsteht genau einmal — im Center, beim Anlegen des Vorkommens.
3. Eine Entscheidung fällt genau einmal — im Center, an einem Vorkommen.
4. Jeder Dienst hat seine eigene Basis-URL und seinen eigenen Vertrag.

## 4. Reihenfolge der Schritte

**P0 — Prüfseite reparieren (F1).** `PIF_BASE_URL` in zwei Variablen trennen
(`PRINT_INGEST_BASE_URL` für Abruf/Verarbeitung/Quellensuche, `ARTWORK_BASE_URL` für
Prüffälle und Bilder), `print-intelligence-foundation` als Dienst in `docker-compose.yml`
mit Health-Check aufnehmen. Kleinster Schritt, behebt einen 404 auf einer
Kernfunktionsseite.

**P1 — Herkunft vervollständigen (F4).** `data_source` und die verdichteten
Herkunftsfelder an `ingestion_occurrences`, mit Migration. Bestehende Zeilen bekommen
`xdata_germany`, weil sie belegbar aus Webfunden stammen.

**P2 — Übergabeweg (F3).** Neuer Eingang im Dienst „Bearbeitung" für einen frischen Fund:
Originalausschnitt plus Manifest (Datei-SHA-256, Gebiet, Quelle, Heft, Ausgabe, Jahrgang,
Seite, Box, `data_source`), Ergebnis ist ein Prüffall im Zustand `pending`. Der bestehende
`print-batch`-Eingang bleibt für den Auftragsformular-Pfad unverändert.

**P3 — Erkennung entdoppeln (F2).** Im Dienst „Bearbeitung" wird die Bildmodell-Erkennung
aus dem Regelweg für Fremdpublikationen entfernt; sie bleibt für Auftragsformulare.

**P4 — Entscheidung zurückschreiben.** Freigabe im Center schreibt die Entscheidung an den
Prüffall und erzeugt beziehungsweise ergänzt über den bestehenden Lead-Pfad den
Center-Kunden. `deferred_channels` bleiben im Dienst „Bearbeitung" und werden erst bei der
Übergabe gezogen. Keine Übergabe an X-Call/X-Core ohne diese Freigabe.

**P5 — Besitz erklären (F5).** `companies` im Dienst „Bearbeitung" wird als Projektion
gekennzeichnet; Kundenwahrheit ist `crm.customers`.

**P6 — Bestand bereinigen.** Die 4.359 Fundstellen, die dem Inserenten-Test nicht
standhalten, werden als abgelehnt markiert (nichts gelöscht), damit Oberfläche und Export
nur echte Firmenanzeigen zeigen.

P0 bis P2 sind Voraussetzung für alles Weitere. P6 ist unabhängig und jederzeit möglich.

## 5. Was ausdrücklich nicht geplant ist

Kein Zusammenlegen der beiden Python-Dienste in einen: die Aufgaben sind verschieden, die
Laufzeitprofile auch, und keiner der beiden ist Teilmenge des anderen. Keine gemeinsame
Datenbank über Dienstgrenzen. Keine automatische Freigabe und keine Übergabe an
X-Call/X-Core ohne menschliche Entscheidung.
