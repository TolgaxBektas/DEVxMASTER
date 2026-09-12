# Stufe 2 — Auffrischen einer Werbeanzeige (verbindliches Regelwerk)

Gilt für Modul 2. Standardweg überall, wo die Quell-PDF eine echte Textebene hat.
Kein Bildmodell, keine Generierung, keine Recherche im Bild. Kosten je Anzeige: 0.

## 0. Grundsatz

Die aufgefrischte Anzeige zeigt **denselben Inhalt** wie das Original, nur sauber
gesetzt. Sie ist keine neue Anzeige. Jede Abweichung, die nicht in Abschnitt 3
ausdrücklich erlaubt ist, ist ein Fehler und führt zum Rückfall auf Stufe 1
(Rekonstruieren).

## 1. Voraussetzungen (alle müssen erfüllt sein, sonst Stufe 1)

1. Die Anzeige liegt in der Quell-PDF mit Textobjekten vor (`pdf_text_present`).
2. Die verwendeten Schriften sind in der PDF eingebettet und wiederverwendbar.
   Keine Ersatzschrift, keine Systemschrift, kein Unicode-Umweg.
3. Der Anzeigenausschnitt (Box, Seite, Datei) ist bekannt und unverändert.
4. Bilder, Logos, QR-Codes, Farbflächen und Vektorpfade sind als geschützte
   Objekte erfasst.

Fehlt eines davon: `stufe = 1`, Begründung protokollieren
(z. B. `image_only_no_pdf_text`), Original unverändert ausgeben.

## 2. Was unangetastet bleibt (harte Schutzliste)

- Logo — Position, Größe, Farbe, Form. Nur austauschbar, wenn die Kundenwebsite
  belegt ein neueres Logo zeigt, und nur mit Quellnachweis.
- Fotos, Illustrationen, Hintergrundbilder, Freisteller.
- QR-Codes und Barcodes.
- Farbflächen, Rahmen, Linien, Verläufe, Vektorpfade.
- Alle Schriftarten und Schriftschnitte der Anzeige.
- Farbwerte des Textes.
- Format und Maß der Anzeige (Höhe und Breite bleiben gleich).

## 3. Was verändert werden darf (abschließende Liste)

1. **Kanten:** Textzeilen, die inhaltlich zusammengehören, erhalten eine
   gemeinsame linke, rechte oder mittige Kante. Die Ausrichtung wird aus dem
   Original übernommen (links bleibt links, rechts bleibt rechts, zentriert
   bleibt zentriert) — sie wird nie gewechselt.
2. **Zeilenabstand:** innerhalb eines Blocks gleichmäßig, abgeleitet aus dem im
   Original am häufigsten vorkommenden Abstand desselben Blocks.
3. **Blockabstand:** gleichmäßiger Abstand zwischen Blöcken, abgeleitet aus dem
   Original; die Reihenfolge der Blöcke bleibt.
4. **Ränder:** ungleiche Innenabstände zum Anzeigenrahmen werden ausgeglichen,
   ohne Inhalt zu verkleinern.
5. **Kommunikationsblock:** die in der Anzeige **bereits vorhandenen**
   Kontaktangaben werden als ein geschlossener Block gesetzt
   (Telefon/Telefax zusammen, E-Mail und Web zusammen), an der Ausrichtung
   des Originals.
6. **Schriftgröße:** nur, wenn eine Zeile sonst nicht passt, und nur bis maximal
   2 Punkt kleiner, nie größer.

Alles andere ist unzulässig.

## 4. Verboten — NO NEW CONTENT (bindend)

Die Anzeige darf nur zeigen, was das Original zeigt. Niemals eine Telefonnummer,
Faxnummer, E-Mail-Adresse, Domain, Adresse, ein Social-Media-Profil, einen Claim,
einen Ansprechpartner oder irgendeinen anderen Inhalt ergänzen — auch dann nicht,
wenn er recherchiert und mit Quelle belegt ist, und auch nicht, wenn eine Kategorie
in der Anzeige fehlt. Recherchierte Kommunikationsdaten werden ausschließlich als
Kontaktdaten des Kunden gespeichert (`deferred_channels`) und erreichen X-Core erst
nach manueller Freigabe. Entfernungen (Wasserzeichen, QR, Fremdmarken) bleiben
Entfernungen: die frei gewordene Fläche wird als Hintergrund wiederhergestellt,
nie mit einem anderen Wert gefüllt.

## 5. Nachweispflicht (fail-closed)

Nach dem Satz wird geprüft und protokolliert:

1. **Zeichenbilanz:** jedes Textzeichen des Originals kommt genau einmal im
   Ergebnis vor. Kein verlorenes, kein doppeltes, kein verändertes Zeichen.
2. **Wertprüfung:** jede Telefonnummer, Faxnummer, E-Mail-Adresse, Domain und
   Adresse wird aus dem fertigen Ergebnis zurückgelesen und Zeichen für Zeichen
   mit dem Original verglichen.
3. **Schutzliste:** die geschützten Objekte aus Abschnitt 2 liegen unverändert an
   unveränderter Position (Prüfung per Pixel- und Objektvergleich).
4. **Überdeckung:** kein gesetzter Text überlappt ein geschütztes Objekt oder
   anderen Text.
5. **Maß:** Höhe und Breite der Anzeige unverändert.

Schlägt eine dieser Prüfungen fehl, wird das Ergebnis **verworfen**, die Anzeige
läuft als Stufe 1 weiter, und der Grund wird am Fall protokolliert. Es wird nie
ein Teilergebnis ausgegeben, `all_passed` wird nie gesetzt, ohne dass alle
Einzelprüfungen bestanden sind.

## 6. Prüfprompt für die Kontrolle Original ↔ aufgefrischt

Der folgende Text wird dem Prüfmodell mit beiden Bildern (links Original, rechts
aufgefrischt) übergeben. Er entscheidet nichts allein — er kann nur ablehnen.

```
Du vergleichst zwei Fassungen derselben Werbeanzeige: links das Original,
rechts die aufgefrischte Fassung. Antworte ausschließlich als JSON.

Prüfe und melde:
1. inhalt_gleich: Zeigt die rechte Fassung genau denselben Text wie links?
   Liste jede Abweichung: fehlender Text, zusätzlicher Text, geänderter Text,
   insbesondere bei Telefon, Fax, E-Mail, Domain, Adresse, Firmenname.
2. bildelemente_gleich: Sind Logo, Fotos, QR-Codes, Farbflächen, Rahmen und
   Linien unverändert in Form, Farbe und Position?
3. schrift_gleich: Sind Schriftart, Schriftschnitt und Textfarbe unverändert?
4. lesbarkeit: Ist jede Zeile vollständig lesbar, nicht abgeschnitten, nicht
   überdeckt, nicht aus der Anzeige herauslaufend?
5. satzqualitaet: Sitzen zusammengehörige Zeilen an gemeinsamer Kante mit
   gleichmäßigen Abständen?

Regeln:
- Zusätzlicher Inhalt rechts ist immer ein Fehler, auch wenn er sachlich richtig
  wirkt.
- Eine andere Ausrichtung als links ist ein Fehler.
- Bei Zweifel entscheide gegen die neue Fassung.

Format:
{"inhalt_gleich": true|false,
 "abweichungen": ["..."],
 "bildelemente_gleich": true|false,
 "schrift_gleich": true|false,
 "lesbarkeit_ok": true|false,
 "satzqualitaet_ok": true|false,
 "urteil": "annehmen"|"ablehnen",
 "begruendung": "..."}
```

## 7. Ergebnis am Fall

Protokolliert wird je Anzeige: gewählte Stufe (1 oder 2), Grund bei Rückfall,
die fünf Einzelnachweise aus Abschnitt 5, das Urteil aus Abschnitt 6, sowie
Original und Ergebnis als getrennte Dateien. Das Original wird nie überschrieben.
Der Fall bleibt in der Prüfliste `pending` bis zur manuellen Freigabe.
