import pytest
from app.services import archive_index, discovery, downloader, policy, sitemap
from app.services.archive_index import ArchiveIndex, parse_cdx_text
from app.services.policy import DiscoveryBudget, RobotsCache, check_url_policy, read_limited_response
from app.api import routes
from app.schemas.api import RevisitRequest


class FakeResponse:
    def __init__(self, body=b"", content_type="text/html", status=200, headers=None):
        self.body = body
        self.headers = {"content-type": content_type, **(headers or {})}
        self.status_code = status
        self.url = "https://public.example/"
        self.is_redirect = status in (301, 302, 303, 307, 308)
        self.is_permanent_redirect = status in (301, 308)

    @property
    def ok(self):
        return self.status_code < 400

    def raise_for_status(self):
        if not self.ok:
            raise RuntimeError("http_error")

    def iter_content(self, _size):
        yield self.body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


def test_response_size_limit_blocks_oversized_html():
    with pytest.raises(RuntimeError, match="response_too_large"):
        read_limited_response(FakeResponse(b"x" * 11), 10)


def test_discovery_rejects_non_html_before_parsing(monkeypatch):
    monkeypatch.setattr(discovery, "check_url_policy", lambda _url: {
        "status": "APPROVED", "hostname": "public.example", "address": "93.184.216.34",
    })
    monkeypatch.setattr(discovery, "request_checked", lambda *args, **kwargs: FakeResponse(
        b"<a href='x.pdf'>x</a>", "application/pdf",
    ))
    with pytest.raises(RuntimeError, match="unexpected_content_type"):
        discovery.discover_pdf_links("https://public.example/")


def test_sitemap_rejects_non_xml_before_parsing(monkeypatch):
    monkeypatch.setattr(sitemap, "request_checked", lambda *args, **kwargs: FakeResponse(
        b"<urlset/>", "text/html",
    ))
    with pytest.raises(RuntimeError, match="unexpected_content_type"):
        sitemap.extract_pdf_urls_from_sitemap("https://public.example/sitemap.xml")


def test_budget_blocks_request_count_and_depth():
    budget = DiscoveryBudget(max_requests=1, max_depth=0, max_seconds=10)
    budget.check(0)
    with pytest.raises(RuntimeError, match="discovery_request_budget_exceeded"):
        budget.check(0)
    with pytest.raises(RuntimeError, match="discovery_depth_exceeded"):
        DiscoveryBudget(max_requests=10, max_depth=0, max_seconds=10).check(1)


def test_redirect_limit_blocks_exhaustion(monkeypatch):
    allowed = {"status": "APPROVED", "hostname": "public.example", "address": "93.184.216.34"}
    monkeypatch.setattr(downloader, "check_url_policy", lambda _url: allowed)
    monkeypatch.setattr(downloader, "request_checked", lambda *args, **kwargs: FakeResponse(
        b"", "application/pdf", 302, {"location": "/next.pdf"},
    ))
    with pytest.raises(downloader.DownloadError, match="redirect_limit_exceeded"):
        downloader.download_pdf("https://public.example/start.pdf", max_redirects=0)


def test_relative_redirect_is_resolved_before_policy_check(monkeypatch):
    seen = []
    allowed = {"status": "APPROVED", "hostname": "public.example", "address": "93.184.216.34"}
    monkeypatch.setattr(downloader, "check_url_policy", lambda url: (seen.append(url) or allowed))
    responses = iter([
        FakeResponse(b"", "application/pdf", 302, {"location": "/next.pdf"}),
        FakeResponse(b"%PDF-1.7\nbody", "application/pdf", 200),
    ])
    monkeypatch.setattr(downloader, "request_checked", lambda *args, **kwargs: next(responses))
    data, _metadata = downloader.download_pdf("https://public.example/start.pdf")
    assert data.startswith(b"%PDF-")
    assert "https://public.example/next.pdf" in seen
    assert all("://" in url for url in seen)


def test_checked_request_follows_redirects_and_rechecks_policy(monkeypatch):
    checked = []
    requested = []

    class Session:
        def __init__(self):
            self.trust_env = True

        def mount(self, *_args):
            pass

        def request(self, method, url, **_kwargs):
            requested.append(url)
            if len(requested) == 1:
                return FakeResponse(b"", status=307, headers={"Location": "/start/"})
            return FakeResponse(b"ok", status=200)

        def close(self):
            pass

    def fake_policy(url, **_kwargs):
        checked.append(url)
        return {
            "status": "APPROVED",
            "hostname": "public.example",
            "address": "93.184.216.34",
        }

    monkeypatch.setattr(policy, "check_url_policy", fake_policy)
    monkeypatch.setattr(policy.requests, "Session", Session)
    monkeypatch.setattr(policy, "PinnedAddressAdapter", lambda *_args: object())

    response = policy.request_checked("https://public.example/")

    assert requested == ["https://public.example/", "https://public.example/start/"]
    assert checked == ["https://public.example/", "https://public.example/start/"]
    assert response.url == "https://public.example/start/"
    assert response._xmaster_redirects[0]["to"] == "https://public.example/start/"


def test_checked_response_closes_its_session():
    class Session:
        def close(self):
            self.closed = True

    response = FakeResponse()
    response.close = lambda: setattr(response, "closed", True)
    response._xmaster_session = Session()
    from app.services.policy import close_checked_response

    close_checked_response(response)
    assert response.closed
    assert response._xmaster_session.closed


def test_pdf_signature_is_authoritative(monkeypatch):
    allowed = {"status": "APPROVED", "hostname": "public.example", "address": "93.184.216.34"}
    monkeypatch.setattr(downloader, "check_url_policy", lambda _url: allowed)
    monkeypatch.setattr(downloader, "request_checked", lambda *args, **kwargs: FakeResponse(
        b"not a pdf", "application/pdf", 200,
    ))
    with pytest.raises(downloader.DownloadError, match="not_a_real_pdf_signature"):
        downloader.download_pdf("https://public.example/file.pdf")


def test_archive_fallback_returns_provenance(monkeypatch):
    allowed = {"status": "APPROVED", "hostname": "public.example", "address": "93.184.216.34"}
    monkeypatch.setattr(downloader, "check_url_policy", lambda _url: allowed)
    responses = iter([
        FakeResponse(b"blocked", "text/html", 403),
        FakeResponse(b"%PDF-1.7\nbody", "application/pdf", 200),
    ])
    monkeypatch.setattr(downloader, "request_checked", lambda *args, **kwargs: next(responses))

    data, metadata = downloader.download_pdf(
        "https://public.example/source.pdf",
        archive_url="https://web.archive.org/web/20240102112233id_/https://public.example/source.pdf",
    )

    assert data.startswith(b"%PDF-")
    assert metadata["origin"] == "source-archive-20240102112233"


def test_archive_download_rejects_size_mismatch_instead_of_processing_truncated_pdf(monkeypatch):
    allowed = {"status": "APPROVED", "hostname": "public.example", "address": "93.184.216.34"}
    monkeypatch.setattr(downloader, "check_url_policy", lambda _url: allowed)
    monkeypatch.setattr(downloader, "request_checked", lambda *args, **kwargs: FakeResponse(
        b"%PDF-1.7\ntruncated", "application/pdf", 200,
        {"Content-Length": "100"},
    ))

    with pytest.raises(downloader.DownloadError, match="download_truncated"):
        downloader.download_pdf(
            "https://public.example/source.pdf",
            archive_url="https://web.archive.org/web/20240102112233id_/https://public.example/source.pdf",
            archive_length=12345,
        )


def test_download_rejects_archive_length_mismatch(monkeypatch):
    allowed = {"status": "APPROVED", "hostname": "public.example", "address": "93.184.216.34"}
    monkeypatch.setattr(downloader, "check_url_policy", lambda _url: allowed)
    responses = iter([
        FakeResponse(b"blocked", "text/html", 403),
        FakeResponse(b"%PDF-1.7\nbody", "application/pdf", 200),
    ])
    monkeypatch.setattr(downloader, "request_checked", lambda *args, **kwargs: next(responses))

    with pytest.raises(downloader.DownloadError, match="archive_size_mismatch"):
        downloader.download_pdf(
            "https://public.example/source.pdf",
            archive_url="https://web.archive.org/web/20240102112233id_/https://public.example/source.pdf",
            archive_length=999,
        )


def test_cdx_parser_extracts_archive_rows():
    rows = parse_cdx_text(
        "https://public.example/Seniorenwegweiser-2024.pdf 20240102112233 200 12345\n"
        "https://public.example/old.pdf 20190101000000 404 -\n"
        "malformed\n",
    )

    assert [(row.original, row.timestamp, row.status_code, row.length) for row in rows] == [
        ("https://public.example/Seniorenwegweiser-2024.pdf", "20240102112233", 200, 12345),
        ("https://public.example/old.pdf", "20190101000000", 404, None),
    ]


def test_archive_index_retries_empty_response_and_caches_host(monkeypatch):
    calls = []
    sleeps = []
    allowed = {"status": "APPROVED", "hostname": "web.archive.org", "address": "93.184.216.34"}

    class Response(FakeResponse):
        pass

    responses = iter([
        Response(b"", "text/plain", 200),
        Response(
            b"https://public.example/Seniorenwegweiser-2024.pdf 20240102112233 200 123\n",
            "text/plain",
            200,
        ),
    ])
    monkeypatch.setattr(archive_index, "check_url_policy", lambda *_args, **_kwargs: allowed)
    monkeypatch.setattr(
        archive_index,
        "request_checked",
        lambda *args, **kwargs: (calls.append(kwargs["params"]["url"]) or next(responses)),
    )
    index = ArchiveIndex(sleep=lambda seconds: sleeps.append(seconds), request_delay=0)
    budget = DiscoveryBudget(max_requests=20, max_depth=0, max_seconds=10)

    first = index.fetch("www.public.example", budget=budget)
    second = index.fetch("public.example", budget=budget)

    assert len(first.entries) == 1
    assert second == first
    assert calls == ["public.example", "public.example"]
    assert sleeps == [1.0]


def test_revisit_preserves_target_http_status(monkeypatch):
    allowed = {"status": "APPROVED", "hostname": "public.example", "address": "93.184.216.34"}
    monkeypatch.setattr(routes, "check_url_policy", lambda _url: allowed)
    monkeypatch.setattr(routes, "request_checked", lambda *args, **kwargs: FakeResponse(
        b"", "application/pdf", 404,
    ))

    result = routes.revisit(RevisitRequest(url="https://public.example/source.pdf"))

    assert result["http_status"] == 404
    assert result["note"] == "Zielquelle antwortete mit HTTP 404"


def test_robots_disallow_is_cached_and_blocks_only_target_url(monkeypatch):
    requested = []
    monkeypatch.setattr("app.services.policy._resolve_public_addresses", lambda _hostname: ["93.184.216.34"])

    def fake_request(url, **_kwargs):
        requested.append(url)
        response = FakeResponse(b"User-agent: *\nDisallow: /private\n")
        response.text = response.body.decode()
        return response

    monkeypatch.setattr("app.services.policy.request_checked", fake_request)
    cache = RobotsCache()

    blocked = check_url_policy("https://public.example/private/file.html", robots_cache=cache)
    allowed = check_url_policy("https://public.example/public/file.html", robots_cache=cache)

    assert blocked["status"] == "BLOCKED"
    assert blocked["reason"] == "robots_disallow"
    assert allowed["status"] == "APPROVED"
    assert requested == ["https://public.example/robots.txt"]
