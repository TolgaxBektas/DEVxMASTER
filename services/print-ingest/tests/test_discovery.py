import pytest

from app.services.discovery import (
    MIN_CANDIDATE_SCORE,
    candidate_rejection_reason,
    score_candidate,
)

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
    "https://www.bundesgesundheitsministerium.de/fileadmin/Dateien/5_Publikationen/Pflege/Broschueren/BMG_Ratgeber-Pflegeleistungen_zum_Nachschlagen_2023_bf.pdf",
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
