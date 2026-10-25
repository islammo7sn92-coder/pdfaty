"""Password protection, sanitising and true redaction."""
from __future__ import annotations

import ctypes
import io
import re
import secrets

import pikepdf
import pypdfium2 as pdfium
import pypdfium2.raw as pc
from PIL import Image, ImageDraw
from pikepdf import Name

from .base import Context, UserError, op, parse_color
from .geom import Geometry, geometry, overlay_forms, stamp
from .pages import fix_acroform


# --------------------------------------------------------------------------- protection
@op("protect")
def protect(ctx: Context) -> None:
    f = ctx.first_pdf()
    pdf = ctx.open_pdf(f)
    user_pw = str(ctx.p("user_password") or "")
    owner_pw = str(ctx.p("owner_password") or "")
    if not user_pw and not owner_pw:
        raise UserError("password_required_to_set")
    if len(user_pw) > 127 or len(owner_pw) > 127:
        raise UserError("password_too_long")
    perms = ctx.p("permissions") or {}
    generated_owner = False
    if not owner_pw:
        # restrictions only mean something with an owner password; never reuse the user password
        owner_pw = secrets.token_urlsafe(24)
        generated_owner = True
    allow = pikepdf.Permissions(
        accessibility=True,
        extract=bool(perms.get("copy", True)),
        modify_annotation=bool(perms.get("annotate", True)),
        modify_assembly=bool(perms.get("assemble", True)),
        modify_form=bool(perms.get("forms", True)),
        modify_other=bool(perms.get("modify", True)),
        print_lowres=bool(perms.get("print", True)),
        print_highres=bool(perms.get("print", True)) and bool(perms.get("print_high", True)),
    )
    level = ctx.p("encryption", "aes256")
    enc = pikepdf.Encryption(user=user_pw, owner=owner_pw, allow=allow,
                             R=6 if level == "aes256" else 4, aes=True, metadata=True)
    ctx.save_pdf(pdf, f.stem + "_protected.pdf", encryption=enc)
    ctx.result = {"encryption": "AES-256" if level == "aes256" else "AES-128", "owner_password_generated": generated_owner}


@op("unprotect")
def unprotect(ctx: Context) -> None:
    f = ctx.first_pdf()
    pdf = ctx.open_pdf(f)
    if not pdf.is_encrypted:
        raise UserError("not_encrypted")
    if not pdf.owner_password_matched:
        # Opened with the user password only. Removing protection would drop the owner's
        # restrictions, so require the owner password when any restriction is set.
        a = pdf.allow
        restricted = not all([a.extract, a.modify_other, a.modify_annotation, a.modify_assembly, a.modify_form,
                              a.print_highres])
        if restricted:
            raise UserError("owner_password_required")
    ctx.save_pdf(pdf, f.stem + "_unlocked.pdf", encryption=False)


# --------------------------------------------------------------------------- sanitise
def sanitize(pdf: pikepdf.Pdf, opts: dict) -> list[str]:
    done = []
    if opts.get("metadata", True):
        try:
            for k in list(pdf.docinfo.keys()):
                del pdf.docinfo[k]
        except (TypeError, KeyError):
            pass
        if "/Metadata" in pdf.Root:
            del pdf.Root["/Metadata"]
        done.append("metadata")
    if opts.get("javascript", True):
        names = pdf.Root.get("/Names")
        if names is not None and "/JavaScript" in names:
            del names["/JavaScript"]
        if "/OpenAction" in pdf.Root:
            del pdf.Root["/OpenAction"]
        if "/AA" in pdf.Root:
            del pdf.Root["/AA"]
        for page in pdf.pages:
            if "/AA" in page.obj:
                del page.obj["/AA"]
            for a in page.obj.get("/Annots", []) or []:
                if "/A" in a and a.A.get("/S") in (Name.JavaScript, Name.Launch):
                    del a["/A"]
                if "/AA" in a:
                    del a["/AA"]
        done.append("javascript")
    if opts.get("attachments", True):
        names = pdf.Root.get("/Names")
        if names is not None and "/EmbeddedFiles" in names:
            del names["/EmbeddedFiles"]
        for page in pdf.pages:
            if "/Annots" in page.obj:
                page.obj.Annots = pikepdf.Array([a for a in page.obj.Annots if a.get("/Subtype") != Name.FileAttachment])
        done.append("attachments")
    if opts.get("thumbnails", True):
        for page in pdf.pages:
            for key in ("/Thumb", "/PieceInfo"):
                if key in page.obj:
                    del page.obj[key]
        if "/PieceInfo" in pdf.Root:
            del pdf.Root["/PieceInfo"]
        done.append("hidden_data")
    if opts.get("comments"):
        for page in pdf.pages:
            if "/Annots" in page.obj:
                page.obj.Annots = pikepdf.Array([a for a in page.obj.Annots
                                                 if a.get("/Subtype") in (Name.Link, Name.Widget)])
        done.append("comments")
    return done


@op("sanitize")
def sanitize_op(ctx: Context) -> None:
    f = ctx.first_pdf()
    pdf = ctx.open_pdf(f)
    done = sanitize(pdf, ctx.params)
    ctx.save_pdf(pdf, f.stem + "_clean.pdf")
    ctx.result = {"removed": done}


# --------------------------------------------------------------------------- redaction: search
DIG = "0-9٠-٩۰-۹"
PRESETS = {
    "email": r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+",
    "phone": rf"(?<![{DIG}])(?:\+|00)?[{DIG}][{DIG}\s\-()]{{7,16}}[{DIG}](?![{DIG}])",
    "national_id": rf"(?<![{DIG}])[23٢٣][{DIG}]{{13}}(?![{DIG}])",
    "iban": r"\b[A-Z]{2}[0-9]{2}(?:\s?[A-Z0-9]){10,30}\b",
    "card": rf"(?<![{DIG}])(?:[{DIG}][ \-]?){{13,19}}(?![{DIG}])",
    "date": rf"(?<![{DIG}])[{DIG}]{{1,4}}[/\-.][{DIG}]{{1,2}}[/\-.][{DIG}]{{1,4}}(?![{DIG}])",
    "amount": rf"[{DIG}][{DIG},.٫٬]*(?:\s?(?:%|٪|EGP|USD|SAR|AED|ج\.?م|جنيه|ريال|دولار|درهم))?",
}


def _patterns(ctx: Context) -> list[re.Pattern]:
    pats = []
    for term in ctx.p("terms") or []:
        term = str(term).strip()
        if not term:
            continue
        flags = 0 if ctx.p("match_case") else re.IGNORECASE
        if ctx.p("regex"):
            try:
                pats.append(re.compile(term, flags))
            except re.error:
                raise UserError("bad_regex", term[:60])
        else:
            pats.append(re.compile(re.escape(term), flags))
    for name in ctx.p("presets") or []:
        if name in PRESETS:
            pats.append(re.compile(PRESETS[name]))
    if len(pats) > 50:
        raise UserError("too_many_terms")
    return pats


def find_matches(doc: pdfium.PdfDocument, geos: list[Geometry], patterns: list[re.Pattern], max_hits: int = 5000):
    from .extract import find_spans, page_chars, build_lines

    hits = []
    for pi in range(len(doc)):
        page = doc[pi]
        tp = page.get_textpage()
        lines = build_lines(page_chars(page, tp, geos[pi]), page_width=geos[pi].vw)
        tp.close()
        page.close()
        for pat in patterns:
            for text, boxes in find_spans(lines, pat):
                rects = [[round(b[0], 2), round(b[1], 2), round(b[2] - b[0], 2), round(b[3] - b[1], 2)] for b in boxes]
                hits.append({"page": pi, "text": text[:200], "rects": rects})
                if len(hits) >= max_hits:
                    return hits
    return hits


def _open_doc(ctx: Context) -> tuple:
    f = ctx.first_pdf()
    pdf = ctx.open_pdf(f)  # validates password + permissions
    geos = [geometry(p) for p in pdf.pages]
    pw = ctx.password_for(ctx.inputs.index(f))
    return f, pdf, geos, pdfium.PdfDocument(f.path, password=pw or None)


@op("redact_search")
def redact_search(ctx: Context) -> None:
    f, pdf, geos, doc = _open_doc(ctx)
    pats = _patterns(ctx)
    if not pats:
        raise UserError("no_terms")
    hits = find_matches(doc, geos, pats)
    doc.close()
    ctx.result = {"matches": hits, "count": len(hits)}


# --------------------------------------------------------------------------- redaction: apply
def _intersects(a, b, tol: float = 0.0) -> bool:
    return not (a[2] <= b[0] + tol or b[2] <= a[0] + tol or a[3] <= b[1] + tol or b[3] <= a[1] + tol)


def _inside(inner, outer, tol: float = 1.0) -> bool:
    return inner[0] >= outer[0] - tol and inner[1] >= outer[1] - tol and inner[2] <= outer[2] + tol and inner[3] <= outer[3] + tol


def _ptr(handle) -> int:
    return ctypes.cast(handle, ctypes.c_void_p).value or 0


def _render_burned(doc: pdfium.PdfDocument, pi: int, g: Geometry, areas_tl: list[list[float]], dpi: int, fill) -> tuple[Image.Image, float]:
    page = doc[pi]
    scale = dpi / 72
    w, h = g.vw, g.vh
    if w * h * scale * scale > 50_000_000:
        scale = (50_000_000 / (w * h)) ** 0.5
    img = page.render(scale=scale, draw_annots=False, may_draw_forms=False).to_pil().convert("RGB")
    page.close()
    d = ImageDraw.Draw(img)
    col = tuple(int(c * 255) for c in fill)
    for x, y, ww, hh in areas_tl:
        d.rectangle([x * scale - 1, y * scale - 1, (x + ww) * scale + 1, (y + hh) * scale + 1], fill=col)
    return img, scale


def _replace_with_image(pdf: pikepdf.Pdf, page: pikepdf.Page, img: Image.Image) -> None:
    from .geom import make_image_xobject

    g = geometry(page)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=90)
    buf.seek(0)
    xo = make_image_xobject(pdf, Image.open(buf))
    a, b, c, d, e, f = g.matrix()
    content = (f"q {a} {b} {c} {d} {e:.4f} {f:.4f} cm {g.vw:.4f} 0 0 {g.vh:.4f} 0 0 cm /RdImg Do Q").encode()
    page.obj.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(RdImg=xo))
    page.obj.Contents = pdf.make_stream(content)
    for key in ("/Group",):
        if key in page.obj:
            del page.obj[key]


@op("redact_apply")
def redact_apply(ctx: Context) -> None:
    f, pdf, geos, doc = _open_doc(ctx)
    areas_in = ctx.p("areas") or []
    pats = _patterns(ctx)
    if pats:
        for h in find_matches(doc, geos, pats):
            for r in h["rects"]:
                areas_in.append({"page": h["page"], "rect": r})
    if not areas_in:
        raise UserError("no_areas")
    mode = ctx.p("mode", "precise")
    fill = parse_color(ctx.p("color"), (0, 0, 0))
    dpi = ctx.pint("dpi", 220, 100, 400)
    pad = ctx.pfloat("padding", 1.0, 0, 10)
    by_page: dict[int, list[list[float]]] = {}
    for a in areas_in:
        pi = int(a.get("page", -1))
        r = a.get("rect") or [a.get("x"), a.get("y"), a.get("w"), a.get("h")]
        if pi < 0 or pi >= len(pdf.pages):
            raise UserError("page_out_of_range")
        x, y, w, h = (float(v) for v in r)
        by_page.setdefault(pi, []).append([x - pad, y - pad, w + 2 * pad, h + 2 * pad])

    # Remember text inside the areas so we can verify it is gone afterwards.
    secret_texts: set[str] = set()
    for pi, rects in by_page.items():
        page = doc[pi]
        tp = page.get_textpage()
        for x, y, w, h in rects:
            l, b, r, t = geometry(pdf.pages[pi]).rect_tl_to_user(x, y, w, h)
            s = re.sub(r"\s+", " ", tp.get_text_bounded(l, b, r, t)).strip()
            for tok in s.split(" "):
                if len(tok) >= 3:
                    secret_texts.add(tok)
        tp.close()
        page.close()

    rasterized: list[int] = []
    patched: dict[int, list[list[float]]] = {}
    stats = {"text_removed": 0, "images_removed": 0, "paths_removed": 0, "patched_objects": 0}
    renders: dict[int, tuple[Image.Image, float]] = {}

    for k, (pi, rects_tl) in enumerate(sorted(by_page.items())):
        g = geos[pi]
        if mode == "rasterize":
            rasterized.append(pi)
            continue
        user_rects = [g.rect_tl_to_user(*r) for r in rects_tl]
        page = doc[pi]
        tp = page.get_textpage()
        # text objects that actually contain non-space characters inside an area
        hit_objs: set[int] = set()
        for ci in range(tp.count_chars()):
            ch = pc.FPDFText_GetUnicode(tp.raw, ci)
            if ch in (0, 32, 9, 10, 13, 0xA0):
                continue
            box = tp.get_charbox(ci)  # l, b, r, t
            cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
            if any(r[0] <= cx <= r[2] and r[1] <= cy <= r[3] for r in user_rects):
                h = pc.FPDFText_GetTextObject(tp.raw, ci)
                if h:
                    hit_objs.add(_ptr(h))
        page_area = g.w * g.h
        to_remove = []
        to_patch = []
        for obj in list(page.get_objects(max_depth=1)):
            try:
                l, b, r, t = obj.get_bounds()
            except Exception:  # noqa: BLE001
                continue
            bounds = [l, b, r, t]
            if not any(_intersects(bounds, ur) for ur in user_rects):
                continue
            typ = obj.type
            fully = any(_inside(bounds, ur) for ur in user_rects)
            if typ == pc.FPDF_PAGEOBJ_TEXT:
                if _ptr(obj.raw) not in hit_objs and not fully:
                    continue
                (to_remove if fully else to_patch).append((obj, bounds))
                stats["text_removed"] += 1
            elif typ == pc.FPDF_PAGEOBJ_IMAGE:
                (to_remove if fully else to_patch).append((obj, bounds))
                stats["images_removed"] += 1
            elif typ == pc.FPDF_PAGEOBJ_PATH:
                w, h = r - l, t - b
                if fully:
                    to_remove.append((obj, bounds))
                    stats["paths_removed"] += 1
                elif min(w, h) < 2.5 or w * h > 0.6 * page_area:
                    continue  # rules / frames / page backgrounds carry no hidden content
                else:
                    to_patch.append((obj, bounds))
            elif typ == pc.FPDF_PAGEOBJ_FORM:
                (to_remove if fully else to_patch).append((obj, bounds))
            elif typ == pc.FPDF_PAGEOBJ_SHADING and fully:
                to_remove.append((obj, bounds))
        tp.close()
        if to_patch:
            renders[pi] = _render_burned(doc, pi, g, rects_tl, dpi, fill)
            patched[pi] = [g.user_rect_to_tl(*b) for _, b in to_patch]
            stats["patched_objects"] += len(to_patch)
        for obj, _ in to_remove + to_patch:
            page.remove_obj(obj)
        if to_remove or to_patch:
            page.gen_content()
        page.close()
        ctx.progress(60 * (k + 1) / len(by_page), "redact")

    tmp = ctx.tmp("stage1.pdf")
    doc.save(tmp)
    doc.close()
    orig_doc = pdfium.PdfDocument(f.path, password=ctx.password_for(ctx.inputs.index(f)) or None)
    pdf = pikepdf.open(tmp)

    def draw(c, i, g: Geometry):
        from reportlab.lib.utils import ImageReader

        if i in renders:
            img, scale = renders[i]
            for x, y, w, h in patched.get(i, []):
                x0, y0 = max(0, x - 1), max(0, y - 1)
                x1, y1 = min(g.vw, x + w + 1), min(g.vh, y + h + 1)
                if x1 <= x0 or y1 <= y0:
                    continue
                crop = img.crop((int(x0 * scale), int(y0 * scale), int(x1 * scale + 0.999), int(y1 * scale + 0.999)))
                c.drawImage(ImageReader(crop), x0, g.vh - y1, x1 - x0, y1 - y0)
        c.setFillColorRGB(*fill)
        for x, y, w, h in by_page[i]:
            c.rect(x, g.vh - y - h, w, h, stroke=0, fill=1)

    forms = overlay_forms(pdf, [p for p in sorted(by_page) if p not in rasterized], draw)
    for i, form in forms.items():
        stamp(pdf, pdf.pages[i], form, kind="Redaction", artifact=False)

    # annotations and form widgets inside areas are removed as well
    annots_removed = 0
    for pi, rects_tl in by_page.items():
        page = pdf.pages[pi]
        g = geometry(page)
        user_rects = [g.rect_tl_to_user(*r) for r in rects_tl]
        if "/Annots" in page.obj:
            keep = []
            for a in page.obj.Annots:
                try:
                    ar = [float(v) for v in a.Rect]
                    ar = [min(ar[0], ar[2]), min(ar[1], ar[3]), max(ar[0], ar[2]), max(ar[1], ar[3])]
                    if any(_intersects(ar, ur) for ur in user_rects):
                        annots_removed += 1
                        continue
                except (AttributeError, ValueError, TypeError):
                    pass
                keep.append(a)
            page.obj.Annots = pikepdf.Array(keep)
    fix_acroform(pdf)

    for pi in rasterized:
        img, _ = _render_burned(orig_doc, pi, geos[pi], by_page[pi], dpi, fill)
        _replace_with_image(pdf, pdf.pages[pi], img)
        if "/Annots" in pdf.pages[pi].obj:
            del pdf.pages[pi].obj["/Annots"]
    fix_acroform(pdf)

    removed_meta = sanitize(pdf, {"metadata": ctx.p("scrub_metadata", True), "javascript": ctx.p("remove_javascript", True),
                                  "attachments": ctx.p("remove_attachments", False), "thumbnails": True})
    out_tmp = ctx.tmp("stage2.pdf")
    pdf.save(out_tmp)
    pdf.close()

    # ---- verification: the redacted content must not be extractable any more
    failed = verify_redaction(out_tmp, by_page, geos, secret_texts)
    if failed:
        pdf = pikepdf.open(out_tmp)
        for pi in failed:
            img, _ = _render_burned(orig_doc, pi, geos[pi], by_page[pi], dpi, fill)
            _replace_with_image(pdf, pdf.pages[pi], img)
            if "/Annots" in pdf.pages[pi].obj:
                del pdf.pages[pi].obj["/Annots"]
            rasterized.append(pi)
        fix_acroform(pdf)
        pdf.save(out_tmp)
        pdf.close()
        still = verify_redaction(out_tmp, by_page, geos, secret_texts)
    else:
        still = []
    orig_doc.close()
    final = pikepdf.open(out_tmp)
    ctx.save_pdf(final, f.stem + "_redacted.pdf")
    leaked = _leaked_terms(f.path, ctx.password_for(ctx.inputs.index(f)), f"{ctx.out_dir}/{ctx.outputs[-1]['file']}", secret_texts)
    ctx.result = {
        "areas": sum(len(v) for v in by_page.values()), "pages": sorted(p + 1 for p in by_page),
        "rasterized_pages": sorted(p + 1 for p in set(rasterized)), "annotations_removed": annots_removed,
        "stats": stats, "metadata_scrubbed": removed_meta,
        "verified": not still and not leaked, "unverified_pages": [p + 1 for p in still],
        "leaked_terms": len(leaked),
    }


def _page_text_in_rects(doc, pi, geos, rects_tl) -> str:
    page = doc[pi]
    tp = page.get_textpage()
    g = geos[pi]
    out = []
    for x, y, w, h in rects_tl:
        l, b, r, t = g.rect_tl_to_user(x + 0.5, y + 0.5, max(0.1, w - 1), max(0.1, h - 1))
        out.append(tp.get_text_bounded(l, b, r, t))
    tp.close()
    page.close()
    return re.sub(r"\s+", "", "".join(out))


def verify_redaction(path: str, by_page, geos, secrets_: set[str]) -> list[int]:
    doc = pdfium.PdfDocument(path)
    failed = []
    for pi, rects in by_page.items():
        if _page_text_in_rects(doc, pi, geos, rects):
            failed.append(pi)
    doc.close()
    return failed


def _full_text(path: str, password: str = "") -> str:
    doc = pdfium.PdfDocument(path, password=password or None)
    parts = []
    for i in range(len(doc)):
        page = doc[i]
        tp = page.get_textpage()
        parts.append(tp.get_text_range())
        tp.close()
        page.close()
    doc.close()
    return "\n".join(parts)


def _leaked_terms(orig: str, password: str, out: str, secrets_: set[str]) -> list[str]:
    """A word taken from inside a redaction area 'leaks' if it occurs in the output as many
    times as in the original, i.e. not a single occurrence was removed."""
    if not secrets_:
        return []
    before, after = _full_text(orig, password), _full_text(out)
    return [s for s in secrets_ if after.count(s) >= before.count(s) > 0]
