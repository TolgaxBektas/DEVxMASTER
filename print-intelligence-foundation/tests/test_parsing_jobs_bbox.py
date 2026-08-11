from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from fastapi.testclient import TestClient
import pytest
from app.main import app
from app.db.base import Base
from app.models import Job
from app.services.bbox import Box, deduplicate_boxes, normalize_bbox
from app.services.jobs import get_or_create, requeue, retry, run_stage, transition
from app.core.config import Settings, validate_auth_config
from app.services.parsing import parse_qwen_response


def test_parser_all_qwen_shapes():
    cases = [
        {"message": {"content": "", "thinking": '```json\n[{"bbox":[1,2,3,4]}]\n```'}},
        "Here is the answer: {'ads': [],}",
        "```json\n{'company': 'A',}\n```",
        '[{"company":"A"}, {"company":"B"}',
        "Keine Anzeigen gefunden.",
        "garbage with no structure",
    ]
    assert parse_qwen_response(cases[0]) == [{"bbox": [1, 2, 3, 4]}]
    assert parse_qwen_response(cases[1]) == {"ads": []}
    assert parse_qwen_response(cases[2]) == {"company": "A"}
    assert parse_qwen_response(cases[3]) == [{"company": "A"}, {"company": "B"}]
    assert parse_qwen_response(cases[4]) == []
    assert parse_qwen_response(cases[5]) == []


def test_bbox_override_clamp_and_page_boxes():
    assert normalize_bbox([-20, -20, 120, 120], (100, 200), (100, 100)) == Box(
        0, 0, 100, 200
    )
    assert normalize_bbox([1, 1, 2, 2], (1000, 1000)) is None
    boxes = [
        normalize_bbox(x, (1000, 1000))
        for x in (
            [70, 68, 925, 264],
            [70, 285, 469, 713],
            [70, 722, 469, 935],
            [718, 340, 930, 935],
        )
    ]
    assert len(deduplicate_boxes(boxes)) == 4


def test_job_retry_dead_and_resume():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        job = Job(stage="render", max_attempts=2)
        session.add(job)
        session.flush()
        transition(job, "running")
        transition(job, "failed", "boom")
        retry(job)
        transition(job, "running")
        transition(job, "failed", "boom")
        assert job.state == "dead"
        assert job.finished_at is not None
        requeue(job)
        assert job.state == "queued"
        resumable = get_or_create(session, 1, "detect")
        resumable.state = "running"
        session.flush()
        assert get_or_create(session, 1, "detect").state == "queued"


def test_cooperative_deadline_fails_without_worker_thread():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        job = Job(stage="extract", max_attempts=2)
        session.add(job)
        session.flush()
        thread_ids = []

        def action(deadline):
            import threading

            thread_ids.append(threading.get_ident())
            raise TimeoutError("stage deadline exceeded")

        import threading

        main_thread = threading.get_ident()
        try:
            run_stage(session, job, action, 0)
        except TimeoutError:
            pass
        assert thread_ids == [main_thread]
        assert job.state == "failed"
        assert "deadline" in job.last_error


def test_auth_configuration_requires_explicit_opt_out():
    with pytest.raises(RuntimeError):
        validate_auth_config(Settings(service_token=None, auth_disabled=False))
    validate_auth_config(Settings(service_token=None, auth_disabled=True))


def test_fastapi_bad_review_decision():
    with TestClient(app) as client:
        response = client.post("/review-queue/1/maybe")
        assert response.status_code == 400
