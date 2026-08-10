from unittest.mock import Mock
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import socket
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.api.dependencies import session_dependency
from app.api import health as health_router
from app.db.base import Base
from app.main import app
from app.models import AdOccurrence, Document, Job, Page, ReviewItem
from app.services.classify import classify_page
from app.services.pipeline import Pipeline
from app.services.storage import LocalStorage, S3Storage
from app.services.downloader import validate_public_url
from app.core.config import Settings
from app.services.vision.recorded import RecordedVisionProvider


@pytest.fixture
def isolated_db(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'api.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    yield engine, factory


def test_s3_storage_mock(monkeypatch):
    client = Mock()
    body = Mock()
    body.read.return_value = b"data"
    client.get_object.return_value = {"Body": body}
    monkeypatch.setattr(
        "app.services.storage.boto3.client", lambda *args, **kwargs: client
    )
    storage = S3Storage("bucket")
    assert storage.put(b"abc", "x.pdf") == "s3://bucket/x.pdf"
    assert storage.get("x.pdf") == b"data"
    client.put_object.assert_called_once()


def test_classification_real_pages():
    pdf = "tests/fixtures/Seniorenpost_Mai_Juni_2026.pdf"
    values = [classify_page(pdf, n) for n in (1, 5, 11, 20)]
    assert all(
        value in {"cover", "editorial", "ad-page", "mixed", "blank"} for value in values
    )
    assert values[2] != "blank"


def test_health_degraded_when_dependencies_unavailable(monkeypatch):
    monkeypatch.setattr(health_router, "engine", create_engine("sqlite://"))
    monkeypatch.setattr(
        health_router, "make_provider", lambda settings: Mock(available=lambda: False)
    )
    monkeypatch.setattr(health_router.RedisQueue, "health", lambda self: False)
    with TestClient(app) as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "degraded"
    assert response.json()["vision"] is False
    assert response.json()["redis"] is False


def test_upload_duplicate_and_size_rejection(monkeypatch, isolated_db, tmp_path):
    _, factory = isolated_db
    monkeypatch.setattr(
        "app.api.documents.pipeline_dependency",
        lambda session: Pipeline(
            session,
            RecordedVisionProvider("tests/fixtures/qwen"),
            LocalStorage(tmp_path / "storage"),
            render_dpi=12,
            local_work_dir=tmp_path / "work",
        ),
    )

    def override():
        with factory() as session:
            yield session

    app.dependency_overrides[session_dependency] = override
    try:
        with TestClient(app) as client:
            payload = {
                "file": (
                    "x.pdf",
                    open("tests/fixtures/Seniorenpost_Mai_Juni_2026.pdf", "rb"),
                    "application/pdf",
                )
            }
            first = client.post("/documents/upload", files=payload)
            payload["file"][1].seek(0)
            second = client.post("/documents/upload", files=payload)
            assert first.status_code == second.status_code == 200
            assert second.json()["document_id"] == first.json()["document_id"]
            monkeypatch.setattr(
                "app.api.documents.get_settings",
                lambda: type("S", (), {"max_download_bytes": 2})(),
            )
            payload["file"][1].seek(0)
            assert client.post("/documents/upload", files=payload).status_code == 413
    finally:
        app.dependency_overrides.clear()


@pytest.mark.parametrize(
    "payload",
    [b"", b"not a pdf", Path("tests/fixtures/Seniorenpost_Mai_Juni_2026.pdf").read_bytes()[:100]],
)
def test_malformed_upload_is_rejected_before_persistence(
    monkeypatch, isolated_db, tmp_path, payload
):
    _, factory = isolated_db
    monkeypatch.setattr(
        "app.api.documents.pipeline_dependency",
        lambda: pytest.fail("pipeline must not run for malformed PDF"),
    )

    def override():
        with factory() as session:
            yield session

    app.dependency_overrides[session_dependency] = override
    try:
        with TestClient(app) as client:
            response = client.post(
                "/documents/upload",
                files={"file": ("broken.pdf", payload, "application/pdf")},
            )
            assert response.status_code == 400
        with factory() as session:
            assert session.query(Document).count() == 0
            assert session.query(Job).count() == 0
    finally:
        app.dependency_overrides.clear()


def test_malformed_url_ingest_is_rejected_before_persistence(
    monkeypatch, isolated_db
):
    _, factory = isolated_db
    monkeypatch.setattr(
        "app.api.documents.download", lambda url, limit: b"truncated pdf"
    )

    def override():
        with factory() as session:
            yield session

    app.dependency_overrides[session_dependency] = override
    try:
        with TestClient(app) as client:
            response = client.post(
                "/documents/url", params={"url": "https://example.test/file.pdf"}
            )
            assert response.status_code == 400
        with factory() as session:
            assert session.query(Document).count() == 0
            assert session.query(Job).count() == 0
    finally:
        app.dependency_overrides.clear()


def test_concurrent_duplicate_uploads_are_serialized(monkeypatch, isolated_db, tmp_path):
    _, factory = isolated_db
    monkeypatch.setattr(
        "app.api.documents.pipeline_dependency",
        lambda session: Pipeline(
            session,
            RecordedVisionProvider("tests/fixtures/qwen"),
            LocalStorage(tmp_path / "storage"),
            render_dpi=12,
            local_work_dir=tmp_path / "work",
        ),
    )

    def override():
        with factory() as session:
            yield session

    app.dependency_overrides[session_dependency] = override
    data = Path("tests/fixtures/Seniorenpost_Mai_Juni_2026.pdf").read_bytes()

    def upload_once(_):
        with TestClient(app) as client:
            return client.post(
                "/documents/upload",
                files={"file": ("fixture.pdf", data, "application/pdf")},
            )

    try:
        with ThreadPoolExecutor(max_workers=3) as pool:
            responses = list(pool.map(upload_once, range(3)))
        assert [response.status_code for response in responses] == [200, 200, 200]
        ids = {response.json()["document_id"] for response in responses}
        assert len(ids) == 1
        with factory() as session:
            assert session.query(Document).count() == 1
            assert session.query(Page).count() == 44
            assert session.query(AdOccurrence).count() == 4
            assert session.query(Job).count() == 6
    finally:
        app.dependency_overrides.clear()


def test_url_rejects_private_and_non_http(monkeypatch):
    monkeypatch.setattr(
        "app.api.documents.download",
        lambda url, limit: (_ for _ in ()).throw(
            ValueError("private URL is not allowed")
        ),
    )
    with TestClient(app) as client:
        assert (
            client.post(
                "/documents/url", params={"url": "http://localhost/file.pdf"}
            ).status_code
            == 400
        )
        assert (
            client.post(
                "/documents/url", params={"url": "file:///etc/passwd"}
            ).status_code
            == 400
        )
    monkeypatch.setattr(
        "app.api.documents.download",
        lambda url, limit: (_ for _ in ()).throw(
            ValueError("URL does not return a PDF")
        ),
    )
    with TestClient(app) as client:
        assert (
            client.post(
                "/documents/url", params={"url": "https://example.test/page"}
            ).status_code
            == 400
        )
    with pytest.raises(ValueError):
        validate_public_url("http://127.0.0.1/file.pdf")
    with pytest.raises(ValueError):
        validate_public_url("ftp://example.test/file.pdf")


def test_auth_rejects_missing_and_accepts_bearer(monkeypatch):
    monkeypatch.setattr(
        "app.api.auth.get_settings",
        lambda: Settings(service_token="secret", auth_disabled=False),
    )
    with TestClient(app) as client:
        assert client.get("/documents/1").status_code == 401
        assert client.get(
            "/documents/1", headers={"Authorization": "Bearer secret"}
        ).status_code == 404


def test_redirect_to_private_target_is_rejected(monkeypatch):
    class Response:
        is_redirect = True
        headers = {"location": "http://127.0.0.1/private.pdf"}

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

    calls = []

    def validate(url):
        calls.append(url)
        if "127.0.0.1" in url:
            raise ValueError("private URL is not allowed")

    monkeypatch.setattr("app.services.downloader.validate_public_url", validate)
    monkeypatch.setattr(
        "app.services.downloader.httpx.stream", lambda *a, **k: Response()
    )
    with pytest.raises(ValueError):
        from app.services.downloader import download

        download("https://example.test/start.pdf")
    assert calls == ["https://example.test/start.pdf", "http://127.0.0.1/private.pdf"]


@pytest.mark.parametrize(
    "address",
    [
        "192.0.2.1",
        "169.254.1.1",
        "0.0.0.0",
        "224.0.0.1",
        "::",
        "ff02::1",
        "::ffff:127.0.0.1",
    ],
)
def test_validate_public_url_rejects_unsafe_resolved_addresses(monkeypatch, address):
    family = socket.AF_INET6 if ":" in address else socket.AF_INET
    monkeypatch.setattr(
        "app.services.downloader.socket.getaddrinfo",
        lambda *args, **kwargs: [(family, socket.SOCK_STREAM, 6, "", (address, 0))],
    )
    with pytest.raises(ValueError, match="private"):
        validate_public_url("https://example.test/file.pdf")


def test_validate_public_url_checks_every_resolved_address(monkeypatch):
    monkeypatch.setattr(
        "app.services.downloader.socket.getaddrinfo",
        lambda *args, **kwargs: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 0)),
        ],
    )
    with pytest.raises(ValueError, match="private"):
        validate_public_url("https://example.test/file.pdf")


def test_review_actions(isolated_db):
    _, factory = isolated_db

    def override():
        with factory() as session:
            yield session

    app.dependency_overrides[session_dependency] = override
    try:
        with factory() as session:
            item = ReviewItem(ad_id=1, reason="test")
            session.add(item)
            session.commit()
            item_id = item.id
        with TestClient(app) as client:
            assert client.post(f"/review-queue/{item_id}/approve").status_code == 200
            assert client.post(f"/review-queue/{item_id}/reject").status_code == 200
    finally:
        app.dependency_overrides.clear()
