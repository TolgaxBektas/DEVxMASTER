import pytest

from app.services import discovery, downloader, sitemap
from app.services.policy import DiscoveryBudget, read_limited_response
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


def test_revisit_preserves_target_http_status(monkeypatch):
    allowed = {"status": "APPROVED", "hostname": "public.example", "address": "93.184.216.34"}
    monkeypatch.setattr(routes, "check_url_policy", lambda _url: allowed)
    monkeypatch.setattr(routes, "request_checked", lambda *args, **kwargs: FakeResponse(
        b"", "application/pdf", 404,
    ))

    result = routes.revisit(RevisitRequest(url="https://public.example/source.pdf"))

    assert result["http_status"] == 404
    assert result["note"] == "Zielquelle antwortete mit HTTP 404"
