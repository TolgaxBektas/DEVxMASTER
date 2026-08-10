import fakeredis
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models import DiscoveredCandidate, Document, Source
from app.services.discovery import DiscoveryCrawler, normalize_url
from app.services.queue import RedisQueue
from app.workers.worker import Worker


def test_html_crawl_is_bounded_robots_aware_and_restartable(monkeypatch):
    pages = {
        "https://city.test/robots.txt": (
            200,
            {"content-type": "text/plain"},
            b"User-agent: *\nDisallow: /blocked\n",
        ),
        "https://city.test/": (
            200,
            {"content-type": "text/html"},
            b'<a href="/nested">Nested</a><a href="/one.pdf">One</a>'
            b'<a href="https://other.test/out.pdf">External</a>'
            b'<a href="/no-content-type">No type</a>',
        ),
        "https://city.test/nested": (
            200,
            {"content-type": "text/html"},
            b'<a href="/two.pdf#fragment">Two</a><a href="/blocked/x.pdf">Blocked</a>'
            b'<a href="/dead">Dead</a>',
        ),
        "https://city.test/dead": (500, {}, b""),
        "https://city.test/no-content-type": (
            200,
            {},
            b'<a href="/three.pdf">Three</a>',
        ),
    }
    monkeypatch.setattr(
        "app.services.discovery.fetch_url",
        lambda url, limit: pages[url],
    )
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        source = Source(base_url="https://city.test/", label="City", crawl_strategy="html")
        session.add(source)
        session.commit()
        crawler = DiscoveryCrawler(session, max_depth=2, max_pages=5)
        assert crawler.crawl(source) == {"discovered": 3, "skipped": 0}
        assert crawler.crawl(source) == {"discovered": 0, "skipped": 3}
        candidates = session.scalars(select(DiscoveredCandidate)).all()
        assert {candidate.normalized_url for candidate in candidates} == {
            normalize_url("https://city.test/one.pdf"),
            normalize_url("https://city.test/two.pdf"),
            normalize_url("https://city.test/three.pdf"),
        }


def test_sitemap_index_nested_and_malformed_entries_continue(monkeypatch):
    pages = {
        "https://city.test/robots.txt": (404, {}, b""),
        "https://city.test/sitemap.xml": (
            200,
            {"content-type": "application/xml"},
            b"<sitemapindex><sitemap><loc>https://city.test/nested.xml</loc></sitemap>"
            b"<sitemap><loc>https://city.test/bad.xml</loc></sitemap></sitemapindex>",
        ),
        "https://city.test/nested.xml": (
            200,
            {"content-type": "application/xml"},
            b"<urlset><url><loc>https://city.test/a.pdf</loc></url>"
            b"<url><loc>https://city.test/b.pdf?x=1</loc></url></urlset>",
        ),
        "https://city.test/bad.xml": (200, {"content-type": "application/xml"}, b"<bad"),
    }
    monkeypatch.setattr(
        "app.services.discovery.fetch_url", lambda url, limit: pages[url]
    )
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        source = Source(
            base_url="https://city.test/", label="City", crawl_strategy="sitemap"
        )
        session.add(source)
        session.commit()
        result = DiscoveryCrawler(session, max_depth=2).crawl(source)
        assert result == {"discovered": 2, "skipped": 0}


def test_candidate_content_hash_reuses_existing_document(monkeypatch):
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        source = Source(base_url="https://city.test/", label="City")
        document = Document(content_sha256="a" * 64, filename="known.pdf")
        session.add_all([source, document])
        session.flush()
        candidate = DiscoveredCandidate(
            source_id=source.id,
            url="https://city.test/new.pdf",
            normalized_url=normalize_url("https://city.test/new.pdf"),
        )
        session.add(candidate)
        session.commit()
        monkeypatch.setattr(
            "app.services.discovery.download", lambda url, limit: b"known bytes"
        )
        monkeypatch.setattr(
            "app.services.discovery.sha256", lambda data: "a" * 64
        )
        assert DiscoveryCrawler(session).process_candidate(candidate).id == document.id
        assert candidate.state == "skipped"
        assert candidate.document_id == document.id


def test_redis_queue_dedupes_recovers_retries_and_counts(monkeypatch):
    client = fakeredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr("app.services.queue.redis.Redis.from_url", lambda *a, **k: client)
    queue = RedisQueue("redis://unused", "jobs", visibility_timeout=1, max_attempts=2, backoff_seconds=0)
    assert queue.enqueue(7)
    assert not queue.enqueue(7)
    item = queue.consume(timeout=0)
    assert item["document_id"] == 7
    client.hset("jobs:visibility", item["queue_id"], 0)
    assert queue.recover_stale() == 1
    item = queue.consume(timeout=0)
    assert queue.retry(item, "first failure")
    item = queue.consume(timeout=0)
    assert not queue.retry(item, "second failure")
    assert queue.stats()["dead_letter"] == 1
    assert queue.stats()["requeued"] == 1
    assert queue.stats()["failed"] == 2


def test_worker_shutdown_releases_inflight_item(monkeypatch):
    client = fakeredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr("app.services.queue.redis.Redis.from_url", lambda *a, **k: client)
    queue = RedisQueue("redis://unused", "jobs", visibility_timeout=60)
    queue.enqueue(9)
    item = queue.consume(timeout=0)
    worker = Worker(queue=queue)
    worker.current = item
    worker.stop()
    assert queue.stats()["depth"] == 1
    assert queue.stats()["in_flight"] == 0
