"""OCR (Tesseract, Arabic + English) producing a searchable PDF.

The original page content is kept untouched; recognised words are added as an
invisible text layer (render mode 3) positioned over each word, so the PDF keeps
its look and becomes searchable/copyable."""
from __future__ import annotations

import csv
import re
import io
import os
import shutil
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pypdfium2 as pdfium
from PIL import Image, ImageFilter, ImageOps

from .base import Context, UserError, op, parse_pages
from .geom import overlay_forms, stamp
from bidi.algorithm import get_display

from .text import family_fonts, has_arabic

ALLOWED_LANGS = {"ara", "eng", "fra", "deu", "spa", "ita", "tur", "fas", "urd"}


def tesseract_langs() -> set[str]:
    if not shutil.which("tesseract"):
        return set()
    try:
        out = subprocess.run(["tesseract", "--list-langs"], capture_output=True, text=True, timeout=15).stdout
    except (OSError, subprocess.SubprocessError):
        return set()
    return {l.strip() for l in out.splitlines()[1:] if l.strip()}


def check_langs(langs) -> str:
    if isinstance(langs, str):
        langs = [l for l in langs.replace(",", "+").split("+") if l]
    langs = [l for l in (langs or ["ara", "eng"]) if l in ALLOWED_LANGS]
    avail = tesseract_langs()
    if not avail:
        raise UserError("ocr_unavailable")
    langs = [l for l in langs if l in avail]
    if not langs:
        raise UserError("ocr_language_unavailable")
    return "+".join(langs)


def _otsu(arr: np.ndarray) -> int:
    hist = np.bincount(arr.ravel(), minlength=256).astype(np.float64)
    total = arr.size
    sum_total = np.dot(np.arange(256), hist)
    w_b = 0.0
    sum_b = 0.0
    best, thresh = 0.0, 127
    for t in range(256):
        w_b += hist[t]
        if w_b == 0:
            continue
        w_f = total - w_b
        if w_f == 0:
            break
        sum_b += t * hist[t]
        m_b = sum_b / w_b
        m_f = (sum_total - sum_b) / w_f
        between = w_b * w_f * (m_b - m_f) ** 2
        if between > best:
            best, thresh = between, t
    return thresh


def estimate_skew(gray: Image.Image) -> float:
    """Projection-profile skew estimate in degrees (-5..5)."""
    small = gray.copy()
    small.thumbnail((1000, 1000))
    arr = np.asarray(small)
    t = _otsu(arr)
    ink = Image.fromarray(((arr < t) * 255).astype(np.uint8))
    best_angle, best_score = 0.0, -1.0
    for angle in np.arange(-5, 5.01, 0.5):
        rot = np.asarray(ink.rotate(float(angle), resample=Image.NEAREST, fillcolor=0))
        profile = rot.sum(axis=1).astype(np.float64)
        score = float(np.sum(np.diff(profile) ** 2))
        if score > best_score:
            best_score, best_angle = score, float(angle)
    return best_angle


def preprocess(img: Image.Image, opts: dict) -> tuple[Image.Image, float]:
    gray = ImageOps.grayscale(img)
    if opts.get("contrast", True):
        gray = ImageOps.autocontrast(gray, cutoff=1)
    if opts.get("denoise"):
        gray = gray.filter(ImageFilter.MedianFilter(3))
    angle = 0.0
    if opts.get("deskew"):
        angle = estimate_skew(gray)
        if abs(angle) >= 0.25:
            gray = gray.rotate(angle, resample=Image.BICUBIC, expand=False, fillcolor=255)
        else:
            angle = 0.0
    if opts.get("binarize"):
        arr = np.asarray(gray)
        t = _otsu(arr)
        gray = Image.fromarray(((arr > t) * 255).astype(np.uint8))
    return gray, angle


def run_tesseract(img: Image.Image, langs: str, psm: int = 3, dpi: int = 300, timeout: int = 300) -> list[dict]:
    with tempfile.TemporaryDirectory(prefix="ocr") as d:
        src = os.path.join(d, "p.png")
        img.save(src)
        base = os.path.join(d, "out")
        cmd = ["tesseract", src, base, "-l", langs, "--psm", str(psm), "--dpi", str(dpi),
               "-c", "preserve_interword_spaces=1", "tsv"]
        try:
            subprocess.run(cmd, capture_output=True, timeout=timeout, check=True)
        except subprocess.TimeoutExpired:
            raise UserError("timeout")
        except subprocess.CalledProcessError:
            raise UserError("ocr_failed")
        words = []
        with open(base + ".tsv", "r", encoding="utf-8", errors="replace") as fh:
            reader = csv.DictReader(fh, delimiter="\t", quoting=csv.QUOTE_NONE)
            for row in reader:
                try:
                    if row.get("level") != "5":
                        continue
                    text = re.sub(r"[\u200e\u200f\u202a-\u202e\u2066-\u2069]", "", row.get("text") or "").strip()
                    if not text:
                        continue
                    words.append({
                        "text": text, "conf": float(row["conf"]),
                        "l": int(row["left"]), "t": int(row["top"]), "w": int(row["width"]), "h": int(row["height"]),
                        "line": (int(row["block_num"]), int(row["par_num"]), int(row["line_num"])),
                    })
                except (KeyError, ValueError, TypeError):
                    continue
        return words


def _unrotate(words: list[dict], angle: float, size: tuple[int, int]) -> None:
    """Map word boxes recognised on a deskewed image back to the original image."""
    if not angle:
        return
    import math

    cx, cy = size[0] / 2, size[1] / 2
    rad = math.radians(angle)  # PIL rotates counter-clockwise for positive angles
    cos, sin = math.cos(rad), math.sin(rad)
    for w in words:
        x, y = w["l"] + w["w"] / 2 - cx, w["t"] + w["h"] / 2 - cy
        # inverse of a CCW rotation in image coords (y down)
        nx = x * cos - y * sin
        ny = x * sin + y * cos
        w["l"] = int(nx + cx - w["w"] / 2)
        w["t"] = int(ny + cy - w["h"] / 2)


def ocr_page_image(img: Image.Image, langs: str, opts: dict, dpi: int) -> list[dict]:
    pre, angle = preprocess(img, opts)
    words = run_tesseract(pre, langs, int(opts.get("psm", 3)), dpi)
    _unrotate(words, angle, pre.size)
    return words


def draw_text_layer(c, words: list[dict], scale: float, vh: float) -> None:
    """Invisible text: `scale` converts pixels to points."""
    from reportlab.pdfbase import pdfmetrics

    latin, arabic = family_fonts("sans")
    lines: dict[tuple, list[dict]] = {}
    for w in words:
        lines.setdefault(w["line"], []).append(w)
    for _, ws in sorted(lines.items(), key=lambda kv: kv[0]):
        line_h = max(w["h"] for w in ws) * scale
        size = max(2.0, line_h * 0.92)
        rtl = sum(1 for w in ws if has_arabic(w["text"])) > len(ws) / 2
        ordered = sorted(ws, key=lambda w: -w["l"] if rtl else w["l"])
        bottom = max(w["t"] + w["h"] for w in ws) * scale
        baseline = vh - bottom + line_h * 0.18
        for k, w in enumerate(ordered):
            # glyphs are stored in visual order (as PDF producers do) so that extractors
            # applying bidi (pdf.js, PDFium, Acrobat) return logical text
            word = get_display(w["text"]) if has_arabic(w["text"]) else w["text"]
            txt = word + (" " if k < len(ordered) - 1 else "")
            font = arabic if has_arabic(w["text"]) else latin
            natural = pdfmetrics.stringWidth(txt, font, size) or 1
            target = w["w"] * scale + (size * 0.25 if k < len(ordered) - 1 else 0)
            t = c.beginText()
            t.setTextRenderMode(3)
            t.setFont(font, size)
            t.setHorizScale(max(10.0, min(400.0, 100.0 * target / natural)))
            t.setTextOrigin(w["l"] * scale, baseline)
            t.textOut(txt)
            c.drawText(t)


def page_has_text(doc: pdfium.PdfDocument, i: int, min_chars: int = 20) -> bool:
    page = doc[i]
    tp = page.get_textpage()
    try:
        return len(tp.get_text_range().strip()) >= min_chars
    finally:
        tp.close()
        page.close()


def ocr_pdf(ctx: Context, path: str, password: str, langs: str, pages: list[int], opts: dict,
            progress=None) -> tuple[dict[int, list[dict]], dict[int, tuple[float, float]], list[int]]:
    """OCR the selected pages. Returns (words_by_page in pixel coords, scale+vh by page, skipped pages)."""
    dpi = int(opts.get("dpi", 300))
    doc = pdfium.PdfDocument(path, password=password or None)
    force = bool(opts.get("force"))
    todo, skipped = [], []
    for i in pages:
        if not force and page_has_text(doc, i):
            skipped.append(i)
        else:
            todo.append(i)
    images: dict[int, Image.Image] = {}
    geo: dict[int, tuple[float, float]] = {}

    def render(i: int) -> Image.Image:
        page = doc[i]
        w_pt, h_pt = page.get_size()
        s = dpi / 72
        # cap very large pages to ~40 MP
        if w_pt * h_pt * s * s > 40_000_000:
            s = (40_000_000 / (w_pt * h_pt)) ** 0.5
        bmp = page.render(scale=s, may_draw_forms=True)
        img = bmp.to_pil().convert("RGB")
        geo[i] = (72 / (s * 72), page.get_size()[1])
        page.close()
        return img

    results: dict[int, list[dict]] = {}
    workers = max(1, min(4, (os.cpu_count() or 2)))
    done = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {}
        for i in todo:
            images[i] = render(i)  # pdfium is not thread-safe: render serially
            futures[i] = ex.submit(ocr_page_image, images.pop(i), langs, opts, int(dpi))
            # keep memory bounded
            if len(futures) >= workers * 2:
                for j in list(futures):
                    if futures[j].done():
                        results[j] = futures.pop(j).result()
                        done += 1
                        if progress:
                            progress(100 * done / max(1, len(todo)))
        for j, fut in futures.items():
            results[j] = fut.result()
            done += 1
            if progress:
                progress(100 * done / max(1, len(todo)))
    doc.close()
    return results, geo, skipped


@op("ocr")
def ocr(ctx: Context) -> None:
    langs = check_langs(ctx.p("languages", ["ara", "eng"]))
    if not ctx.pdf_inputs() and any(f.kind == "image" for f in ctx.inputs):
        from .convert import images_to_pdf_file

        path = ctx.tmp("images.pdf")
        images_to_pdf_file([f.path for f in ctx.inputs if f.kind == "image"], path, {"size": "fit"})
        from .base import InputFile

        ctx.inputs.insert(0, InputFile(path, (ctx.inputs[0].stem + ".pdf"), "pdf"))
    f = ctx.first_pdf()
    pdf = ctx.open_pdf(f)
    pages = parse_pages(ctx.p("pages"), len(pdf.pages))
    opts = {
        "dpi": ctx.pint("dpi", 300, 150, 400), "psm": ctx.pint("psm", 3, 1, 13),
        "contrast": bool(ctx.p("contrast", True)), "denoise": bool(ctx.p("denoise", False)),
        "deskew": bool(ctx.p("deskew", True)), "binarize": bool(ctx.p("binarize", False)), "force": bool(ctx.p("force", False)),
    }
    results, geo, skipped = ocr_pdf(ctx, f.path, ctx.password_for(ctx.inputs.index(f)), langs, pages, opts,
                                    lambda p: ctx.progress(p * 0.9, "ocr"))

    def draw(c, i, g):
        words = results.get(i)
        if not words:
            return False
        scale = geo[i][0]
        draw_text_layer(c, words, scale, g.vh)

    forms = overlay_forms(pdf, sorted(results), draw)
    for i, form in forms.items():
        stamp(pdf, pdf.pages[i], form, kind="OCR", artifact=False)
    stats = []
    full_text = []
    for i in sorted(results):
        ws = results[i]
        confs = [w["conf"] for w in ws if w["conf"] >= 0]
        mean = sum(confs) / len(confs) if confs else 0.0
        stats.append({"page": i, "words": len(ws), "confidence": round(mean, 1), "low": mean < 70 or len(ws) < 3})
        lines: dict[tuple, list[dict]] = {}
        for w in ws:
            lines.setdefault(w["line"], []).append(w)
        page_lines = []
        for _, lw in sorted(lines.items()):
            rtl = sum(1 for w in lw if has_arabic(w["text"])) > len(lw) / 2
            page_lines.append(" ".join(w["text"] for w in sorted(lw, key=lambda w: -w["l"] if rtl else w["l"])))
        full_text.append(f"--- {i + 1} ---\n" + "\n".join(page_lines))
    if not pdf.Root.get("/Lang"):
        pdf.Root.Lang = pikepdf_string("ar" if "ara" in langs else "en")
    ctx.save_pdf(pdf, f.stem + "_ocr.pdf")
    if ctx.p("text_output"):
        tpath = ctx.out_path(f.stem + "_ocr.txt")
        with open(tpath, "w", encoding="utf-8") as fh:
            fh.write("\n\n".join(full_text))
        ctx.add_output(tpath)
    low = [s["page"] + 1 for s in stats if s["low"]]
    ctx.result = {"pages_ocr": len(results), "skipped_pages": [s + 1 for s in skipped], "stats": stats,
                  "low_confidence_pages": low, "languages": langs}


def pikepdf_string(s: str):
    import pikepdf

    return pikepdf.String(s)
