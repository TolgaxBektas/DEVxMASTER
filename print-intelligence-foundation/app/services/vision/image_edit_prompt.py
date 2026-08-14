import hashlib


IMAGE_EDIT_PROMPT_VERSION = "generative-restoration-v1.0.0"
IMAGE_EDIT_PROMPT = """Use only the supplied advertisement image as reference.
CONTENT IS FROZEN, PLACEMENT IS NOT. Preserve aspect ratio, dimensions, logos,
brand and product colors, typography, and the layout character. Do not create,
rewrite, correct, or invent characters. Do not add text, icons, graphics,
frames, or QR codes. Do not duplicate content. Do not fill empty areas,
cover or mask anything, or add information from the internet. This is exactly
one restoration cascade stage. If uncertain, return the image unchanged."""
IMAGE_EDIT_PROMPT_SHA256 = hashlib.sha256(IMAGE_EDIT_PROMPT.encode()).hexdigest()
