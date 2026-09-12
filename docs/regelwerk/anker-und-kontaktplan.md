# Regelwerk für Anker, Kontaktplan, Source Policy und Ausgabegröße (50er-Lauf)

Lead-authored. Verbindlich und wortgetreu umzusetzen. Keine Regel lockern, keine
zusätzliche Heuristik erfinden. Alle Werte stammen entweder aus dem OCR der Anzeige
selbst (`ocr.txt`), aus `extracted.json` unserer Pipeline oder aus `evidence.json`
(eigene Website des Kunden). Andere Quellen sind verboten.

## 1. Erkennung der Werte in der Anzeige

Verwende ausschließlich die Regexe aus `app/services/restoration.py`
(`PHONE_RE`, `EMAIL_RE`, `DOMAIN_RE`, `POSTAL_RE`, `PRICE_RE`, `IBAN_RE`,
`VALIDITY_RE`, `CAMPAIGN_TERMS`) — importieren, nicht nachbauen.

Karriereinhalt liegt vor, wenn eines dieser Wörter im OCR-Text steht (Groß-/Klein
gleichgültig): `Ausbildung`, `Auszubildende`, `Azubi`, `Bewerbung`, `bewerben`,
`Stellenangebot`, `Stellenanzeige`, `wir suchen`, `Praktikum`, `m/w/d`, `w/m/d`,
`Karriere`, `Quereinsteiger`.

QR-Code: mit `pyzbar` oder OpenCV-QR-Detektor auf dem Zuschnitt. Nur wenn im Original
ein Code erkannt wird, gilt er als vorhanden.

## 2. Anker

Ein `preserve`-Anker für jeden im OCR gefundenen Wert dieser Kategorien, Wert
zeichengenau wie in der Anzeige geschrieben:

| Kategorie | Inhalt |
|---|---|
| `company` | Firmenname aus `extracted.json`, sofern er im OCR-Text vorkommt |
| `phone` | jede Telefon-, Mobil- und Faxnummer, je eigener Anker |
| `email` | jede E-Mail-Adresse |
| `website` | jede Domain |
| `address` | Straße mit Hausnummer, PLZ, Ort — je eigener Anker |
| `claim` | Überschrift und Slogan-Zeilen, je Zeile ein Anker, nur Zeilen ab 3 Zeichen |
| `design` | `logo`, `frame`, `photo`, `brand_colors` als nicht-textliche Sichtanker |

Ein `remove`-Anker für jeden Wert, der unter eine Entfernungskategorie aus Abschnitt 4
fällt (Preis, Gültigkeitsdatum, Aktionsbegriff, IBAN, Karriereinhalt, QR-Code).

Kein Anker darf einen Wert enthalten, der nicht im OCR-Text der Anzeige steht.

## 3. Kontaktplan (`publication-contact-plan-v1`)

`preserve` für jeden sichtbaren Kontaktwert der Kategorien `phone`, `mobile`, `fax`,
`email`, `website`, `companyName`, `streetAddress`, `postalCode` — außer der Wert
ist nach Abschnitt 4 zu entfernen (dann kein Planitem).

`add` und `replace` sind **verboten**. Kein Wert, der nicht in der Anzeige selbst steht,
wird in die Anzeige gesetzt — auch dann nicht, wenn `evidence.json` ihn mit Quell-URL
belegt, und auch nicht, wenn eine Kategorie in der Anzeige fehlt. Der Plan besteht
ausschließlich aus `preserve`-Items und den Entfernungen nach Abschnitt 4.

Recherchierte Kommunikationsdaten (Fax, Social-Profile, Domains, E-Mail-Adressen) werden
weiterhin erhoben und als Kontaktdaten des Kunden gespeichert (`deferred_channels`), aber
sie sind kein Bestandteil der Anzeige. Sie erreichen X-Core wie alle anderen Daten erst
nach manueller Freigabe.

Prioritäten: `phone` 100, `companyName` 95, `website` 90, `mobile` 85, `email` 80,
`fax` 70, `streetAddress` 60, `postalCode` 58.
`required: true` nur für `phone` und, falls vorhanden, `mobile`.

`planDigest`: `run50-<slug>-plan`; `fieldDecisionDigest`: `run50-<slug>-<evidence-sha8>`,
wobei `evidence-sha8` die ersten acht Zeichen des SHA256 von `evidence.json` sind.

## 4. Source Policy (`regeneration-source-policy-v1`)

`purpose`: `job_career`, wenn Karriereinhalt erkannt wurde, sonst `general_company`.

`mandatoryRemovalCodes` aus dem tatsächlich Gefundenen, keine Vorratskategorien:
`price_or_discount`, `date_or_validity`, `campaign_term`, `iban`, `qr_related`,
`job_or_career_content`.

`preserveCommunicationKinds`: die in der Anzeige vorhandenen Kategorien aus
`phone`, `mobile`, `fax`, `email`, `website`, `address`.

## 5. Brief

Prompt wie in Runde 5: `brief.py:build_prompt` mit v1.3-Basis, danach wortgetreu
`BOUNDARY_AND_FRAME_LOCK`, `OVERLAY_ELEMENT_LOCK`, `MANDATORY_PLAN_EXECUTION` aus
`brief_blocks_v5.py`. Domainregel: immer `DOMAIN_RULE_LEVEL0` — eine Domain wird nie
ergänzt, weil es keine `add`-Items mehr gibt.

Zusätzlich, wortgetreu, als weiterer Block (gilt für alle Fälle und ersetzt den früheren
Block `ADDED-LINE LEGIBILITY`):

```
NO NEW CONTENT - BINDING
The advertisement may only show what the original advertisement already shows. Never add
a phone number, fax number, e-mail address, domain, social media profile, address, claim
or any other content that is not visible in the original, no matter what any evidence or
research says. Removals required by the plan stay removals: the freed area is restored as
background, never filled with another value. Contact data researched elsewhere is stored
as customer data outside the advertisement and must not appear in the artwork.
```

## 6. Ausgabegröße

Anders als in Runde 4 und 5 wird **nicht** die billigste Größe gewählt, sondern die
druckbrauchbare: Breite und Höhe als Vielfache von 16, Seitenverhältnis des Originals
mit höchstens 2 Prozent Fehler, Seitenverhältnis zwischen 1:3 und 3:1 (steilere
Originale auf die Grenze kappen), Gesamtpixel zwischen 655.360 und 8.294.400, beide
Kanten höchstens 3840. Aus den zulässigen Größen die **kleinste, deren Gesamtpixel
mindestens der Pixelzahl des Originalzuschnitts entsprechen**; ist das Original größer
als die Obergrenze, die größte zulässige Größe. `quality=high`, kein `input_fidelity`.

## 7. Kosten und Abbruch

Sätze: Texteingabe 5, Bildeingabe 8, gecachte Bildeingabe 2, Bildausgabe 30 USD je
1 Mio. Token. Laufende Summe mitführen; bei 120 USD Gesamtkosten den Lauf anhalten und
melden. Je Fall höchstens ein Pass-1-Aufruf und höchstens ein Nachtrag-Aufruf.
