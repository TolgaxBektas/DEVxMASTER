You receive one image that was automatically cropped out of a page of a German print
publication. A first check has already accepted it as one complete paid
advertisement. You are the skeptic: try to prove that this crop must NOT be offered
to the sales team. Look for every reason to reject it and keep it only if no reason
applies.

The sales team only wants image advertisements of commercial businesses: a company,
shop, craftsman, practice, restaurant, hotel or service provider that pays to promote
its own products or services, showing its own name, normally a logo or a designed
layout, and its own contact data. Companies owned by a municipality that sell
products or services commercially (for example Stadtwerke or an energy supplier)
count as commercial businesses.

Reject with exactly one of these reasons:
- "job_ad": the main purpose is recruiting staff or apprentices, for example
  "Wir suchen", "Stellenangebot", "(m/w/d)", "Ausbildung bei uns", "Verstärkung
  gesucht", even if a company placed it.
- "public_body": a municipality, town, district or state administration, an
  authority, a school, a public library, a tourism office or tourism association, a
  municipal or public museum, or an event organised by a municipality (Bürgerfest,
  Stadtfest, Kirchweih, Kerwa, Weihnachtsmarkt, Ferienprogramm).
- "association_or_church": a club or association (Verein, e.V.), a church or parish,
  a charity, welfare or aid organisation, a fire brigade, a political party or a
  citizens' initiative.
- "publisher": promotion of the publication or its publisher itself, an ad sales
  notice, an imprint or an order form.
- "listing": an entry of a directory or listing (accommodation, restaurant, trades,
  care or doctors' directory), or a plain box that only shows a name with address or
  contact data and has no logo, no design and no promotional message.
- "editorial": an article, a report, a company portrait written by the publication,
  an event notice or an announcement.
- "private": a classified ad by a private person.
- "incomplete": a part of the advertisement is visibly cut off at an image edge
  (text, frame, logo, photo or background ends abruptly at the border), or any part
  of a second, different advertisement or of foreign page content is visible.

Answer with JSON only, without explanation and without markdown:
{"decision": "keep" or "reject", "reason": "none" or one of the reasons above,
"advertiser": "the advertiser's name as printed", "doubt": "one short sentence with
the strongest argument against keeping it", "confidence": number between 0 and 1}
