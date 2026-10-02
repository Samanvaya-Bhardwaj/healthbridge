"""Text from a validated document (PDF text layer, or OCR for images).

Document text is medical content: it is never logged. OCR output is never treated as
authoritative (ADR-0010): extractions from OCR are marked for clinician review.
"""

import io
import logging
import shutil
from dataclasses import dataclass
from typing import Literal

logger = logging.getLogger("healthbridge.ai.documents")

MAX_TEXT_CHARS = 200_000
TextSource = Literal["pdf_text", "ocr", "none"]


@dataclass(frozen=True)
class ExtractedText:
    text: str
    source: TextSource


def _pdf_text(content: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(content))
    if reader.is_encrypted:
        return ""
    parts: list[str] = []
    for page in reader.pages[:50]:
        parts.append(page.extract_text() or "")
    return "\n".join(parts)


def ocr_available() -> bool:
    return shutil.which("tesseract") is not None


def _ocr_image(content: bytes) -> str:
    import pytesseract
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = 40_000_000  # refuse decompression bombs
    with Image.open(io.BytesIO(content)) as image:
        image.load()
        return pytesseract.image_to_string(image, timeout=60)


def extract_text(content: bytes, content_type: str) -> ExtractedText:
    """Best-effort text; returns source "none" when nothing usable is found."""
    text = ""
    source: TextSource = "none"
    try:
        if content_type == "application/pdf":
            text, source = _pdf_text(content), "pdf_text"
        elif content_type in ("image/png", "image/jpeg") and ocr_available():
            text, source = _ocr_image(content), "ocr"
    except Exception as exc:  # malformed files must not crash the agent
        logger.warning("text extraction failed", extra={"errorType": type(exc).__name__})
        text = ""
    text = text.replace("\x00", "")[:MAX_TEXT_CHARS]
    if not text.strip():
        return ExtractedText("", "none")
    return ExtractedText(text, source)
