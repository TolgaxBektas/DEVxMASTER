import re

MIN_WORDS = 200
MIN_GERMAN_SHARE = 0.04
MIN_FOREIGN_SHARE = 0.04
MIN_NONLATIN_SHARE = 0.3
FOREIGN_DOMINANCE = 2

SW = {
    "de": "der die das und ist nicht mit sich auf für von den des dem ein eine einer im zu bei auch wir sie es aus nach oder wird werden sind am an als bis über vom zum zur noch wie nur durch",
    "en": "the and that are this with from your you have will which their",
    "fr": "les une est pour dans que qui sur pas avec vous nous",
    "it": "che per una sono della del con non gli nel alla anche",
    "es": "los las que por con para una del",
    "tr": "bir için ile olarak çok veya gibi size",
    "ro": "și în este care pentru din să sau mai sunt",
    "pl": "nie się jest że jak dla są",
}
_STOPWORDS = {language: set(words.split()) for language, words in SW.items()}


def document_language(pages: list[dict]) -> dict:
    text = " ".join(str(page.get("text") or "") for page in pages)
    letters = re.findall(r"[^\W\d_]", text)
    nonlatin_share = (
        sum(0x370 <= ord(letter) <= 0x6FF for letter in letters) / len(letters)
        if letters
        else 0.0
    )
    words = re.findall(r"[^\W\d_]+", text.lower())
    word_count = len(words)
    shares = {
        language: (
            sum(word in stopwords for word in words) / word_count
            if word_count
            else 0.0
        )
        for language, stopwords in _STOPWORDS.items()
    }
    foreign_share, foreign_language = max(
        (share, language)
        for language, share in shares.items()
        if language != "de"
    )

    if word_count < MIN_WORDS:
        verdict = "zu_wenig_text"
    elif shares["de"] >= MIN_GERMAN_SHARE and not (
        foreign_share >= MIN_FOREIGN_SHARE
        and foreign_share > FOREIGN_DOMINANCE * shares["de"]
    ):
        verdict = "deutsch"
    elif (
        nonlatin_share >= MIN_NONLATIN_SHARE
        or foreign_share >= MIN_FOREIGN_SHARE
    ):
        verdict = "fremdsprachig"
    else:
        verdict = "unklar"

    return {
        "verdict": verdict,
        "words": word_count,
        "de_share": shares["de"],
        "foreign_language": foreign_language,
        "foreign_share": foreign_share,
        "nonlatin_share": nonlatin_share,
    }
