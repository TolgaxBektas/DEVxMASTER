import pytest

from app.services import autodiscovery, discovery
from app.services.archive_index import (
    ArchiveIndex,
    ArchiveIndexResult,
    ArchivePdf,
    deduplicate_archive_entries,
)
from app.services.discovery import (
    MAX_SECOND_LEVEL_LINKS,
    MIN_CANDIDATE_SCORE,
    candidate_rejection_reason,
    discover_pdf_links,
    score_candidate,
)
from app.services.policy import DiscoveryBudget


def test_discovery_follows_bounded_second_level_publication_links(monkeypatch):
    root = "https://kreis.example/"
    nested = [f"https://kreis.example/service/{index}" for index in range(MAX_SECOND_LEVEL_LINKS + 2)]
    requests = []

    class Response:
        def __init__(self, url, body):
            self.url = url
            self.body = body
            self.status_code = 200
            self.headers = {"content-type": "text/html"}

        def iter_content(self, _size):
            yield self.body

        def close(self):
            pass

    pages = {
        root: Response(
            root,
            ("".join(f"<a href='{url}'>Downloads {index}</a>" for index, url in enumerate(nested))
             + "<a href='https://other.example/downloads'>Downloads außen</a>").encode(),
        ),
        **{
            url: Response(
                url,
                f"<a href='/download/Seniorenwegweiser-2026-{index}.pdf'>PDF</a>".encode(),
            )
            for index, url in enumerate(nested)
        },
    }
    monkeypatch.setattr(discovery, "check_url_policy", lambda _url, **_kwargs: {
        "status": "APPROVED", "hostname": "kreis.example", "address": "93.184.216.34",
    })
    monkeypatch.setattr(discovery, "request_checked", lambda url, **_kwargs: (requests.append(url) or pages[url]))

    results = discover_pdf_links(
        root,
        budget=DiscoveryBudget(max_requests=30, max_depth=1, max_seconds=10),
    )

    assert requests == [root, *nested[:MAX_SECOND_LEVEL_LINKS]]
    assert len(results) == MAX_SECOND_LEVEL_LINKS
    assert all(item["discovery"] == "html_link_second_level" for item in results)


def test_discovery_does_not_follow_a_third_level(monkeypatch):
    root = "https://kreis.example/"
    nested = "https://kreis.example/downloads"
    requested = []

    class Response:
        status_code = 200
        headers = {"content-type": "text/html"}
        url = root

        def iter_content(self, _size):
            yield b"<a href='/downloads'>Downloads</a>"

        def close(self):
            pass

    monkeypatch.setattr(discovery, "check_url_policy", lambda _url, **_kwargs: {
        "status": "APPROVED", "hostname": "kreis.example", "address": "93.184.216.34",
    })
    monkeypatch.setattr(discovery, "request_checked", lambda url, **_kwargs: (requested.append(url) or Response()))

    discover_pdf_links(
        nested,
        budget=DiscoveryBudget(max_requests=10, max_depth=2, max_seconds=10),
        depth=1,
    )

    assert requested == [nested]


def test_discovery_marks_small_reload_challenge(monkeypatch):
    rejected = []

    class Response:
        status_code = 200
        headers = {"content-type": "text/html"}
        url = "https://kreis.example/"

        def iter_content(self, _size):
            yield b"<script>location.reload()</script>"

        def close(self):
            pass

    monkeypatch.setattr(discovery, "check_url_policy", lambda _url, **_kwargs: {
        "status": "APPROVED", "hostname": "kreis.example", "address": "93.184.216.34",
    })
    monkeypatch.setattr(discovery, "request_checked", lambda *_args, **_kwargs: Response())

    assert discovery.discover_pdf_links("https://kreis.example/", rejected=rejected) == []
    assert rejected[0]["reason"] == "bot_challenge"


def test_discovery_records_page_errors_instead_of_swallowing_them(monkeypatch):
    rejected = []
    monkeypatch.setattr(autodiscovery, "discover_pdf_links", lambda *args, **kwargs: (_ for _ in ()).throw(
        RuntimeError("discovery_request_budget_exceeded"),
    ))
    monkeypatch.setattr(autodiscovery, "discover_sitemaps", lambda *args, **kwargs: (_ for _ in ()).throw(
        RuntimeError("sitemap_unavailable"),
    ))
    monkeypatch.setattr(autodiscovery, "web_search", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(ArchiveIndex, "fetch_many", lambda *_args, **_kwargs: {})

    assert autodiscovery.discover_proposals(
        ["https://kreis.example/"],
        [],
        area_name="Kreis",
        rejected=rejected,
        archive_domains=[],
    ) == []
    assert [item["reason"] for item in rejected] == ["crawl_error", "crawl_error"]
    assert rejected[0]["error_type"] == "RuntimeError"


def test_archive_timestamp_cannot_make_an_old_url_current(monkeypatch):
    archive = ArchivePdf(
        original="https://kreis.example/Seniorenwegweiser-2019.pdf",
        timestamp="20250102112233",
        status_code=404,
        length=None,
        archive_url="https://web.archive.org/web/20250102112233id_/https://kreis.example/Seniorenwegweiser-2019.pdf",
    )
    monkeypatch.setattr(ArchiveIndex, "fetch_many", lambda *_args, **_kwargs: {
        "kreis.example": ArchiveIndexResult(entries=(archive,)),
    })
    monkeypatch.setattr(autodiscovery, "web_search", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(autodiscovery, "discover_pdf_links", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(autodiscovery, "discover_sitemaps", lambda *_args, **_kwargs: [])

    rejected = []
    proposals = autodiscovery.discover_proposals(
        [],
        [],
        area_name="Kreis",
        rejected=rejected,
        archive_domains=["kreis.example"],
    )

    assert proposals == []
    assert rejected[0]["reason"].startswith("Jahreszahl älter als")


@pytest.mark.parametrize("url", [
    "https://www.gottenheim.de/Liederkranz/130Jahre/2005_MGV_Festschrift.pdf",
    "https://www.gottenheim.de/Musikverein/125Jahre/2007_MV_Festschrift.pdf",
    "https://www.gottenheim.de/WG/50Jahre/2010_WG_Festschrift.pdf",
    "https://www.boetzingen.de/site/Boetzingen/get/params_E976260030_Dattachment/3638149/B%C3%96TZINGEN_Gastgeberverzeichnis%202017.pdf",
])
def test_evidence_old_url_years_remain_rejected_with_current_archive_timestamp(url):
    assert candidate_rejection_reason(
        url,
        archive_timestamp="20260827000000",
    ).startswith("Jahreszahl älter als")


def test_archive_timestamp_is_age_fallback_without_url_year(monkeypatch):
    archive = ArchivePdf(
        original="https://kreis.example/Seniorenwegweiser.pdf",
        timestamp="20200102112233",
        status_code=404,
        length=None,
        archive_url="https://web.archive.org/web/20200102112233id_/https://kreis.example/Seniorenwegweiser.pdf",
    )
    monkeypatch.setattr(ArchiveIndex, "fetch_many", lambda *_args, **_kwargs: {
        "kreis.example": ArchiveIndexResult(entries=(archive,)),
    })
    monkeypatch.setattr(autodiscovery, "web_search", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(autodiscovery, "discover_pdf_links", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(autodiscovery, "discover_sitemaps", lambda *_args, **_kwargs: [])

    rejected = []
    proposals = autodiscovery.discover_proposals(
        [], [], area_name="Kreis", rejected=rejected, archive_domains=["kreis.example"],
    )
    assert proposals == []
    assert rejected[0]["reason"].startswith("Jahreszahl älter als")

def test_pdf_publication_scores_high():
    assert score_candidate('https://example.org/Seniorenwegweiser-2026.pdf') >= 50

def test_irrelevant_low():
    assert score_candidate('https://example.org/index.html') < 40


def test_publication_requirement_and_threshold():
    assert candidate_rejection_reason("https://example.org/document.pdf")
    assert score_candidate("https://example.org/Seniorenwegweiser.pdf") >= MIN_CANDIDATE_SCORE


@pytest.mark.parametrize("signal", [
    "satzung", "geschäftsordnung", "ehrungsordnung", "datenschutz",
    "nutzungsbedingungen", "impressum", "formular", "antrag",
    "verwendungsnachweis", "protokoll", "niederschrift", "tagesordnung",
    "bekanntmachung", "haushaltsplan", "statistik", "statistischer",
    "pressemitteilung", "presseinformation", "leseprobe", "gesetz",
    "verordnung", "richtlinie", "merkblatt", "dossier", "strategiepapier",
    "präsentation", "ausschreibung", "stellenangebot", "kontaktliste",
    "befragung",
])
def test_veto_signals_are_rejected(signal):
    assert candidate_rejection_reason(f"https://example.org/Seniorenwegweiser-{signal}.pdf")


def test_veto_matching_is_case_and_umlaut_robust():
    assert candidate_rejection_reason("https://example.org/SENIORENWEGWEISER-GESCHAEFTSORDNUNG.pdf")
    assert candidate_rejection_reason("https://example.org/Seniorenwegweiser-Datenschutzerklärung.pdf")


def test_age_veto_and_current_brochure_bonus():
    assert candidate_rejection_reason("https://www.stadt.example/Seniorenwegweiser-2019.pdf", "Seniorenwegweiser")
    assert candidate_rejection_reason("https://www.stadt.example/Seniorenwegweiser-2026.pdf") is None
    assert score_candidate(
        "https://www.landkreis-beispiel.de/download/Seniorenwegweiser-2026.pdf",
        area_name="Beispiel",
    ) > score_candidate("https://files.example/download/Seniorenwegweiser-2026.pdf", area_name="Beispiel")


def test_age_veto_uses_latest_year_from_wordpress_upload_path():
    url = (
        "https://www.landkreis-beispiel.de/wp-content/uploads/2019/06/"
        "Seniorenwegweiser_2026.pdf"
    )
    assert candidate_rejection_reason(url) is None


@pytest.mark.parametrize("term", [
    "wegweiser", "ratgeber", "pflegewegweiser", "familienwegweiser",
    "klinikfuehrer", "klinikführer", "gewerbeverzeichnis", "firmenverzeichnis",
])
def test_extended_publication_terms_are_accepted(term):
    assert candidate_rejection_reason(f"https://example.org/{term}_2026.pdf") is None


def test_extended_publication_terms_do_not_bypass_veto():
    assert candidate_rejection_reason(
        "https://example.org/Seniorenwegweiser_Datenschutzerklärung.pdf",
    ).startswith("Ausschlusssignal:")


def test_archive_entries_are_deduplicated_by_filename_and_length():
    entries = [
        ArchivePdf(
            original=f"https://example.org/_Resources/Persistent/{index}/Gastgeberverzeichnis%20Breisach%20am%20Rhein%202025.pdf",
            timestamp=f"2026010{index}000000",
            status_code=200,
            length=734724,
            archive_url="archive",
        )
        for index in (1, 2, 3)
    ]
    entries.append(ArchivePdf(
        original="https://example.org/other/Gastgeberverzeichnis%20Breisach%20am%20Rhein%202025.pdf",
        timestamp="20260104000000",
        status_code=200,
        length=999999,
        archive_url="archive",
    ))
    selected, duplicates = deduplicate_archive_entries(entries)
    assert [entry.original for entry in selected] == [
        entries[2].original,
        entries[3].original,
    ]
    assert len(duplicates) == 2
    assert all(item["duplicateOf"] == entries[2].original for item in duplicates)


def test_archive_host_failures_are_isolated(monkeypatch):
    archive = ArchivePdf(
        original="https://good.example/Seniorenwegweiser-2026.pdf",
        timestamp="20260102000000",
        status_code=200,
        length=123,
        archive_url="archive",
    )

    def fetch(_self, host, *, budget):
        if host == "bad.example":
            raise RuntimeError("CDX-Verbindung abgebrochen")
        return ArchiveIndexResult(entries=(archive,))

    monkeypatch.setattr(ArchiveIndex, "fetch", fetch)
    results = ArchiveIndex(sleep=lambda _seconds: None).fetch_many(
        ["bad.example", "good.example"],
        budget=DiscoveryBudget(max_requests=10, max_depth=0, max_seconds=10),
    )
    assert results["bad.example"].error == "RuntimeError: CDX-Verbindung abgebrochen"
    assert results["good.example"].entries == (archive,)


@pytest.mark.parametrize("url", [
    "https://ksr-breisgau-hochschwarzwald.de/wp-content/uploads/2024/06/ksr-breisgau-hochschwarzwald_seniorenwegweiser.pdf",
    "https://www.ulm.de/-/media/ulm/so/downloads/seniorinnen/internationaler-seniorenwegweiser-deutsch.pdf?rev=a963ec41630b46c0b088f620603b706b",
])
def test_modern_useful_evaluation_urls_are_accepted(url):
    assert candidate_rejection_reason(url) is None


@pytest.mark.parametrize("url", [
    "https://www.herbrechtingen.de/site/Herbrechtingen/get/documents_E-87185129/herbrechtingen/Mediathek_Herbrechtingen/Bildung%20&%20Soziales/Senioren/Seniorenwegweiser_2017.pdf",
    "https://www.uni-ulm.de/fileadmin/website_uni_ulm/zuv/zuv.dezIII.abt1/familie/pdf/Pflege/2018seniorenwegweiserAlbDonau.pdf",
    "https://www.kuenzelsauersenioren.de/index_htm_files/Seniorenwegweiser-2017.pdf",
    "https://www.ulm.de/-/media/ulm/so/downloads/seniorinnen/seniorenwegweiser-aktualilsiert-nov-2019.pdf",
])
def test_old_useful_evaluation_urls_are_rejected_by_age(url):
    assert "Jahreszahl" in (candidate_rejection_reason(url) or "")


@pytest.mark.parametrize("url", [
    "https://seniorenunion-bw.de/wp-content/uploads/2026/06/Satzung_FBO_Ehrungsordnung_Stand_2026-06-12.pdf",
    "https://www.seniorenwohngemeinschaften.de/nutzungsbedingungen.pdf",
    "https://www.seniorenwohngemeinschaften.de/datenschutzerklaerung.pdf",
    "https://www.lfk.de/fileadmin/PDFs/Publikationen/Materialien/Seniorennetzwerk/Postkarte_Seniorennetzwerk-2025.pdf",
    "https://www.lfk.de/fileadmin/PDFs/Publikationen/Materialien/LFK/netzwerk-senioren-programmheft-tagung.pdf",
    "https://s3856459e0e274fa3.jimcontent.com/download/version/1707987080/module/12138523021/name/Betreutes%20Wohnen%20fuer%20Senioren%20im%20Landkreis%20Karlsruhe2.PDF",
    "https://www.lpb-bw.de/fileadmin/lpb_hauptportal/pdf/publikationen/Leseprobe_Band_2_.pdf",
    "https://stmgp.bayern.de/wp-content/uploads/2024/02/strategiepapier_gute-pflege.pdf",
    "https://admin.integreat-app.de/media/regions/115/2022/09/Vereinsliste_Andechs.pdf",
    "https://www.bkk-bayern.de/fileadmin/media/bkk-bayern/03_partner/PDF-Dateien/Netwerkfoerderung/Pflege/Anlage_4_Verwendungsnachweis___45c_SGBXI.pdf",
    "https://familienportal.de/resource/blob/222032/afd0de1ee76c39ed8f8793779a4c53c0/musterformular-mitteilung-zur-elternzeit-data.pdf",
    "https://www.bayern-pflege-wohnen.de/wp-content/uploads/2025/07/Praesentation-TP-V-Eckpunkte-Aufbau-TP-Wawrik-28042021.pdf",
    "https://www.pflegestuetzpunkteberlin.de/wp-content/uploads/2025/04/Kontaktliste_Pflegestuetzpuenkte_07_26-1.pdf",
    "https://www.pflegestuetzpunkteberlin.de/wp-content/uploads/2024/04/Zufriedenheitsbefragung_Pflegestuetzpunkte_Berlin_2023.pdf",
    "https://www.bibb.de/dokumente/pdf/Bundesland-Dossier%20_3_Berlin_W8.pdf",
    "https://download.statistik-berlin-brandenburg.de/80257107a9695177/f2db3ee24118/SB_G04-01-00_2026m05_BB.pdf",
])
def test_evaluation_rejected_urls_are_rejected(url):
    assert candidate_rejection_reason(url) is not None
