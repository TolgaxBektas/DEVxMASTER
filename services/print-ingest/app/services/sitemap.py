from urllib.parse import urljoin, urlparse
import xml.etree.ElementTree as ET
import requests
from app.core.config import settings
from app.services.policy import DiscoveryBudget, check_url_policy, read_limited_response, request_checked


def discover_sitemaps(base_url: str, *, budget: DiscoveryBudget | None = None, depth: int = 0) -> list[str]:
    p=urlparse(base_url)
    root=f'{p.scheme}://{p.netloc}'
    candidates=[urljoin(root,'/sitemap.xml'),urljoin(root,'/sitemap_index.xml')]
    out=[]
    for u in candidates:
        if check_url_policy(u)['status']!='APPROVED': continue
        try:
            r=request_checked(
                u,
                budget=budget,
                depth=depth + 1,
                timeout=settings.request_timeout_seconds,
                allow_redirects=False,
            )
            if r.ok and 'xml' in r.headers.get('content-type','').lower():
                out.append(u)
        except requests.RequestException:
            pass
    return out


def extract_pdf_urls_from_sitemap(sitemap_url: str, max_urls: int=5000, *, budget: DiscoveryBudget | None = None, depth: int = 0) -> list[str]:
    r=request_checked(
        sitemap_url,
        budget=budget,
        depth=depth,
        timeout=settings.request_timeout_seconds,
        allow_redirects=False,
    )
    r.raise_for_status()
    content_type = r.headers.get("content-type", "").lower()
    if "xml" not in content_type:
        raise RuntimeError("unexpected_content_type")
    root=ET.fromstring(read_limited_response(r, settings.max_response_mb * 1024 * 1024))
    locs=[(el.text or '').strip() for el in root.iter() if el.tag.endswith('loc') and el.text]
    return [
        u for u in locs[:max_urls]
        if '.pdf' in u.lower() and check_url_policy(u)['status'] == 'APPROVED'
    ]
