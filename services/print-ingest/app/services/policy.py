import ipaddress
import socket
import time
from urllib.parse import urljoin, urlparse
from urllib.robotparser import RobotFileParser
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from app.core.config import settings

class PolicyResult(dict):
    pass

class RobotsCache:
    def __init__(self):
        self.results = {}

    @staticmethod
    def key(url, user_agent):
        parsed = urlparse(url)
        return (parsed.scheme.lower(), parsed.netloc.lower(), user_agent)

    def get(self, url, user_agent=settings.crawl_user_agent):
        return self.results.get(self.key(url, user_agent))

    def has(self, url, user_agent=settings.crawl_user_agent):
        return self.key(url, user_agent) in self.results

    def set(self, url, result, user_agent=settings.crawl_user_agent):
        self.results[self.key(url, user_agent)] = result

class DiscoveryBudget:
    def __init__(self, *, max_requests=None, max_depth=None, max_seconds=None):
        self.max_requests = settings.max_discovery_requests if max_requests is None else max_requests
        self.max_depth = settings.max_discovery_depth if max_depth is None else max_depth
        seconds = settings.max_discovery_seconds if max_seconds is None else max_seconds
        self.deadline = time.monotonic() + seconds
        self.requests = 0
        self.robots_cache = RobotsCache()

    def check(self, depth: int):
        if depth > self.max_depth:
            raise RuntimeError("discovery_depth_exceeded")
        if self.requests >= self.max_requests:
            raise RuntimeError("discovery_request_budget_exceeded")
        if time.monotonic() >= self.deadline:
            raise RuntimeError("discovery_time_budget_exceeded")
        self.requests += 1

class PinnedAddressAdapter(HTTPAdapter):
    def __init__(self, hostname: str, address: str):
        super().__init__(max_retries=Retry(total=0, redirect=0))
        self.hostname = hostname
        self.address = address

    def get_connection(self, url, proxies=None):
        parsed = urlparse(url)
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        pool_kwargs = {}
        if parsed.scheme == "https":
            pool_kwargs = {
                "assert_hostname": self.hostname,
                "server_hostname": self.hostname,
            }
        return self.poolmanager.connection_from_host(
            self.address,
            port=port,
            scheme=parsed.scheme,
            pool_kwargs=pool_kwargs,
        )

    def add_headers(self, request, **kwargs):
        parsed = urlparse(request.url)
        request.headers["Host"] = parsed.netloc

def check_url_policy(url: str, *, robots_cache: RobotsCache | None = None, budget: DiscoveryBudget | None = None) -> PolicyResult:
    if not settings.outbound_http_enabled:
        return PolicyResult(status='BLOCKED', reason='outbound_http_disabled')
    p = urlparse(url)
    if p.scheme not in {'http','https'} or not p.hostname:
        return PolicyResult(status='BLOCKED', reason='invalid_url')
    addresses = _resolve_public_addresses(p.hostname)
    if not addresses:
        return PolicyResult(status='BLOCKED', reason='local_or_metadata_address')
    robots_url = f'{p.scheme}://{p.netloc}/robots.txt'
    cache = robots_cache
    cached = cache.get(url) if cache is not None and cache.has(url) else None
    if cache is not None and cache.has(url):
        if cached is not None and not cached.can_fetch(settings.crawl_user_agent, url):
            return PolicyResult(status='BLOCKED', reason='robots_disallow')
    else:
        robots_parser = None
        robots_result = PolicyResult(status="APPROVED", reason="robots_allowed")
        try:
            if budget is not None:
                budget.check(0)
            r = request_checked(
                robots_url,
                policy=PolicyResult(
                    status='APPROVED',
                    reason='policy_ok',
                    hostname=p.hostname,
                    address=addresses[0],
                ),
                timeout=min(settings.request_timeout_seconds, 10),
                headers={'User-Agent': settings.crawl_user_agent},
                allow_redirects=False,
            )
            if r.ok:
                robots_parser = RobotFileParser()
                robots_parser.parse(r.text.splitlines())
                if not robots_parser.can_fetch(settings.crawl_user_agent, url):
                    robots_result = PolicyResult(status='BLOCKED', reason='robots_disallow')
        except requests.RequestException:
            pass
        finally:
            if "r" in locals():
                close_checked_response(r)
        if cache is not None:
            cache.set(url, robots_parser)
        if robots_result["status"] != "APPROVED":
            return robots_result
    return PolicyResult(
        status='APPROVED',
        reason='policy_ok',
        hostname=p.hostname,
        address=addresses[0],
        addresses=addresses,
    )

def _resolve_public_addresses(hostname: str) -> list[str]:
    try:
        addresses = [ipaddress.ip_address(hostname)]
    except ValueError:
        try:
            resolved = [
                ipaddress.ip_address(item[4][0])
                for item in socket.getaddrinfo(hostname, None, type=socket.SOCK_STREAM)
            ]
        except socket.gaierror:
            return []
        addresses = resolved
    public = [
        str(address)
        for address in addresses
        if not (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_reserved
        )
    ]
    return list(dict.fromkeys(public))

def request_checked(
    url: str,
    *,
    policy: PolicyResult | None = None,
    budget: DiscoveryBudget | None = None,
    depth: int = 0,
    max_redirects: int | None = None,
    **kwargs,
):
    headers = dict(kwargs.pop("headers", {}) or {})
    headers.setdefault("User-Agent", settings.crawl_user_agent)
    kwargs.pop("allow_redirects", None)
    current_url = url
    current_policy = policy
    redirects: list[dict[str, str]] = []
    redirect_limit = settings.max_redirects if max_redirects is None else max_redirects
    for redirect_count in range(redirect_limit + 1):
        if budget:
            budget.check(depth)
        checked = current_policy or check_url_policy(
            current_url,
            robots_cache=budget.robots_cache if budget else None,
            budget=budget,
        )
        if checked["status"] != "APPROVED":
            raise RuntimeError(f"policy_blocked:{checked['reason']}")
        parsed = urlparse(current_url)
        session = requests.Session()
        session.trust_env = False
        session.mount(parsed.scheme + "://", PinnedAddressAdapter(
            str(checked["hostname"]),
            str(checked["address"]),
        ))
        response = session.request("GET", current_url, headers=headers, allow_redirects=False, **kwargs)
        response._xmaster_session = session
        response.url = current_url
        if not response.is_redirect and not response.is_permanent_redirect:
            response._xmaster_redirects = redirects
            return response
        location = response.headers.get("Location")
        if not location:
            response._xmaster_redirects = redirects
            return response
        if redirect_count >= redirect_limit:
            close_checked_response(response)
            raise RuntimeError("redirect_limit_exceeded")
        target = urljoin(current_url, location)
        target_policy = check_url_policy(
            target,
            robots_cache=budget.robots_cache if budget else None,
            budget=budget,
        )
        redirects.append({
            "from": current_url,
            "to": target,
            "status": str(response.status_code),
            "policy": target_policy["status"],
            "reason": target_policy.get("reason", ""),
        })
        close_checked_response(response)
        if target_policy["status"] != "APPROVED":
            raise RuntimeError(f"redirect_policy_blocked:{target_policy.get('reason', 'blocked')}")
        current_url = target
        current_policy = target_policy
    raise RuntimeError("redirect_limit_exceeded")

def close_checked_response(response):
    close = getattr(response, "close", None)
    if close is not None:
        close()
    session = getattr(response, "_xmaster_session", None)
    if session is not None:
        session.close()

def read_limited_response(response, max_bytes: int) -> bytes:
    chunks = []
    total = 0
    for chunk in response.iter_content(1024 * 1024):
        if not chunk:
            continue
        total += len(chunk)
        if total > max_bytes:
            raise RuntimeError("response_too_large")
        chunks.append(chunk)
    return b"".join(chunks)
