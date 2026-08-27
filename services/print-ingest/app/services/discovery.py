from datetime import date
from urllib.parse import urljoin, urlparse
import re, requests
from bs4 import BeautifulSoup
from app.core.config import settings
from app.services.archive_index import ArchiveIndex
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
MAX_SECOND_LEVEL_LINKS = 8
PUBLICATION_NAVIGATION_SIGNALS = (
    "broschüre", "broschuere", "publikation", "download", "senioren",
    "bürgerinformation", "buergerinformation", "rathaus", "service",
)

def _policy(url: str, budget: DiscoveryBudget | None):
    try:
        return check_url_policy(url, robots_cache=budget.robots_cache if budget else None, budget=budget)
    except TypeError as error:
        if "unexpected keyword" not in str(error):
            raise
        return check_url_policy(url)

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
    archive_timestamp: str | None = None,
) -> str | None:
    text = _match_text(url + " " + anchor_text)
    publication_terms = _publication_terms_in(text)
    if not publication_terms:
        return "Kein Publikationsbegriff in URL oder Ankertext"
    for signal in VETO_SIGNALS:
        if _match_text(signal) in text:
            return f"Ausschlusssignal: {signal}"
    years = [int(year) for year in re.findall(r"(?<!\d)20\d{2}(?!\d)", text)]
    if archive_timestamp:
        match = re.match(r"(20\d{2})", archive_timestamp)
        if match:
            years.append(int(match.group(1)))
    cutoff = date.today().year - 3
    if years and max(years) < cutoff:
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
    visited: set[str] | None = None,
) -> list[dict]:
    visited_urls = visited if visited is not None else set()
    if page_url in visited_urls:
        return []
    visited_urls.add(page_url)
    policy=_policy(page_url, budget)
    if policy['status']!='APPROVED':
        if rejected is not None:
            rejected.append({"url": page_url, "anchor_text": "", "reason": policy.get("reason", "Policy blockiert"), "found_on": page_url})
        return []
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
    if len(html) <= 1024 and re.search(rb"location\.reload\s*\(", html, re.IGNORECASE):
        if rejected is not None:
            rejected.append({
                "url": page_url,
                "reason": "bot_challenge",
                "error_type": "BotChallenge",
                "message": "Kleine HTML-Antwort mit location.reload() statt einer Inhaltsseite",
                "found_on": page_url,
            })
        return []
    soup=BeautifulSoup(html,'html.parser')
    found={}

    def collect_pdf_links(document, source_url, discovery, redirects=None):
        for a in document.find_all('a', href=True):
            href=urljoin(source_url, a['href'])
            txt=' '.join(a.stripped_strings)
            if '.pdf' not in href.lower() and '.pdf' not in txt.lower():
                continue
            candidate_policy = _policy(href, budget)
            if candidate_policy["status"] != "APPROVED":
                if rejected is not None:
                    rejected.append({"url": href, "anchor_text": txt, "reason": candidate_policy.get("reason", "Policy blockiert"), "found_on": source_url})
                continue
            reason = candidate_rejection_reason(href, txt, area_name)
            if reason:
                if rejected is not None:
                    rejected.append({"url": href, "anchor_text": txt, "reason": reason, "found_on": source_url})
                continue
            score = score_candidate(href,txt, area_name)
            found[href]={
                'url':href,
                'anchor_text':txt,
                'score':score,
                'found_on': source_url,
                'discovery': discovery,
                'reason': f'PDF-Link auf Übersichtsseite; Signale im URL-/Ankertext: {score:.0f}/100',
                'redirects': redirects or [],
            }

    collect_pdf_links(soup, str(r.url), "html_link", getattr(r, "_xmaster_redirects", []))
    if depth == 0:
        start_host = (urlparse(str(r.url)).hostname or "").lower().removeprefix("www.")
        second_level = []
        for a in soup.find_all('a', href=True):
            href = urljoin(str(r.url), a['href'])
            txt = ' '.join(a.stripped_strings)
            host = (urlparse(href).hostname or "").lower().removeprefix("www.")
            normalized = _match_text(f"{txt} {urlparse(href).path}")
            if host != start_host or not any(_match_text(signal) in normalized for signal in PUBLICATION_NAVIGATION_SIGNALS):
                continue
            if href in visited_urls or href in second_level:
                continue
            second_level.append(href)
            if len(second_level) >= MAX_SECOND_LEVEL_LINKS:
                break
        for nested_url in second_level:
            visited_urls.add(nested_url)
            nested_policy = _policy(nested_url, budget)
            if nested_policy["status"] != "APPROVED":
                if rejected is not None:
                    rejected.append({"url": nested_url, "anchor_text": "", "reason": nested_policy.get("reason", "Policy blockiert"), "found_on": page_url})
                continue
            try:
                nested_response = request_checked(
                    nested_url, policy=nested_policy, budget=budget, depth=depth + 1,
                    timeout=settings.request_timeout_seconds, allow_redirects=False,
                )
                if nested_response.status_code >= 400:
                    close_checked_response(nested_response)
                    continue
                nested_type = nested_response.headers.get("content-type", "").lower()
                if "html" not in nested_type and "xhtml" not in nested_type:
                    close_checked_response(nested_response)
                    continue
                nested_html = read_limited_response(nested_response, settings.max_response_mb * 1024 * 1024)
                nested_final_url = str(nested_response.url)
                close_checked_response(nested_response)
                collect_pdf_links(
                    BeautifulSoup(nested_html, 'html.parser'),
                    nested_final_url,
                    "html_link_second_level",
                    getattr(nested_response, "_xmaster_redirects", []),
                )
            except RuntimeError:
                continue
    return sorted(found.values(), key=lambda x:x['score'], reverse=True)
