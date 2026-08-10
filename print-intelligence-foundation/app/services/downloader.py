from urllib.parse import urlparse
import ipaddress
import socket
import httpx


def validate_public_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("only http(s) URLs are accepted")
    try:
        addresses = socket.getaddrinfo(parsed.hostname, None)
        for address in addresses:
            if (
                ipaddress.ip_address(address[4][0]).is_private
                or ipaddress.ip_address(address[4][0]).is_loopback
            ):
                raise ValueError("private URL is not allowed")
    except socket.gaierror as exc:
        raise ValueError("URL host cannot be resolved") from exc


def download(url: str, max_bytes: int = 50_000_000) -> bytes:
    validate_public_url(url)
    with httpx.stream("GET", url, follow_redirects=False, timeout=30) as response:
        response.raise_for_status()
        content_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
        if content_type and content_type not in {
            "application/pdf",
            "application/octet-stream",
        }:
            raise ValueError("URL does not return a PDF")
        data = bytearray()
        for chunk in response.iter_bytes():
            data.extend(chunk)
            if len(data) > max_bytes:
                raise ValueError("download exceeds maximum size")
        return bytes(data)
