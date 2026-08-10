import ipaddress
import socket
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser
import requests
from app.core.config import settings

class PolicyResult(dict):
    pass

def check_url_policy(url: str) -> PolicyResult:
    if not settings.outbound_http_enabled:
        return PolicyResult(status='BLOCKED', reason='outbound_http_disabled')
    p = urlparse(url)
    if p.scheme not in {'http','https'} or not p.hostname:
        return PolicyResult(status='BLOCKED', reason='invalid_url')
    if _is_private_host(p.hostname):
        return PolicyResult(status='BLOCKED', reason='local_or_metadata_address')
    robots_url = f'{p.scheme}://{p.netloc}/robots.txt'
    try:
        r = requests.get(robots_url, timeout=min(settings.request_timeout_seconds,10), headers={'User-Agent': settings.crawl_user_agent})
        if r.ok:
            rp = RobotFileParser()
            rp.parse(r.text.splitlines())
            if not rp.can_fetch(settings.crawl_user_agent, url):
                return PolicyResult(status='BLOCKED', reason='robots_disallow')
    except requests.RequestException:
        pass
    return PolicyResult(status='APPROVED', reason='policy_ok')

def _is_private_host(hostname: str) -> bool:
    try:
        addresses = [ipaddress.ip_address(hostname)]
    except ValueError:
        try:
            addresses = [
                ipaddress.ip_address(item[4][0])
                for item in socket.getaddrinfo(hostname, None, type=socket.SOCK_STREAM)
            ]
        except socket.gaierror:
            return True
    return any(
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_reserved
        for address in addresses
    )
