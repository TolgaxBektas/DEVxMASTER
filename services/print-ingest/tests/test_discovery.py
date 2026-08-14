from app.services.discovery import score_candidate

def test_pdf_publication_scores_high():
    assert score_candidate('https://example.org/Seniorenwegweiser-2026.pdf') >= 50

def test_irrelevant_low():
    assert score_candidate('https://example.org/index.html') < 40
