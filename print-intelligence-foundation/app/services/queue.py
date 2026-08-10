import json
import redis


class RedisQueue:
    def __init__(self, url: str, name: str):
        self.client = redis.Redis.from_url(url, decode_responses=True)
        self.name = name

    def enqueue(self, document_id: int) -> None:
        self.client.rpush(self.name, json.dumps({"document_id": document_id}))

    def health(self) -> bool:
        try:
            return self.client.ping()
        except redis.RedisError:
            return False

    def consume(self, timeout: int = 5):
        item = self.client.blpop(self.name, timeout=timeout)
        return json.loads(item[1]) if item else None
