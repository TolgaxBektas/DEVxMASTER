# Zusammenführung der beiden Arbeitsstränge (Modul 1 ↔ Modul 2)

Zweck: beide Sessions arbeiten an derselben Kette und an demselben Repository, aber an
verschiedenen Enden. Dieses Dokument hält fest, was verbindlich gilt, wo die Grenze
zwischen den Modulen liegt, und welche Lücken zwischen den beiden Enden heute offen sind.
Es ist die gemeinsame Grundlage für alles Weitere; jede spätere Änderung muss dazu passen.

## 1. Die Kette

```
Gebiete → Quellen finden → Publikationen abrufen → Dokument speichern
→ PDF/Text/OCR → Dokument einordnen → echte Firmenanzeige erkennen
→ einzelne Anzeige exakt ausschneiden → Felder mit Herkunft gewinnen
→ inhaltsgleich rekonstruieren/auffrischen → menschliche Prüfung und Freigabe
→ erst danach Übergabe an X-Call/X-Core
```

Modul 1 (Gebiete bis Ausschnitt) ist der Strang dieser Session und liegt in
`modules/ingestion` und `services/print-ingest`.
Modul 2 (Feldgewinnung, Rekonstruktion, Prüffall) ist der Strang der zweiten Session und
liegt in `print-intelligence-foundation`.
Modul 3 ist Prüfung, Freigabe, Dublettenprüfung und Übergabe.

## 2. Verbindliche Regeln, die aus Modul 2 für alles gelten

Diese Regeln sind nicht verhandelbar und gelten auch für Modul 1, sobald ein Fund
weitergegeben wird.

**Kein neuer Inhalt.** Eine bearbeitete Anzeige darf ausschließlich zeigen, was die
Originalanzeige zeigt. Keine Telefonnummer, Faxnummer, E-Mail-Adresse, Domain, Adresse,
kein Claim und kein Ansprechpartner darf hinzugefügt werden — auch dann nicht, wenn der
Wert recherchiert und belegt ist. Eine geforderte Entfernung bleibt eine Entfernung: die
frei gewordene Fläche wird als Hintergrund wiederhergestellt, nie mit einem anderen Wert
gefüllt.

**Rekonstruktion, nicht Redesign.** Was im Internet gefunden wird, wird inhaltsgleich
rekonstruiert beziehungsweise aufgefrischt. Komposition, Format, Schriftbild, Farbflächen,
Logos, Bilder und Vektorobjekte bleiben erhalten. Redesign ist ein eigener, getrennter
Vorgang und kein Massenlauf.

**Getrennte Evidenzpfade.** Auftragsformulare liefern autoritative Kunden- und
Auftragsdaten (`xdata_nb_high_quality`). Internetfunde sind Vorlage und Beleg
(`xdata_germany`). Ein Internetfund darf einen Auftragsformular-Satz nicht abwerten oder
überschreiben.

**Recherchierte Kommunikationsdaten bleiben außerhalb der Anzeige.** Sie werden als
`deferred_channels` am Kunden geführt und warten dort auf die Übergabe; sie erscheinen
nie im Anzeigenbild.

**Nichts wird geraten.** Ein nicht belegter Wert bleibt leer. Jede Ableitung behält ihre
Herkunft (Datei, Seite, Box, Textstelle).

**Keine automatische Freigabe.** Jeder neue Fall startet als `pending`. Ohne manuelle
Freigabe gibt es keine Übergabe an X-Call/X-Core.

**Das Original wird nie überschrieben.** Ausschnitt und Quell-PDF bleiben unverändert
erhalten und referenziert.

Die ausführlichen Regeltexte aus dem Arbeitsstrang Modul 2 liegen unter
`docs/regelwerk/` (Auffrischen, Anker- und Kontaktplan).

## 3. Was gemessen gegen dieses Regelwerk steht

Belegte Befunde aus dem Vergleich beider Enden, ohne Vermutung:

**a) Zwei verschiedene Anzeigenerkennungen.** Modul 1 erkennt Anzeigen deterministisch in
`services/print-ingest/app/services/processor.py` und prüft dabei den benannten
Inserenten-Test (gewerblicher Absender, Werbeabsicht, Kontakt, Gestaltung, plus harte
Ausschlüsse für Behörden, Kirchen, Vereine, Verzeichnisse, Redaktion, Verlagseigenwerbung
und Stellenanzeigen). Modul 2 erkennt Anzeigen über ein Bildmodell
(`print-intelligence-foundation/app/services/vision/*.detect_ads`); ein Inserenten-Test
existiert dort nicht. Folge: ein Behördenkasten oder eine Vereinsliste kann in Modul 2 in
die Rekonstruktion laufen, obwohl Modul 1 ihn längst aussortieren würde.

**b) Es gibt keinen Übergabepfad von Modul 1 nach Modul 2.** `modules/ingestion` liest die
Prüffälle von Modul 2 nur (`review-client.ts`) und schreibt nichts dorthin. Der
Importeingang von Modul 2 (`POST /imports/print-batch`) verlangt zusätzlich zum Original
ein bereits restauriertes Bild samt Restaurierungsmanifest — für einen frischen
Internetfund, der noch nicht bearbeitet ist, passt er nicht.

**c) Der Herkunftssatz liegt am Übergabepunkt nicht beieinander.** Gebiet hängt an der
Quelle (`ingestion_sources.area_id`), Heft, Ausgabe, Jahrgang und Region hängen am
Dokument (`ingestion_document_classifications`), Seite und Box am Vorkommen
(`ingestion_occurrences`). Eine Deklaration der Datenquelle (`data_source`) führt
`ingestion_occurrences` gar nicht.

**d) Der Bestand ist noch nicht auf den strengen Test gestellt.** 6.193 gespeicherte
Fundstellen wurden neu bewertet: 1.834 halten dem Inserenten-Test stand, 4.359 fallen
durch. In der Datenbank steht diese Bewertung noch nicht; Oberfläche und Export zeigen
weiterhin den alten Stand.

## 4. Grenze und Besitz des Kundensatzes

Genau ein System besitzt den autoritativen Kundensatz. Der Arbeitsstrang Modul 2 empfiehlt
dafür das Prüf- und Freigabesystem und nicht eine gemeinsame Datenbank; die Grenze ist
dann eine Übergabe je Fall: Datei, SHA-256, Quellmanifest, belegte Rohfelder mit Herkunft
und deklarierte Datenquelle. Diese Empfehlung ist dokumentiert, aber noch nicht
entschieden und noch nicht gebaut.

## 5. Offene Entscheidungen

1. Werden die 4.359 durchgefallenen Fundstellen in der Datenbank als abgelehnt markiert,
   damit Oberfläche und Export nur noch echte Firmenanzeigen zeigen?
2. Wird der Inserenten-Test zum gemeinsamen Tor vor jeder Rekonstruktion, also auch vor
   der Erkennung in Modul 2?
3. Wo liegt der autoritative Kundensatz (Abschnitt 4)?
4. Yumpu: kostenloses Konto für freigegebene PDFs oder nur als Fundregister?
