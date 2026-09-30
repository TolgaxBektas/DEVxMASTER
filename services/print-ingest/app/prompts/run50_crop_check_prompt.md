# Zuschnittprüfung (lead-authored, wortgetreu verwenden)

Modell `gpt-5.1`, Vision, ein Aufruf je Zuschnitt. Eingabe ist das 300-dpi-Bild des
Zuschnitts (für die Anfrage auf maximal 1600 px lange Kante verkleinert).

## Anweisungstext (wortgetreu)

```
You receive one image that was automatically cropped out of a page of a German print
publication. It should contain exactly one complete paid advertisement and nothing
else. Judge what the image actually contains.

Definitions:
- An advertisement is a self-contained promotional block booked by one advertiser,
  carrying that advertiser's own identity (company or organisation name, usually a
  logo, a frame or its own background) together with its own contact data.
- Editorial content is an article, report, interview, notice, event announcement
  written by the publication, a directory or table of addresses or telephone numbers,
  or the publication's own imprint or self-promotion. Editorial content is not an
  advertisement even when it names companies and telephone numbers.

Report:
1. "content": one of "single_advertisement", "multiple_advertisements",
   "partial_advertisement", "editorial", "other".
   Use "multiple_advertisements" as soon as any part of a second, different
   advertisement is visible, including a strip, a fragment or a single line of it at
   any edge.
   Use "partial_advertisement" when a part of the one advertisement is missing or cut
   off at an edge.
2. "advertiser": the advertiser name exactly as printed, for the main advertisement.
3. "tight_bbox": the bounding box of the one main advertisement inside THIS image, as
   percentages of this image with one decimal, origin top-left, [left, top, right,
   bottom]. Include its frame, logo, images, claim and contact block, and nothing that
   belongs to another advertisement, to editorial text or to the page background
   outside the advertisement.
4. "cut_off_sides": list of sides ("left","top","right","bottom") where the
   advertisement itself is cut off by the image edge.
5. "foreign_content_sides": list of sides where content that does not belong to this
   advertisement is visible.
6. "confidence": 0.0 to 1.0.

Answer with JSON only, no explanation:
{"content":"...","advertiser":"...","tight_bbox":[l,t,r,b],"cut_off_sides":[],
"foreign_content_sides":[],"confidence":0.0}
```

## Auswertung

- `editorial`, `other`: Fall verwerfen (Grund `redaktionell_keine_anzeige`).
- `multiple_advertisements` oder nicht leere `foreign_content_sides`: mit `tight_bbox`
  neu zuschneiden (Prozente auf den bestehenden Zuschnitt bezogen, danach 8 px Rand bei
  300 dpi) und **einmal** erneut prüfen. Ist das Ergebnis dann nicht
  `single_advertisement` mit leerem `foreign_content_sides`, verwerfen
  (Grund `mehrere_anzeigen_nicht_trennbar`).
- `partial_advertisement` oder nicht leere `cut_off_sides`: Box an den genannten Seiten
  bis zu 12 Prozent nach außen erweitern, neu zuschneiden, **einmal** erneut prüfen;
  danach unverändert verwerfen (Grund `randschnitt_nicht_behebbar`).
- `single_advertisement` mit leeren Listen und `confidence` ab 0,7: gültig. Als
  Firmenname gilt `advertiser` aus dieser Prüfung, nicht der Name aus der Seitenerkennung.
- Höchstens zwei Prüfaufrufe je Zuschnitt.

## Dedupe

Zwei Kunden gelten als derselbe, wenn ihre normalisierten Namen (Kleinschreibung, ohne
Rechtsform, Satzzeichen, Umlaut-Auflösung, ohne die Wörter „gmbh", „kg", „ev", „e v",
„co", „kreisverband", „wetzlar") gleich sind, oder wenn die Tokenmenge des einen eine
Teilmenge der anderen ist, oder wenn ihre Ähnlichkeit nach `SequenceMatcher` mindestens
0,85 beträgt. Behalten wird der größte gültige Zuschnitt.
