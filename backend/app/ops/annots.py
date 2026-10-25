"""Review annotations (stored as real PDF annotations with appearance streams) and
editing of existing text objects."""
from __future__ import annotations

import ctypes
import datetime as _dt
import math
import re
import secrets

import pikepdf
import pypdfium2 as pdfium
import pypdfium2.raw as pc
from pikepdf import Array, Dictionary, Name, String

from .base import Context, UserError, op, parse_color
from .geom import Geometry, geometry, overlay_forms
from .geom import stamp
from .stamps import _draw_item, _image_input, _reader
from .text import draw_line, is_rtl, wrap_text

STAMP_NAMES = {"approved": "Approved", "rejected": "NotApproved", "draft": "Draft", "confidential": "Confidential",
               "final": "Final", "reviewed": "Approved", "custom": "Draft"}


def _pdf_date() -> String:
    now = _dt.datetime.now(_dt.timezone.utc)
    return String(now.strftime("D:%Y%m%d%H%M%SZ"))


def _bbox_of(it: dict) -> list[float]:
    """Visible TL bbox [x, y, w, h] of an annotation spec."""
    t = it.get("type")
    if t in ("highlight", "underline", "strikeout", "squiggly"):
        rs = it.get("rects") or []
        if not rs:
            raise UserError("bad_params", "rects")
        x0 = min(r[0] for r in rs)
        y0 = min(r[1] for r in rs)
        x1 = max(r[0] + r[2] for r in rs)
        y1 = max(r[1] + r[3] for r in rs)
        return [x0, y0, x1 - x0, y1 - y0]
    if t in ("line", "arrow"):
        x1, y1, x2, y2 = (float(it[k]) for k in ("x1", "y1", "x2", "y2"))
        pad = float(it.get("stroke_width", 2)) * 4 + 4
        return [min(x1, x2) - pad, min(y1, y2) - pad, abs(x2 - x1) + 2 * pad, abs(y2 - y1) + 2 * pad]
    if t == "ink":
        pts = [p for path in it.get("paths", []) for p in path]
        if not pts:
            raise UserError("bad_params", "paths")
        pad = float(it.get("stroke_width", 2)) + 2
        xs = [float(p[0]) for p in pts]
        ys = [float(p[1]) for p in pts]
        return [min(xs) - pad, min(ys) - pad, max(xs) - min(xs) + 2 * pad, max(ys) - min(ys) + 2 * pad]
    if t == "note":
        return [float(it["x"]), float(it["y"]), 22, 22]
    return [float(it["x"]), float(it["y"]), float(it["w"]), float(it["h"])]


def _draw_annot(c, it: dict, g: Geometry, ctx: Context) -> None:
    t = it["type"]
    vh = g.vh
    color = parse_color(it.get("color"), (1, 0.85, 0) if t == "highlight" else (0.85, 0.1, 0.1))
    c.saveState()
    if t == "highlight":
        c.setFillColorRGB(*color)
        c.setFillAlpha(float(it.get("opacity", 0.4)))
        for x, y, w, h in it["rects"]:
            c.rect(x, vh - y - h, w, h, stroke=0, fill=1)
    elif t in ("underline", "strikeout", "squiggly"):
        c.setStrokeColorRGB(*color)
        for x, y, w, h in it["rects"]:
            lw = max(0.8, h / 14)
            c.setLineWidth(lw)
            if t == "strikeout":
                yy = vh - y - h * 0.5
                c.line(x, yy, x + w, yy)
            elif t == "underline":
                yy = vh - y - h + lw
                c.line(x, yy, x + w, yy)
            else:
                yy = vh - y - h + lw * 1.5
                p = c.beginPath()
                p.moveTo(x, yy)
                step = max(2, h / 6)
                k = 0
                xx = x
                while xx < x + w:
                    xx += step
                    p.lineTo(min(xx, x + w), yy + (step / 2 if k % 2 == 0 else -step / 2) * 0.6)
                    k += 1
                c.drawPath(p, stroke=1, fill=0)
    elif t == "note":
        x, y = float(it["x"]), float(it["y"])
        c.setFillColorRGB(*parse_color(it.get("color"), (1, 0.82, 0.2)))
        c.setStrokeColorRGB(0.35, 0.3, 0.1)
        c.setLineWidth(0.8)
        c.roundRect(x + 1, vh - y - 21, 20, 20, 3, stroke=1, fill=1)
        for k in range(3):
            c.line(x + 5, vh - y - 7 - k * 4.5, x + 17, vh - y - 7 - k * 4.5)
    elif t == "freetext":
        x, y, w, h = _bbox_of(it)
        if it.get("fill"):
            c.setFillColorRGB(*parse_color(it.get("fill"), (1, 1, 0.85)))
            c.rect(x, vh - y - h, w, h, stroke=0, fill=1)
        if it.get("border", True):
            c.setStrokeColorRGB(*color)
            c.setLineWidth(1)
            c.rect(x, vh - y - h, w, h, stroke=1, fill=0)
        size = float(it.get("size", 12))
        c.setFillColorRGB(*parse_color(it.get("text_color"), color))
        text = str(it.get("text") or it.get("contents") or "")
        align = "right" if is_rtl(text) else "left"
        yy = vh - y - 3 - size
        for line in wrap_text(text, w - 6, size, it.get("family", "sans")):
            draw_line(c, line, x + w - 3 if align == "right" else x + 3, yy, size, it.get("family", "sans"), False, align)
            yy -= size * 1.25
    elif t == "stamp":
        x, y, w, h = _bbox_of(it)
        if it.get("file") is not None:
            reader, _ = _reader(_image_input(ctx, int(it["file"])).path)
            c.drawImage(reader, x, vh - y - h, w, h, mask="auto")
        else:
            c.setStrokeColorRGB(*color)
            c.setFillColorRGB(*color)
            c.setLineWidth(max(1.5, h / 14))
            c.roundRect(x + 1.5, vh - y - h + 1.5, w - 3, h - 3, min(8, h / 4), stroke=1, fill=0)
            label = str(it.get("text") or "APPROVED")
            size = min(h * 0.5, (w - 10) / max(1, len(label) * 0.62))
            draw_line(c, label, x + w / 2, vh - y - h / 2 - size * 0.35, size, "sans", True, "center")
    else:
        spec = dict(it)
        if t in ("square", "circle"):
            spec["type"] = "rect" if t == "square" else "ellipse"
            spec["stroke"] = it.get("color") or "#d01010"
            spec["fill"] = it.get("fill")
        _draw_item(c, spec, g, ctx)
    c.restoreState()


def _ap_from_form(pdf: pikepdf.Pdf, form, g: Geometry, rect: list[float]) -> pikepdf.Stream:
    a, b, cc, d, e, f = g.matrix()
    ap = pdf.make_stream(f"q {a} {b} {cc} {d} {e:.4f} {f:.4f} cm /Fm Do Q".encode())
    ap.Type, ap.Subtype = Name.XObject, Name.Form
    ap.BBox = Array(rect)
    ap.Resources = Dictionary(XObject=Dictionary(Fm=form))
    return ap


@op("annotate")
def annotate(ctx: Context) -> None:
    f = ctx.first_pdf()
    pdf = ctx.open_pdf(f)
    items = ctx.p("items") or []
    if not items:
        raise UserError("no_items")
    author = str(ctx.p("author") or "")[:100]
    # one reportlab page per annotation (each becomes its appearance stream)
    page_of = []
    for it in items:
        pi = int(it.get("page", 0))
        if pi < 0 or pi >= len(pdf.pages):
            raise UserError("page_out_of_range")
        page_of.append(pi)
    import io

    from reportlab.pdfgen import canvas as rl

    buf = io.BytesIO()
    c = rl.Canvas(buf, pageCompression=1)
    geos = []
    for it, pi in zip(items, page_of):
        g = geometry(pdf.pages[pi])
        geos.append(g)
        c.setPageSize((g.vw, g.vh))
        _draw_annot(c, it, g, ctx)
        c.showPage()
    c.save()
    buf.seek(0)
    src = pikepdf.open(buf)
    created = 0
    for k, (it, pi, g) in enumerate(zip(items, page_of, geos)):
        page = pdf.pages[pi]
        t = it["type"]
        x, y, w, h = _bbox_of(it)
        rect = g.rect_tl_to_user(x, y, w, h)
        form = pdf.copy_foreign(src.pages[k].as_form_xobject())
        color = parse_color(it.get("color"), (1, 0.85, 0) if t == "highlight" else (0.85, 0.1, 0.1))
        sub = {"highlight": "Highlight", "underline": "Underline", "strikeout": "StrikeOut", "squiggly": "Squiggly",
               "note": "Text", "freetext": "FreeText", "ink": "Ink", "line": "Line", "arrow": "Line",
               "square": "Square", "circle": "Circle", "stamp": "Stamp"}.get(t)
        if not sub:
            raise UserError("bad_params", "type")
        annot = Dictionary(Type=Name.Annot, Subtype=Name("/" + sub), Rect=Array(rect), F=4, P=page.obj,
                           C=Array(list(color)), M=_pdf_date(), NM=String("pdfaty-" + secrets.token_hex(6)),
                           AP=Dictionary(N=_ap_from_form(pdf, form, g, rect)))
        if author:
            annot.T = String(author)
        contents = str(it.get("contents") or (it.get("text") if t == "freetext" else "") or "")
        if contents:
            annot.Contents = String(contents[:10000])
        if t in ("highlight", "underline", "strikeout", "squiggly"):
            quads = []
            for rx, ry, rw, rh in it["rects"]:
                tl, tr = g.tl_to_user(rx, ry), g.tl_to_user(rx + rw, ry)
                bl, br = g.tl_to_user(rx, ry + rh), g.tl_to_user(rx + rw, ry + rh)
                quads += [tl[0], tl[1], tr[0], tr[1], bl[0], bl[1], br[0], br[1]]
            annot.QuadPoints = Array([round(v, 3) for v in quads])
            if t == "highlight":
                annot.CA = float(it.get("opacity", 0.4))
                annot.AP.N.Group = Dictionary(S=Name.Transparency)
        elif t == "note":
            annot.Name = Name.Comment
            annot.Open = False
        elif t == "freetext":
            size = float(it.get("size", 12))
            annot.DA = String(f"/Helv {size:g} Tf {color[0]:.3f} {color[1]:.3f} {color[2]:.3f} rg")
        elif t == "ink":
            annot.InkList = Array([Array([v for p in path for v in g.tl_to_user(float(p[0]), float(p[1]))]) for path in it["paths"]])
            annot.BS = Dictionary(W=float(it.get("stroke_width", 2)))
        elif t in ("line", "arrow"):
            p1 = g.tl_to_user(float(it["x1"]), float(it["y1"]))
            p2 = g.tl_to_user(float(it["x2"]), float(it["y2"]))
            annot.L = Array([p1[0], p1[1], p2[0], p2[1]])
            annot.BS = Dictionary(W=float(it.get("stroke_width", 2)))
            if t == "arrow":
                annot.LE = Array([Name.None_ if hasattr(Name, "None_") else Name("/None"), Name.OpenArrow])
        elif t in ("square", "circle"):
            annot.BS = Dictionary(W=float(it.get("stroke_width", 2)))
            if it.get("fill"):
                annot.IC = Array(list(parse_color(it["fill"])))
        elif t == "stamp":
            annot.Name = Name("/" + STAMP_NAMES.get(str(it.get("stamp", "custom")), "Draft"))
        if "/Annots" not in page.obj:
            page.obj.Annots = Array()
        page.obj.Annots.append(pdf.make_indirect(annot))
        created += 1
    ctx.save_pdf(pdf, f.stem + ".pdf")
    ctx.result = {"created": created}


def _parse_ref(s: str) -> tuple[int, int] | None:
    m = re.fullmatch(r"(\d+)R(\d*)", str(s))
    if not m:
        return None
    return int(m.group(1)), int(m.group(2) or 0)


@op("annot_edit")
def annot_edit(ctx: Context) -> None:
    f = ctx.first_pdf()
    pdf = ctx.open_pdf(f)
    actions = ctx.p("actions") or []
    targets = {}
    for a in actions:
        ref = _parse_ref(a.get("id", ""))
        if ref:
            targets[ref] = a
    if not targets:
        raise UserError("no_items")
    deleted = updated = 0
    for page in pdf.pages:
        if "/Annots" not in page.obj:
            continue
        keep = []
        delete_refs = set()
        for an in page.obj.Annots:
            act = targets.get(an.objgen)
            if act and act.get("action") == "delete":
                delete_refs.add(an.objgen)
                if "/Popup" in an:
                    delete_refs.add(an.Popup.objgen)
        for an in page.obj.Annots:
            if an.objgen in delete_refs or ("/IRT" in an and an.IRT.objgen in delete_refs) or \
                    ("/Parent" in an and an.get("/Subtype") == Name.Popup and an.Parent.objgen in delete_refs):
                if an.objgen in targets:
                    deleted += 1
                continue
            act = targets.get(an.objgen)
            if act and act.get("action") == "update":
                if "contents" in act:
                    an.Contents = String(str(act["contents"])[:10000])
                if act.get("color"):
                    an.C = Array(list(parse_color(act["color"])))
                an.M = _pdf_date()
                updated += 1
            keep.append(an)
        page.obj.Annots = Array(keep)
    ctx.save_pdf(pdf, f.stem + ".pdf")
    ctx.result = {"deleted": deleted, "updated": updated}


@op("annotations_list")
def annotations_list(ctx: Context) -> None:
    pdf = ctx.open_pdf()
    out = []
    for pi, page in enumerate(pdf.pages):
        g = geometry(page)
        for an in page.obj.get("/Annots", []) or []:
            sub = str(an.get("/Subtype", "")).lstrip("/")
            if sub in ("Link", "Widget", "Popup"):
                continue
            try:
                r = [float(v) for v in an.Rect]
                rect = g.user_rect_to_tl(min(r[0], r[2]), min(r[1], r[3]), max(r[0], r[2]), max(r[1], r[3]))
            except (AttributeError, ValueError, TypeError):
                rect = None
            num, gen = an.objgen
            out.append({"id": f"{num}R{gen if gen else ''}", "page": pi, "type": sub, "rect": rect,
                        "contents": str(an.get("/Contents", ""))[:2000], "author": str(an.get("/T", ""))[:200],
                        "modified": str(an.get("/M", ""))})
    ctx.result = {"annotations": out}


# --------------------------------------------------------------------------- existing text editing
def _text_obj_info(obj, tp) -> dict:
    n = pc.FPDFTextObj_GetText(obj.raw, tp.raw, None, 0)
    text = ""
    if n > 2:
        buf = ctypes.create_string_buffer(n)
        pc.FPDFTextObj_GetText(obj.raw, tp.raw, ctypes.cast(buf, ctypes.POINTER(ctypes.c_ushort)), n)
        text = buf.raw[: n - 2].decode("utf-16-le", "replace")
    size = ctypes.c_float(0)
    pc.FPDFTextObj_GetFontSize(obj.raw, ctypes.byref(size))
    m = obj.get_matrix()
    scale = math.hypot(m.a, m.b) or 1
    font = pc.FPDFTextObj_GetFont(obj.raw)
    name = ""
    weight = 400
    if font:
        k = pc.FPDFFont_GetBaseFontName(font, None, 0)
        if k:
            b = ctypes.create_string_buffer(k)
            pc.FPDFFont_GetBaseFontName(font, b, k)
            name = b.value.decode("latin-1", "replace")
        weight = pc.FPDFFont_GetWeight(font)
    r, g_, b_, a = ctypes.c_uint(), ctypes.c_uint(), ctypes.c_uint(), ctypes.c_uint()
    color = "#000000"
    if pc.FPDFPageObj_GetFillColor(obj.raw, ctypes.byref(r), ctypes.byref(g_), ctypes.byref(b_), ctypes.byref(a)):
        color = "#%02x%02x%02x" % (r.value, g_.value, b_.value)
    return {"text": text, "size": round(size.value * scale, 2), "font": name.split("+")[-1], "color": color,
            "bold": weight >= 600 or "bold" in name.lower(), "origin": (m.e, m.f), "rotated": abs(m.b) > 1e-3 or abs(m.c) > 1e-3}


@op("text_objects")
def text_objects(ctx: Context) -> None:
    f = ctx.first_pdf()
    pdf = ctx.open_pdf(f)
    pi = ctx.pint("page", 0, 0, len(pdf.pages) - 1)
    g = geometry(pdf.pages[pi])
    doc = pdfium.PdfDocument(f.path, password=ctx.password_for(ctx.inputs.index(f)) or None)
    page = doc[pi]
    tp = page.get_textpage()
    from .extract import build_lines, page_chars

    by_obj: dict[int, list] = {}
    for ch in page_chars(page, tp, g, with_obj=True):
        by_obj.setdefault(ch.obj, []).append(ch)
    out = []
    for idx, obj in enumerate(page.get_objects(max_depth=1)):
        if obj.type != pc.FPDF_PAGEOBJ_TEXT:
            continue
        info = _text_obj_info(obj, tp)
        chars = by_obj.get(ctypes.cast(obj.raw, ctypes.c_void_p).value or 0)
        if chars:
            info["text"] = " ".join(ln.text for ln in build_lines(chars, split_gap=1000))
        if not info["text"].strip():
            continue
        l, b, r, t = obj.get_bounds()
        ox, oy = g.user_to_tl(*info.pop("origin"))
        out.append({"index": idx, "rect": [round(v, 2) for v in g.user_rect_to_tl(l, b, r, t)],
                    "baseline": round(oy, 2), "origin_x": round(ox, 2), **info})
    tp.close()
    page.close()
    doc.close()
    ctx.result = {"page": pi, "objects": out}


@op("replace_text")
def replace_text(ctx: Context) -> None:
    """Remove the selected text objects for real and draw the replacement text in their place.
    Replacement uses PDFATY's embedded fonts (the original font is usually a subset that does
    not contain the new glyphs)."""
    f = ctx.first_pdf()
    pdf0 = ctx.open_pdf(f)
    edits = ctx.p("edits") or []
    if not edits:
        raise UserError("no_items")
    doc = pdfium.PdfDocument(f.path, password=ctx.password_for(ctx.inputs.index(f)) or None)
    removed = 0
    by_page: dict[int, list[dict]] = {}
    for e in edits:
        pi = int(e.get("page", 0))
        if pi < 0 or pi >= len(doc):
            raise UserError("page_out_of_range")
        by_page.setdefault(pi, []).append(e)
    for pi, es in by_page.items():
        page = doc[pi]
        want = {int(i) for e in es for i in (e.get("ids") or [])}
        objs = list(page.get_objects(max_depth=1))
        victims = [o for i, o in enumerate(objs) if i in want and o.type == pc.FPDF_PAGEOBJ_TEXT]
        for o in victims:
            page.remove_obj(o)
            removed += 1
        if victims:
            page.gen_content()
        page.close()
    if not removed:
        raise UserError("no_text_found")
    tmp = ctx.tmp("removed.pdf")
    doc.save(tmp)
    doc.close()
    pdf0.close()
    pdf = pikepdf.open(tmp)

    def draw(c, i, g):
        for e in by_page.get(i, []):
            if not str(e.get("text", "")).strip():
                continue
            item = {"type": "text", **e}
            item.setdefault("wrap", False)
            if e.get("baseline") is not None:
                # place the first line on the original baseline
                size = float(e.get("size", 12))
                item["y"] = float(e["baseline"]) - size * 0.92
            _draw_item(c, item, g, ctx)

    forms = overlay_forms(pdf, sorted(by_page), draw)
    for i, form in forms.items():
        stamp(pdf, pdf.pages[i], form, kind="Edit", artifact=False)
    ctx.save_pdf(pdf, f.stem + ".pdf")
    ctx.result = {"removed_objects": removed}
