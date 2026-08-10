from unittest.mock import Mock
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.api.dependencies import session_dependency
from app.api import health as health_router
from app.db.base import Base
from app.main import app
from app.models import ReviewItem
from app.services.classify import classify_page
from app.services.pipeline import Pipeline
from app.services.storage import LocalStorage, S3Storage
from app.services.downloader import validate_public_url
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
