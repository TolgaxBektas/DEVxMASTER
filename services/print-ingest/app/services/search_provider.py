from app.core.config import settings
import os, requests


def web_search(query: str, limit: int=10) -> list[dict]:
    """Optional search-provider adapter.

    Foundation uses a SearXNG-compatible JSON endpoint when SEARXNG_URL is set.
    Without it, discovery still works from configured seed pages and sitemaps.
    """
    endpoint=os.getenv('SEARXNG_URL','').rstrip('/')
    if not endpoint: return []
    r=requests.get(endpoint+'/search',params={'q':query,'format':'json'},timeout=settings.search_timeout_seconds,headers={'User-Agent':settings.crawl_user_agent})
    r.raise_for_status()
    results=[]
    for item in r.json().get('results',[])[:limit]:
        results.append({'url':item.get('url',''),'title':item.get('title',''),'content':item.get('content','')})
    return results
