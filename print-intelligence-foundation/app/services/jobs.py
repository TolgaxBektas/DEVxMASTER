from datetime import datetime, timezone
from time import monotonic
import inspect
from app.models import Job
from sqlalchemy import select
from sqlalchemy.orm import Session


def transition(job: Job, state: str, error: str | None = None) -> Job:
    allowed = {
        "queued": {"running"},
        "running": {"succeeded", "failed"},
        "failed": {"queued", "dead"},
    }
    if state not in allowed.get(job.state, set()):
        raise ValueError(f"invalid transition {job.state} -> {state}")
    if state == "running":
        job.attempts += 1
        job.started_at = datetime.now(timezone.utc)
    if state == "failed":
        job.last_error = error
        state = "dead" if job.attempts >= job.max_attempts else "failed"
    job.state = state
    if state in {"succeeded", "dead"}:
        job.finished_at = datetime.now(timezone.utc)
    return job


def retry(job: Job) -> Job:
    if job.state != "failed":
        raise ValueError("only failed jobs can retry")
    return transition(job, "queued")


def requeue(job: Job) -> Job:
    if job.state not in {"failed", "dead", "succeeded"}:
        raise ValueError("only completed or failed jobs can be requeued")
    job.state, job.attempts, job.finished_at, job.last_error = "queued", 0, None, None
    return job


def get_or_create(
    session: Session, document_id: int, stage: str, max_attempts: int = 3
) -> Job:
    job = session.scalar(
        select(Job).where(Job.document_id == document_id, Job.stage == stage)
    )
    if job is None:
        job = Job(document_id=document_id, stage=stage, max_attempts=max_attempts)
        session.add(job)
        session.flush()
    if job.state == "running":
        job.state = "queued"
        job.last_error = "resumed after interrupted run"
    return job


def run_stage(session: Session, job: Job, action, timeout_seconds: float = 300):
    if job.state == "succeeded":
        return
    if job.state == "dead":
        raise RuntimeError(f"job {job.id} is dead")
    transition(job, "running")
    session.commit()
    deadline = monotonic() + timeout_seconds
    try:
        if "deadline" in inspect.signature(action).parameters:
            action(deadline=deadline)
        else:
            action()
    except Exception as exc:
        transition(job, "failed", str(exc))
        session.commit()
        raise
    transition(job, "succeeded")
    session.commit()
