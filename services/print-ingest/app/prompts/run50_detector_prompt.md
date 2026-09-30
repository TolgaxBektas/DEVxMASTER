# Anzeigenerkennung für den 50er-Lauf (lead-authored, wortgetreu verwenden)

Modell: `gpt-5.1`, Vision, eine Anfrage je Seitenbild (300-dpi-PNG der Seite,
für die Anfrage auf maximal 2000 px lange Kante verkleinert; die Boxen kommen in
Prozent und werden anschließend auf die 300-dpi-Maße zurückgerechnet).

## System-/Anweisungstext (wortgetreu)

```
You receive one full page of a German print publication. Identify every PAID
ADVERTISEMENT on the page, that is every self-contained promotional block that a
company, practice, association or public body booked for itself.

Count as an advertisement only a block that presents one advertiser and carries that
advertiser's own identity: a company or organisation name, and normally a logo, a
frame or a distinct background, together with its own contact data.

Do NOT return:
- editorial articles, reports, interviews, columns, letters, recipes or puzzles;
- directory or reference listings such as telephone-number tables, emergency numbers,
  opening-hour lists, counselling-centre lists, event calendars or address indexes,
  even when they contain company names, addresses, telephone numbers or e-mail
  addresses;
- the publication's own imprint, masthead, table of contents, page numbers, headers,
  footers or self-promotion;
- photo captions, decorative images without an advertiser, and coupons that belong to
  an advertisement you already returned;
- a single line, heading, address block or telephone line taken out of a larger block.

Rules for the boxes:
- One box per advertisement, covering the COMPLETE advertisement including its frame,
  logo, images, claim and contact block, and nothing outside it.
- Never split one advertisement into several boxes and never merge two advertisements
  that are separated by a frame, a rule or a visible gap into one box.
- Coordinates as percentages of the page with one decimal, origin top-left:
  bbox = [left, top, right, bottom].
- Return the advertiser name exactly as printed on the page.

Answer with JSON only, no explanation:
{"advertisements":[{"company_name":"...","bbox":[l,t,r,b],"has_frame":true,
"is_full_bleed":false,"confidence":0.0-1.0}]}
If the page contains no advertisement, return {"advertisements":[]}.
```

## Nachbearbeitung

- Boxen mit `confidence < 0.5` verwerfen.
- Prozentboxen auf die 300-dpi-Seitenmaße umrechnen, danach die glyphenbasierte
  Wachsen-Regel aus dem letzten Auftrag anwenden (Glyphen an der Kante einschließen,
  höchstens 12 Prozent Zuwachs je Kante, danach 8 px Rand).
- Mindestgröße: kurze Kante ≥ 200 px, lange Kante ≥ 350 px bei 300 dpi.
- Der Zuschnitt muss mindestens einen Kontaktwert enthalten (Telefon, E-Mail oder
  Domain nach den Regexen aus `app/services/restoration.py`).
- Überlappung: nach Fläche absteigend, verwerfen bei IoU > 0,4 oder vollständiger
  Enthaltenheit.
- Ein Kunde einmal, größter gültiger Zuschnitt, Dedupe über normalisierte Firmennamen.
