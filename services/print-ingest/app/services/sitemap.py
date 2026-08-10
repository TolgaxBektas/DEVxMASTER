from urllib.parse import urljoin, urlparse
import xml.etree.ElementTree as ET
import requests
from app.core.config import settings
from app.services.policy import check_url_policy


def discover_sitemaps(base_url: str) -> list[str]:
    p=urlparse(base_url)
    root=f'{p.scheme}://{p.netloc}'
    candidates=[urljoin(root,'/sitemap.xml'),urljoin(root,'/sitemap_index.xml')]
    out=[]
    for u in candidates:
        if check_url_policy(u)['status']!='APPROVED': continue
        try:
            r=requests.get(u,timeout=settings.request_timeout_seconds,headers={'User-Agent':settings.crawl_user_agent})
            if r.ok and ('xml' in r.headers.get('content-type','').lower() or r.text.lstrip().startswith('<?xml')):
                out.append(u)
        except requests.RequestException:
            pass
    return out


def extract_pdf_urls_from_sitemap(sitemap_url: str, max_urls: int=5000) -> list[str]:
    r=requests.get(sitemap_url,timeout=settings.request_timeout_seconds,headers={'User-Agent':settings.crawl_user_agent})
    r.raise_for_status()
    root=ET.fromstring(r.content)
    locs=[(el.text or '').strip() for el in root.iter() if el.tag.endswith('loc') and el.text]
    return [u for u in locs[:max_urls] if '.pdf' in u.lower()]
