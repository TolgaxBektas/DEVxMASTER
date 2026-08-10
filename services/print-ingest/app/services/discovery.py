from urllib.parse import urljoin, urlparse
import re, requests
from bs4 import BeautifulSoup
from app.core.config import settings
from app.services.policy import check_url_policy

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

def discover_pdf_links(page_url: str) -> list[dict]:
    policy=check_url_policy(page_url)
    if policy['status']!='APPROVED': return []
    r=requests.get(page_url, timeout=settings.request_timeout_seconds, headers={'User-Agent':settings.crawl_user_agent})
    r.raise_for_status()
    soup=BeautifulSoup(r.text,'html.parser')
    found={}
    for a in soup.find_all('a', href=True):
        href=urljoin(str(r.url), a['href'])
        txt=' '.join(a.stripped_strings)
        if '.pdf' in href.lower() or '.pdf' in txt.lower():
            found[href]={'url':href,'anchor_text':txt,'score':score_candidate(href,txt)}
    return sorted(found.values(), key=lambda x:x['score'], reverse=True)
