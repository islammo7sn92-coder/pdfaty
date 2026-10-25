"""Which uploaded file kinds each operation accepts (validated before a job is queued)."""
PDF = {"pdf"}
PDF_IMG = {"pdf", "image"}

OP_INPUT_KINDS: dict[str, set[str]] = {
    "convert_to_pdf": {"office", "text", "html", "image", "pdf"},
    "images_to_pdf": {"image"},
    "blank_pdf": set(),
    "watermark_add": PDF_IMG,
    "background_add": PDF_IMG,
    "edit_overlay": PDF_IMG,
    "annotate": PDF_IMG,
    "attachments_add": {"pdf", "image", "office", "text", "html", "other"},
    "organize": PDF,
    "ocr": PDF_IMG,
    "sign_certificate": {"pdf", "other"},
}

