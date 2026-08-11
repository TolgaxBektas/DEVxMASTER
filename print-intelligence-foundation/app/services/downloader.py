from urllib.parse import urlparse
import ipaddress
import socket
import httpx
import re
from app.services.storage import sha256


def fetch_url(url: str, max_bytes: int = 50_000_000):
    status, headers, data, _ = _fetch_url(url, max_bytes)
    return status, headers, data


def fetch_url_with_metadata(url: str, max_bytes: int = 50_000_000):
    return _fetch_url(url, max_bytes)


def _fetch_url(url: str, max_bytes: int = 50_000_000):
    current = url
    for _ in range(5):
        validate_public_url(current)
        with httpx.stream("GET", current, follow_redirects=False, timeout=30) as response:
            if response.is_redirect:
                location = response.headers.get("location")
                if not location:
                    raise ValueError("redirect has no location")
                current = str(httpx.URL(current).join(location))
                continue
            data = bytearray()
            for chunk in response.iter_bytes():
                data.extend(chunk)
                if len(data) > max_bytes:
                    raise ValueError("download exceeds maximum size")
            return response.status_code, response.headers, bytes(data), current
    raise ValueError("too many redirects")


def validate_public_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("only http(s) URLs are accepted")
    try:
        addresses = socket.getaddrinfo(parsed.hostname, None)
        for address in addresses:
            ip = ipaddress.ip_address(address[4][0])
            if (
                ip.is_private
                or ip.is_loopback
                or ip.is_reserved
                or ip.is_link_local
                or ip.is_unspecified
                or ip.is_multicast
                or (isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped)
            ):
                raise ValueError("private URL is not allowed")
    except socket.gaierror as exc:
        raise ValueError("URL host cannot be resolved") from exc


def download(url: str, max_bytes: int = 50_000_000) -> bytes:
    status, headers, data = fetch_url(url, max_bytes)
    if status >= 400:
        raise ValueError(f"URL returned HTTP {status}")
    content_type = headers.get("content-type", "").split(";", 1)[0].lower()
    if content_type and content_type not in {
        "application/pdf",
        "application/octet-stream",
    }:
        raise ValueError("URL does not return a PDF")
    return data


def download_with_metadata(url: str, max_bytes: int = 50_000_000):
    status, headers, data, final_url = fetch_url_with_metadata(url, max_bytes)
    if status >= 400:
        raise ValueError(f"URL returned HTTP {status}")
    content_type = headers.get("content-type", "").split(";", 1)[0].lower()
    if content_type and content_type not in {
        "application/pdf",
        "application/octet-stream",
    }:
        raise ValueError("URL does not return a PDF")
    disposition = headers.get("content-disposition", "")
    match = re.search(r'filename="?([^";]+)"?', disposition)
    filename = match.group(1) if match else urlparse(final_url).path.rsplit("/", 1)[-1]
    return data, {
        "final_url": final_url,
        "sha256": sha256(data),
        "filename": sanitize_filename(filename),
    }


def sanitize_filename(filename: str) -> str:
    filename = filename.replace("\\", "/").rsplit("/", 1)[-1]
    filename = "".join(
        character for character in filename if 32 <= ord(character) != 127
    ).strip(" .")
    return (filename or "source.pdf")[:255]
