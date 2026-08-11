import json
import time
import uuid

import redis


class RedisQueue:
    def __init__(
        self,
        url: str,
        name: str,
        visibility_timeout: float = 60,
        max_attempts: int = 3,
        backoff_seconds: float = 1,
    ):
        self.client = redis.Redis.from_url(url, decode_responses=True)
        self.name = name
        self.processing_name = f"{name}:processing"
        self.dead_name = f"{name}:dead"
        self.visibility_timeout = visibility_timeout
        self.max_attempts = max_attempts
        self.backoff_seconds = backoff_seconds

    def _dedupe_key(self, item):
        identity = item.get("document_id") or f"candidate:{item['candidate_id']}"
        return f"{self.name}:dedupe:{identity}"

    def enqueue(self, document_id: int) -> bool:
        return self._enqueue({"document_id": document_id, "attempt": 0})

    def enqueue_candidate(self, candidate_id: int) -> bool:
        return self._enqueue({"candidate_id": candidate_id, "attempt": 0})

    def _enqueue(self, item):
        item["queue_id"] = item.get("queue_id") or uuid.uuid4().hex
        if not self.client.set(self._dedupe_key(item), "1", nx=True):
            return False
        self.client.rpush(self.name, json.dumps(item))
        return True

    def health(self) -> bool:
        try:
            return self.client.ping()
        except redis.RedisError:
            return False

    def consume(self, timeout: int = 5):
        self.recover_stale()
        raw = self.client.brpoplpush(self.name, self.processing_name, timeout)
        if not raw:
            return None
        item = json.loads(raw)
        available_at = item.get("available_at", 0)
        if available_at > time.time():
            self.client.lrem(self.processing_name, 1, raw)
            self.client.rpush(self.name, raw)
            time.sleep(min(available_at - time.time(), 0.1))
            return None
        self.client.hset(
            f"{self.name}:visibility",
            item["queue_id"],
            time.time() + self.visibility_timeout,
        )
        item["_raw"] = raw
        return item

    def ack(self, item) -> None:
        self._remove_processing(item)
        self.client.delete(self._dedupe_key(item))
        self.client.hincrby(f"{self.name}:metrics", "processed", 1)

    def release(self, item) -> None:
        self._remove_processing(item)
        self.client.rpush(self.name, item["_raw"])

    def retry(self, item, error: str = "") -> bool:
        attempt = int(item.get("attempt", 0)) + 1
        self._remove_processing(item)
        self.client.hincrby(f"{self.name}:metrics", "failed", 1)
        if attempt >= self.max_attempts:
            self.client.rpush(
                self.dead_name,
                json.dumps({**item, "attempt": attempt, "error": error}),
            )
            self.client.delete(self._dedupe_key(item))
            self.client.hincrby(f"{self.name}:metrics", "dead", 1)
            return False
        item["attempt"] = attempt
        item["available_at"] = time.time() + self.backoff_seconds * (2 ** (attempt - 1))
        self.client.rpush(self.name, json.dumps(item))
        return True

    def recover_stale(self) -> int:
        recovered = 0
        now = time.time()
        visibility = f"{self.name}:visibility"
        for raw in self.client.lrange(self.processing_name, 0, -1):
            item = json.loads(raw)
            expires = self.client.hget(visibility, item["queue_id"])
            if not expires or float(expires) <= now:
                self.client.lrem(self.processing_name, 1, raw)
                self.client.hdel(visibility, item["queue_id"])
                self.client.rpush(self.name, raw)
                recovered += 1
        if recovered:
            self.client.hincrby(f"{self.name}:metrics", "requeued", recovered)
        return recovered

    def _remove_processing(self, item):
        self.client.lrem(self.processing_name, 1, item["_raw"])
        self.client.hdel(f"{self.name}:visibility", item["queue_id"])

    def stats(self):
        metrics = self.client.hgetall(f"{self.name}:metrics")
        return {
            "depth": self.client.llen(self.name),
            "in_flight": self.client.llen(self.processing_name),
            "dead_letter": self.client.llen(self.dead_name),
            "processed": int(metrics.get("processed", 0)),
            "failed": int(metrics.get("failed", 0)),
            "dead": int(metrics.get("dead", 0)),
            "requeued": int(metrics.get("requeued", 0)),
        }
