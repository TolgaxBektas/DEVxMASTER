from urllib.parse import urljoin, urlparse
import re, requests
from bs4 import BeautifulSoup
from app.core.config import settings
from app.services.policy import DiscoveryBudget, check_url_policy, read_limited_response, request_checked

PUBLICATION_TERMS = {
 'seniorenwegweiser','seniorenratgeber','bürgerinformation','buergerinformation',
 'bürgerbroschüre','buergerbroschuere','gesundheitsführer','gesundheitsfuehrer',
 'stadtmagazin','gemeindemagazin','branchenführer','branchenfuehrer',
 'gastgeberverzeichnis','vereinsmagazin','festschrift','messekatalog','ausstellerverzeichnis'
}

def score_candidate(url: str, anchor_text: str='') -> float:
    text=(url+' '+anchor_text).lower()
    score=25 if '.pdf' in text else 0
    score += min(50, 15*sum(1 for t in PUBLICATION_TERMS if t in text))
    if re.search(r'20\d{2}', text): score += 10
    if any(x in text for x in ['download','publikation','broschu','magazin','wegweiser']): score += 10
    return min(score,100)

def discover_pdf_links(page_url: str, *, budget: DiscoveryBudget | None = None, depth: int = 0) -> list[dict]:
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
    r.raise_for_status()
    content_type = r.headers.get("content-type", "").lower()
    if "html" not in content_type and "xhtml" not in content_type:
        raise RuntimeError("unexpected_content_type")
    html = read_limited_response(r, settings.max_response_mb * 1024 * 1024)
    soup=BeautifulSoup(html,'html.parser')
    found={}
    for a in soup.find_all('a', href=True):
        href=urljoin(str(r.url), a['href'])
        txt=' '.join(a.stripped_strings)
        if '.pdf' in href.lower() or '.pdf' in txt.lower():
            candidate_policy = check_url_policy(href)
            if candidate_policy["status"] != "APPROVED":
                continue
            found[href]={
                'url':href,
                'anchor_text':txt,
                'score':score_candidate(href,txt),
                'found_on': page_url,
                'discovery': 'html_link',
                'reason': f'PDF-Link auf Übersichtsseite; Signale im URL-/Ankertext: {score_candidate(href,txt):.0f}/100',
            }
    return sorted(found.values(), key=lambda x:x['score'], reverse=True)
