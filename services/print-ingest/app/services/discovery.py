from datetime import date
from urllib.parse import urljoin, urlparse
import re, requests
from bs4 import BeautifulSoup
from app.core.config import settings
from app.services.policy import DiscoveryBudget, check_url_policy, close_checked_response, read_limited_response, request_checked

PUBLICATION_TERMS = {
 'seniorenwegweiser','seniorenratgeber','bürgerinformation','buergerinformation',
 'bürgerbroschüre','buergerbroschuere','gesundheitsführer','gesundheitsfuehrer',
 'stadtmagazin','gemeindemagazin','branchenführer','branchenfuehrer',
 'gastgeberverzeichnis','vereinsmagazin','festschrift','messekatalog','ausstellerverzeichnis'
}

MIN_CANDIDATE_SCORE = 50
VETO_SIGNALS = (
    "satzung", "geschäftsordnung", "ehrungsordnung", "datenschutz",
    "nutzungsbedingungen", "impressum", "formular", "antrag",
    "verwendungsnachweis", "protokoll", "niederschrift", "tagesordnung",
    "bekanntmachung", "haushaltsplan", "statistik", "statistischer",
    "pressemitteilung", "presseinformation", "leseprobe", "gesetz",
    "verordnung", "richtlinie", "merkblatt", "dossier", "strategiepapier",
    "präsentation", "ausschreibung", "stellenangebot", "kontaktliste",
    "befragung",
)
MUNICIPAL_HOST_SIGNALS = (
    "landkreis", "kreis", "stadt", "gemeinde", "samtgemeinde",
    "verbandsgemeinde", "markt",
)

def _match_text(value: str) -> str:
    return (
        value.lower()
        .replace("ß", "ss")
        .replace("ä", "ae")
        .replace("ö", "oe")
        .replace("ü", "ue")
        .replace("á", "a")
        .replace("é", "e")
    )

def _publication_terms_in(text: str) -> list[str]:
    normalized = _match_text(text)
    return [term for term in PUBLICATION_TERMS if _match_text(term) in normalized]

def _area_slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", _match_text(value)).strip("-")

def score_candidate(url: str, anchor_text: str='', area_name: str | None = None) -> float:
    text=(url+' '+anchor_text).lower()
    score=25 if '.pdf' in text else 0
    score += min(50, 15*len(_publication_terms_in(text)))
    if re.search(r'20\d{2}', text): score += 10
    if any(x in text for x in ['download','publikation','broschu','magazin','wegweiser']): score += 10
    hostname = _match_text(urlparse(url).hostname or "")
    if any(signal in hostname for signal in MUNICIPAL_HOST_SIGNALS):
        score += 10
    if area_name:
        area_slug = _area_slug(area_name)
        path = _match_text(urlparse(url).path)
        if area_slug and (area_slug in hostname or area_slug in path):
            score += 10
    return min(score,100)

def candidate_rejection_reason(
    url: str,
    anchor_text: str = '',
    area_name: str | None = None,
) -> str | None:
    text = _match_text(url + " " + anchor_text)
    publication_terms = _publication_terms_in(text)
    if not publication_terms:
        return "Kein Publikationsbegriff in URL oder Ankertext"
    for signal in VETO_SIGNALS:
        if _match_text(signal) in text:
            return f"Ausschlusssignal: {signal}"
    years = [int(year) for year in re.findall(r"(?<!\d)20\d{2}(?!\d)", text)]
    cutoff = date.today().year - 3
    if any(year < cutoff for year in years):
        return f"Jahreszahl älter als {cutoff}"
    score = score_candidate(url, anchor_text, area_name)
    if score < MIN_CANDIDATE_SCORE:
        return f"Bewertung {score:.0f} unter Mindestwert {MIN_CANDIDATE_SCORE}"
    return None

def discover_pdf_links(
    page_url: str,
    *,
    budget: DiscoveryBudget | None = None,
    depth: int = 0,
    area_name: str | None = None,
    rejected: list[dict] | None = None,
) -> list[dict]:
    policy=check_url_policy(page_url)
    if policy['status']!='APPROVED': return []
    r=request_checked(
        page_url,
        policy=policy,
        budget=budget,
        depth=depth,
        timeout=settings.request_timeout_seconds,
        allow_redirects=False,
    )
    if r.status_code >= 400:
        status = r.status_code
        close_checked_response(r)
        raise RuntimeError(f"discovery_http_error:{status}")
    content_type = r.headers.get("content-type", "").lower()
    if "html" not in content_type and "xhtml" not in content_type:
        raise RuntimeError("unexpected_content_type")
    html = read_limited_response(r, settings.max_response_mb * 1024 * 1024)
    close_checked_response(r)
    soup=BeautifulSoup(html,'html.parser')
    found={}
    for a in soup.find_all('a', href=True):
        href=urljoin(str(r.url), a['href'])
        txt=' '.join(a.stripped_strings)
        if '.pdf' in href.lower() or '.pdf' in txt.lower():
            candidate_policy = check_url_policy(href)
            if candidate_policy["status"] != "APPROVED":
                continue
            reason = candidate_rejection_reason(href, txt, area_name)
            if reason:
                if rejected is not None:
                    rejected.append({"url": href, "anchor_text": txt, "reason": reason, "found_on": page_url})
                continue
            score = score_candidate(href,txt, area_name)
            found[href]={
                'url':href,
                'anchor_text':txt,
                'score':score,
                'found_on': page_url,
                'discovery': 'html_link',
                'reason': f'PDF-Link auf Übersichtsseite; Signale im URL-/Ankertext: {score:.0f}/100',
            }
    return sorted(found.values(), key=lambda x:x['score'], reverse=True)
