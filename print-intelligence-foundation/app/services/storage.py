import hashlib
from pathlib import Path
from typing import Protocol
import boto3
from botocore.exceptions import ClientError


class Storage(Protocol):
    def put(self, data: bytes, name: str): ...
    def put_file(self, source: str | Path, name: str): ...
    def get(self, name: str) -> bytes: ...
    def exists(self, name: str) -> bool: ...
    def health(self) -> bool: ...


class LocalStorage:
    def __init__(self, root: str | Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def put(self, data: bytes, name: str) -> str:
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return name

    def put_file(self, source: str | Path, name: str) -> str:
        return self.put(Path(source).read_bytes(), name)

    def get(self, name: str) -> bytes:
        return (self.root / name).read_bytes()

    def exists(self, name: str) -> bool:
        return (self.root / name).is_file()

    def health(self) -> bool:
        return self.root.exists()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class S3Storage:
    def __init__(
        self,
        bucket: str,
        endpoint_url: str | None = None,
        access_key: str | None = None,
        secret_key: str | None = None,
        region: str = "us-east-1",
    ):
        self.bucket = bucket
        self.client = boto3.client(
            "s3",
            endpoint_url=endpoint_url,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name=region,
        )

    def put(self, data: bytes, name: str) -> str:
        self.client.put_object(Bucket=self.bucket, Key=name, Body=data)
        return f"s3://{self.bucket}/{name}"

    def put_file(self, source: str | Path, name: str) -> str:
        self.client.upload_file(str(source), self.bucket, name)
        return f"s3://{self.bucket}/{name}"

    def get(self, name: str) -> bytes:
        key = name.removeprefix(f"s3://{self.bucket}/")
        return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()

    def exists(self, name: str) -> bool:
        key = name.removeprefix(f"s3://{self.bucket}/")
        try:
            self.client.head_object(Bucket=self.bucket, Key=key)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {"404", "NoSuchKey", "NotFound"}:
                return False
            raise
        return True

    def health(self) -> bool:
        try:
            self.client.head_bucket(Bucket=self.bucket)
            return True
        except Exception:
            return False
