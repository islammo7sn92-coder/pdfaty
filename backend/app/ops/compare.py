"""Compare two PDF versions: word-level diff with page/position tracking, a contract mode
that focuses on amounts, percentages, dates and clause numbers, and a PDF report."""
from __future__ import annotations

import difflib
import io
import re
import unicodedata

import pypdfium2 as pdfium
from PIL import Image, ImageDraw

from .base import Context, UserError, op
from .text import draw_line, has_arabic, wrap_text

DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹٫٬", "01234567890123456789.,")
TASHKEEL = re.compile(r"[ً-ٰٟـ]")


def norm_token(t: str, ignore_case: bool = True) -> str:
    t = unicodedata.normalize("NFKC", t).translate(DIGITS)
    t = TASHKEEL.sub("", t)
    t = t.replace("أ", "ا").replace("إ", "ا").replace("آ", "ا").replace("ى", "ي").replace("ة", "ه")
    t = t.strip(".,;:!?()[]{}\"'«»،؛")
    return t.lower() if ignore_case else t


def extract_words(doc: pdfium.PdfDocument, geos, ocr_ctx=None) -> list[dict]:
    """Words in logical reading order with page index and visible top-left bbox."""
    from .extract import build_lines, page_chars

    words: list[dict] = []
    for pi in range(len(doc)):
        page = doc[pi]
        tp = page.get_textpage()
        lines = build_lines(page_chars(page, tp, geos[pi]), page_width=geos[pi].vw)
        tp.close()
        page_words = []
        for ln in lines:
            for m in re.finditer(r"\S+", ln.text):
                cs = ln.chars[m.start():m.end()]
                bbox = [min(c.l for c in cs), min(c.t for c in cs), max(c.r for c in cs) - min(c.l for c in cs),
                        max(c.b for c in cs) - min(c.t for c in cs)]
                page_words.append({"t": m.group(0), "p": pi, "b": bbox})
        if not page_words and ocr_ctx is not None:
            page_words = ocr_ctx(page, pi)
        page.close()
        words.extend(page_words)
    return words


def _ocr_words_factory(langs: str):
    from .ocr import ocr_page_image

    def run(page, pi):
        scale = 300 / 72
        img = page.render(scale=scale).to_pil().convert("RGB")
        ws = ocr_page_image(img, langs, {"deskew": True, "contrast": True}, 300)
        lines: dict = {}
        for w in ws:
            lines.setdefault(w["line"], []).append(w)
        out = []
        for _, lw in sorted(lines.items()):
            rtl = sum(1 for w in lw if has_arabic(w["text"])) > len(lw) / 2
            for w in sorted(lw, key=lambda w: -w["l"] if rtl else w["l"]):
                out.append({"t": w["text"], "p": pi, "b": [w["l"] / scale, w["t"] / scale, w["w"] / scale, w["h"] / scale]})
        return out

    return run


NUM_RE = re.compile(r"^[\d.,/\-:%]+$")
DATE_RE = re.compile(r"^\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}$")
CLAUSE_RE = re.compile(r"^(?:\d+\.){1,4}\d*$|^\(\d+\)$|^\d+[-)]$")
CURRENCY = ("جنيه", "ريال", "دولار", "درهم", "دينار", "يورو", "egp", "usd", "sar", "aed", "eur", "le", "ج.م", "$", "€", "£")


def classify(tok: str, nxt: str = "") -> str | None:
    n = tok.translate(DIGITS)
    core = n.strip("()[]،,;:")
    if DATE_RE.match(core):
        return "date"
    if "%" in core or "٪" in tok or nxt in ("%", "٪", "بالمائة", "percent"):
        return "percent"
    if CLAUSE_RE.match(core):
        return "clause"
    if NUM_RE.match(core) and any(ch.isdigit() for ch in core):
        if nxt.lower().strip(".,") in CURRENCY:
            return "amount"
        digits = sum(ch.isdigit() for ch in core)
        return "amount" if digits >= 3 or "," in core or "." in core else "number"
    return None


def _join(ws: list[dict]) -> str:
    return " ".join(w["t"] for w in ws)


def diff_words(a: list[dict], b: list[dict], ignore_case: bool, contract: bool) -> list[dict]:
    na = [norm_token(w["t"], ignore_case) for w in a]
    nb = [norm_token(w["t"], ignore_case) for w in b]
    sm = difflib.SequenceMatcher(None, na, nb, autojunk=False)
    changes = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            continue
        old, new = a[i1:i2], b[j1:j2]
        if not "".join(na[i1:i2]) and not "".join(nb[j1:j2]):
            continue
        kind = {"replace": "changed", "delete": "removed", "insert": "added"}[tag]
        cats = set()
        for seq, src in ((old, a), (new, b)):
            for k, w in enumerate(seq):
                nxt = seq[k + 1]["t"] if k + 1 < len(seq) else ""
                c = classify(w["t"], nxt)
                if c:
                    cats.add(c)
        # context for readability
        ctx_before = _join(a[max(0, i1 - 6):i1]) if a else ""
        ctx_after = _join(a[i2:i2 + 6]) if a else ""
        entry = {
            "type": kind, "old": _join(old)[:2000], "new": _join(new)[:2000],
            "old_page": old[0]["p"] if old else (a[i1 - 1]["p"] if i1 > 0 and a else (a[0]["p"] if a else 0)),
            "new_page": new[0]["p"] if new else (b[j1 - 1]["p"] if j1 > 0 and b else (b[0]["p"] if b else 0)),
            "old_boxes": [[w["p"], *w["b"]] for w in old if w["b"]][:200],
            "new_boxes": [[w["p"], *w["b"]] for w in new if w["b"]][:200],
            "categories": sorted(cats), "context": (ctx_before + " … " + ctx_after).strip()[:300],
        }
        entry["important"] = bool(cats & {"amount", "percent", "date", "clause", "number"})
        changes.append(entry)
    if contract:
        changes.sort(key=lambda c: (not c["important"],))
    return changes


def _page_images(doc: pdfium.PdfDocument, boxes_by_page: dict[int, list], color, scale=1.3) -> dict[int, Image.Image]:
    out = {}
    for pi, boxes in boxes_by_page.items():
        page = doc[pi]
        img = page.render(scale=scale).to_pil().convert("RGB")
        page.close()
        overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(overlay)
        for _, x, y, w, h in boxes:
            d.rectangle([x * scale - 1, y * scale - 1, (x + w) * scale + 1, (y + h) * scale + 1],
                        fill=color + (70,), outline=color + (255,), width=2)
        out[pi] = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
    return out


def build_report(path: str, a_name: str, b_name: str, changes: list[dict], doc_a, doc_b, contract: bool, lang: str) -> None:
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas as rl

    W, H = 595.28, 841.89
    c = rl.Canvas(path, pagesize=(W, H))
    c.setTitle("PDFATY comparison report")
    ar = lang == "ar"
    align = "right" if ar else "left"
    X = W - 40 if ar else 40
    y = H - 50

    def line(text, size=10, bold=False, color=(0.1, 0.1, 0.1), dy=None):
        nonlocal y
        if y < 60:
            c.showPage()
            y = H - 50
        c.setFillColorRGB(*color)
        for ln in wrap_text(text, W - 80, size, "sans", bold) or [""]:
            draw_line(c, ln, X, y, size, "sans", bold, align)
            y -= dy or size * 1.45
            if y < 60:
                c.showPage()
                y = H - 50
                c.setFillColorRGB(*color)

    T = (lambda a, e: a if ar else e)
    line(T("تقرير مقارنة المستندات — PDFATY", "Document comparison report — PDFATY"), 16, True)
    line(T(f"الأصل: {a_name}", f"Original: {a_name}"), 10)
    line(T(f"المعدل: {b_name}", f"Revised: {b_name}"), 10)
    counts = {k: sum(1 for ch in changes if ch["type"] == k) for k in ("added", "removed", "changed")}
    imp = sum(1 for ch in changes if ch["important"])
    line(T(f"الإجمالي: {len(changes)} — إضافات {counts['added']}، حذف {counts['removed']}، تعديلات {counts['changed']}، "
           f"قيم مهمة (مبالغ/نسب/تواريخ/بنود) {imp}",
           f"Total: {len(changes)} — added {counts['added']}, removed {counts['removed']}, changed {counts['changed']}, "
           f"important values (amounts/percentages/dates/clauses) {imp}"), 10, True)
    line(T("تنبيه: المقارنة الآلية قد لا تكتشف كل اختلاف (مثل تغييرات التنسيق أو الصور). راجع النتائج المهمة يدويًا.",
           "Note: automated comparison may miss differences (e.g. formatting or images). Review important results manually."),
         9, False, (0.6, 0.3, 0))
    y -= 6
    names = {"added": T("إضافة", "Added"), "removed": T("حذف", "Removed"), "changed": T("تعديل", "Changed")}
    catn = {"amount": T("مبلغ", "amount"), "percent": T("نسبة", "percent"), "date": T("تاريخ", "date"),
            "clause": T("رقم بند", "clause"), "number": T("رقم", "number")}
    colors = {"added": (0.05, 0.5, 0.2), "removed": (0.75, 0.1, 0.1), "changed": (0.1, 0.3, 0.75)}
    for n, ch in enumerate(changes[:1500], 1):
        cats = "، ".join(catn[c] for c in ch["categories"]) if ar else ", ".join(catn[c] for c in ch["categories"])
        head = f"#{n} {names[ch['type']]} — " + T(f"ص {ch['old_page'] + 1} ← ص {ch['new_page'] + 1}",
                                                  f"p.{ch['old_page'] + 1} → p.{ch['new_page'] + 1}")
        if cats:
            head += f" [{cats}]"
        line(head, 10, True, colors[ch["type"]])
        if ch["old"]:
            line(T("قديم: ", "Old: ") + ch["old"][:600], 9, False, (0.55, 0.1, 0.1))
        if ch["new"]:
            line(T("جديد: ", "New: ") + ch["new"][:600], 9, False, (0.05, 0.45, 0.15))
        y -= 4
    # visual pages with highlighted differences
    old_boxes: dict[int, list] = {}
    new_boxes: dict[int, list] = {}
    for ch in changes:
        for b in ch["old_boxes"]:
            old_boxes.setdefault(b[0], []).append(b)
        for b in ch["new_boxes"]:
            new_boxes.setdefault(b[0], []).append(b)
    pages = sorted(set(old_boxes) | set(new_boxes))[:40]
    if pages:
        ia = _page_images(doc_a, {p: old_boxes.get(p, []) for p in pages if p < len(doc_a)}, (220, 30, 30))
        ib = _page_images(doc_b, {p: new_boxes.get(p, []) for p in pages if p < len(doc_b)}, (20, 150, 60))
        for p in pages:
            c.showPage()
            c.setFillColorRGB(0.1, 0.1, 0.1)
            draw_line(c, T(f"صفحة {p + 1}: الأصل (يسار) / المعدل (يمين)", f"Page {p + 1}: original (left) / revised (right)"),
                      W / 2, H - 35, 11, "sans", True, "center")
            for k, img in enumerate((ia.get(p), ib.get(p))):
                if img is None:
                    continue
                maxw, maxh = (W - 60) / 2, H - 80
                s = min(maxw / img.width, maxh / img.height)
                w, h = img.width * s, img.height * s
                x = 20 + k * ((W - 60) / 2 + 20)
                c.drawImage(ImageReader(img), x, H - 50 - h, w, h)
    c.save()


@op("compare")
def compare(ctx: Context) -> None:
    pdfs = ctx.pdf_inputs()
    if len(pdfs) != 2:
        raise UserError("need_two_pdfs")
    from .extract import geometries

    docs, geos = [], []
    for f in pdfs:
        ctx.open_pdf(f).close()  # validates password/permissions
        pw = ctx.password_for(ctx.inputs.index(f))
        docs.append(pdfium.PdfDocument(f.path, password=pw or None))
        geos.append(geometries(f.path, pw))
    ocr = None
    if ctx.p("ocr", True):
        from .ocr import check_langs

        try:
            ocr = _ocr_words_factory(check_langs(ctx.p("languages", ["ara", "eng"])))
        except UserError:
            ocr = None
    ctx.progress(5, "extract")
    wa = extract_words(docs[0], geos[0], ocr)
    ctx.progress(35, "extract")
    wb = extract_words(docs[1], geos[1], ocr)
    ctx.progress(65, "diff")
    if not wa and not wb:
        raise UserError("no_text_found")
    contract = ctx.p("mode") == "contract"
    changes = diff_words(wa, wb, bool(ctx.p("ignore_case", True)), contract)
    if contract and ctx.p("only_important"):
        changes = [c for c in changes if c["important"]]
    ctx.progress(75, "report")
    path = ctx.out_path("comparison_report.pdf")
    build_report(path, pdfs[0].name, pdfs[1].name, changes, docs[0], docs[1], contract, ctx.p("lang", "ar"))
    ctx.add_output(path)
    for d in docs:
        d.close()
    sim = difflib.SequenceMatcher(None, [norm_token(w["t"]) for w in wa][:20000], [norm_token(w["t"]) for w in wb][:20000],
                                  autojunk=False).ratio() if wa and wb else 0
    ctx.result = {
        "changes": changes[:3000], "total": len(changes), "similarity": round(sim * 100, 1),
        "summary": {k: sum(1 for c in changes if c["type"] == k) for k in ("added", "removed", "changed")},
        "important": sum(1 for c in changes if c["important"]),
        "pages": [len(wa) and (wa[-1]["p"] + 1), len(wb) and (wb[-1]["p"] + 1)],
    }
