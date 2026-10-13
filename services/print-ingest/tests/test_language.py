from app.services.language import SW, document_language


def test_german_sample_is_classified_as_german():
    result = document_language(
        [{"text": " ".join(SW["de"].split() * 6)}]
    )

    assert result["words"] > 200
    assert result["verdict"] == "deutsch"


def test_english_sample_is_classified_as_foreign():
    result = document_language(
        [{"text": " ".join(SW["en"].split() * 20)}]
    )

    assert result["words"] > 200
    assert result["verdict"] == "fremdsprachig"
    assert result["foreign_language"] == "en"


def test_cyrillic_sample_is_classified_as_foreign():
    result = document_language(
        [{"text": "ДОБРО ПОЖАЛОВАТЬ НА РАБОТУ " * 70}]
    )

    assert result["words"] > 200
    assert result["verdict"] == "fremdsprachig"
    assert result["nonlatin_share"] == 1.0


def test_fewer_than_200_words_is_not_classified_as_foreign():
    result = document_language([{"text": "der " * 199}])

    assert result["words"] == 199
    assert result["verdict"] == "zu_wenig_text"


def test_address_fragments_do_not_look_like_foreign_stopwords():
    result = document_language(
        [{"text": "Musterstraße 1, 12345 Nürnberg, i. W. z. Hd. Max Mustermann " * 40}]
    )

    assert result["words"] > 200
    assert result["verdict"] != "fremdsprachig"
    assert result["foreign_share"] == 0.0
