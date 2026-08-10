from urllib.parse import urljoin
from bs4 import BeautifulSoup


def discover_pdf_links(html: str, base_url: str = "") -> list[str]:
    soup = BeautifulSoup(html, "html.parser")
    return list(
        dict.fromkeys(
            urljoin(base_url, a.get("href"))
            for a in soup.find_all("a", href=True)
            if a["href"].lower().split("?")[0].endswith(".pdf")
        )
    )
