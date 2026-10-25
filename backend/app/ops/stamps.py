"""Watermarks, backgrounds, headers/footers/page numbers and burned-in edits
(text, images, shapes, signatures, white-out, links)."""
from __future__ import annotations

import datetime as _dt
import math

import pikepdf
from PIL import Image
from pikepdf import Array, Dictionary, Name
from reportlab.lib.utils import ImageReader

from .base import Context, UserError, op, parse_color, parse_pages
from .geom import Geometry, overlay_forms, stamp
from .text import draw_line, is_rtl, text_width, to_arabic_digits, wrap_text

POSITIONS = {
    "tl": (0, 1), "tc": (0.5, 1), "tr": (1, 1),
    "ml": (0, 0.5), "mc": (0.5, 0.5), "mr": (1, 0.5),
    "bl": (0, 0), "bc": (0.5, 0), "br": (1, 0),
}


def _image_input(ctx: Context, index: int | None = None):
    imgs = [i for i, f in enumerate(ctx.inputs) if f.kind == "image"]
    if index is not None:
        if index < 0 or index >= len(ctx.inputs) or ctx.inputs[index].kind != "image":
            raise UserError("image_required")
        return ctx.inputs[index]
    if not imgs:
        raise UserError("image_required")
    return ctx.inputs[imgs[0]]


_img_cache: dict[str, tuple[ImageReader, tuple[int, int]]] = {}


def _reader(path: str):
    if path not in _img_cache:
        im = Image.open(path)
        im.load()
        if im.mode not in ("RGB", "RGBA", "L", "LA"):
            im = im.convert("RGBA")
        _img_cache[path] = (ImageReader(im), im.size)
    return _img_cache[path]


def _finish(ctx: Context, pdf: pikepdf.Pdf, name: str, targets: list[int]) -> None:
    preview = ctx.p("preview_page")
    if preview is not None:
        pi = int(preview)
        if pi < 0 or pi >= len(pdf.pages):
            raise UserError("page_out_of_range")
        out = pikepdf.new()
        out.pages.append(pdf.pages[pi])
        ctx.save_pdf(out, "preview.pdf")
        return
    ctx.save_pdf(pdf, name)
    ctx.result = {"pages_changed": len(targets)}


def _preview_targets(ctx: Context, targets: list[int]) -> list[int]:
    preview = ctx.p("preview_page")
    if preview is None:
        return targets
    pi = int(preview)
    return [pi] if pi in targets else []


# --------------------------------------------------------------------------- watermark
def draw_watermark(c, g: Geometry, cfg: dict, img=None) -> None:
    vw, vh = g.vw, g.vh
    opacity = float(cfg.get("opacity", 0.25))
    rotation = float(cfg.get("rotation", 45))
    color = parse_color(cfg.get("color"), (0.8, 0.1, 0.1))
    family = cfg.get("family", "sans")
    bold = bool(cfg.get("bold", True))
    c.saveState()
    c.setFillAlpha(opacity)
    c.setStrokeAlpha(opacity)
    c.setFillColorRGB(*color)
    if img is not None:
        reader, (iw, ih) = img
        scale = float(cfg.get("scale", 0.5))
        w = vw * scale
        h = w * ih / iw
    else:
        text = str(cfg.get("text") or "")
        size = float(cfg.get("size", 0)) or max(12.0, min(vw, vh) / max(4, len(text) * 0.55))
        w = text_width(text, size, family, bold)
        h = size

    def put(cx: float, cy: float) -> None:
        c.saveState()
        c.translate(cx, cy)
        c.rotate(rotation)
        if img is not None:
            c.drawImage(reader, -w / 2, -h / 2, w, h, mask="auto")
        else:
            draw_line(c, text, 0, -h * 0.35, size, family, bold, align="center")
        c.restoreState()

    if cfg.get("tile"):
        gap = float(cfg.get("gap", 60))
        step_x = w + gap
        step_y = h + gap
        diag = math.hypot(vw, vh)
        ny = int(diag / step_y) + 2
        nx = int(diag / step_x) + 2
        c.translate(vw / 2, vh / 2)
        c.rotate(rotation)
        for j in range(-ny, ny + 1):
            off = (step_x / 2) if j % 2 else 0
            for i in range(-nx, nx + 1):
                c.saveState()
                c.translate(i * step_x + off, j * step_y)
                if img is not None:
                    c.drawImage(reader, -w / 2, -h / 2, w, h, mask="auto")
                else:
                    draw_line(c, text, 0, -h * 0.35, size, family, bold, align="center")
                c.restoreState()
    else:
        fx, fy = POSITIONS.get(str(cfg.get("position", "mc")), (0.5, 0.5))
        margin = float(cfg.get("margin", 36))
        rad = math.radians(rotation)
        bw = abs(w * math.cos(rad)) + abs(h * math.sin(rad))
        bh = abs(w * math.sin(rad)) + abs(h * math.cos(rad))
        cx = margin + bw / 2 + fx * (vw - 2 * margin - bw)
        cy = margin + bh / 2 + fy * (vh - 2 * margin - bh)
        cx += float(cfg.get("offset_x", 0))
        cy -= float(cfg.get("offset_y", 0))
        put(cx, cy)
    c.restoreState()


@op("watermark_add")
def watermark_add(ctx: Context) -> None:
    f = ctx.first_pdf()
    pdf = ctx.open_pdf(f)
    cfg = dict(ctx.params)
    kind = cfg.get("type", "text")
    img = None
    if kind == "image":
        img = _reader(_image_input(ctx, cfg.get("image_index")).path)
    elif not str(cfg.get("text") or "").strip():
        raise UserError("text_required")
    targets = parse_pages(cfg.get("pages"), len(pdf.pages))
    work = _preview_targets(ctx, targets)
    forms = overlay_forms(pdf, work, lambda c, i, g: draw_watermark(c, g, cfg, img))
    under = cfg.get("layer") == "under"
    for n, (i, form) in enumerate(forms.items()):
        stamp(pdf, pdf.pages[i], form, under=under, kind="Watermark", tag="PDFATY-Watermark")
        ctx.progress(100 * (n + 1) / max(1, len(forms)))
    _finish(ctx, pdf, f.stem + ".pdf", targets)


# --------------------------------------------------------------------------- background
@op("background_add")
def background_add(ctx: Context) -> None:
    f = ctx.first_pdf()
    pdf = ctx.open_pdf(f)
    cfg = ctx.params
    opacity = float(cfg.get("opacity", 1))
    img = _reader(_image_input(ctx, cfg.get("image_index")).path) if cfg.get("type") == "image" else None
    color = parse_color(cfg.get("color"), (1, 0.98, 0.9))
    fit = cfg.get("fit", "cover")

    def draw(c, i, g: Geometry):
        c.saveState()
        c.setFillAlpha(opacity)
        if img is None:
            c.setFillColorRGB(*color)
            c.rect(0, 0, g.vw, g.vh, stroke=0, fill=1)
        else:
            reader, (iw, ih) = img
            if fit == "stretch":
                c.drawImage(reader, 0, 0, g.vw, g.vh, mask="auto")
            else:
                s = (max if fit == "cover" else min)(g.vw / iw, g.vh / ih)
                if fit == "center":
                    s = min(1.0, s) * float(cfg.get("scale", 1))
                w, h = iw * s, ih * s
                p = c.beginPath()
                p.rect(0, 0, g.vw, g.vh)
                c.clipPath(p, stroke=0, fill=0)
                c.drawImage(reader, (g.vw - w) / 2, (g.vh - h) / 2, w, h, mask="auto")
        c.restoreState()

    targets = parse_pages(cfg.get("pages"), len(pdf.pages))
    forms = overlay_forms(pdf, _preview_targets(ctx, targets), draw)
    for n, (i, form) in enumerate(forms.items()):
        stamp(pdf, pdf.pages[i], form, under=True, kind="Background", tag="PDFATY-Background")
        ctx.progress(100 * (n + 1) / max(1, len(forms)))
    _finish(ctx, pdf, f.stem + ".pdf", targets)


# --------------------------------------------------------------------------- header / footer / numbers
NUMBER_FORMATS = {
    "n": "{page}", "n_of": "{page} / {pages}", "page_n": "Page {page}", "page_n_of": "Page {page} of {pages}",
    "ar_n": "صفحة {page}", "ar_n_of": "صفحة {page} من {pages}", "dash": "- {page} -",
}


@op("header_footer")
def header_footer(ctx: Context) -> None:
    f = ctx.first_pdf()
    pdf = ctx.open_pdf(f)
    cfg = ctx.params
    slots = dict(cfg.get("slots") or {})
    if cfg.get("numbering"):
        pos = cfg.get("number_position", "bc")
        fmt = cfg.get("number_format", "n")
        slots[pos] = NUMBER_FORMATS.get(fmt, fmt if "{page}" in str(fmt) else "{page}")
    slots = {k: str(v) for k, v in slots.items() if k in POSITIONS and str(v).strip()}
    if not slots:
        raise UserError("text_required")
    total = len(pdf.pages)
    targets = parse_pages(cfg.get("pages"), total)
    exclude = set(parse_pages(cfg.get("exclude"), total, default_all=False)) if cfg.get("exclude") else set()
    if cfg.get("skip_first"):
        exclude.add(0)
    targets = [t for t in targets if t not in exclude]
    start = int(cfg.get("start", 1) or 1)
    digits = cfg.get("digits", "latin")
    size = float(cfg.get("size", 10))
    family = cfg.get("family", "sans")
    bold = bool(cfg.get("bold", False))
    color = parse_color(cfg.get("color"), (0.2, 0.2, 0.2))
    mx = float(cfg.get("margin_x", 40))
    my = float(cfg.get("margin_y", 28))
    opacity = float(cfg.get("opacity", 1))
    date = str(cfg.get("date") or _dt.date.today().isoformat())
    title = str(cfg.get("title") or pdf.docinfo.get("/Title", "") or f.stem)
    rank = {p: k for k, p in enumerate(targets)}
    pages_total = start - 1 + len(targets)

    def fill(tpl: str, i: int) -> str:
        num, tot = str(start + rank[i]), str(pages_total)
        if digits == "arabic":
            num, tot = to_arabic_digits(num), to_arabic_digits(tot)
        return (tpl.replace("{page}", num).replace("{pages}", tot).replace("{date}", date)
                .replace("{title}", title).replace("{filename}", f.stem))

    def draw(c, i, g: Geometry):
        c.saveState()
        c.setFillAlpha(opacity)
        c.setFillColorRGB(*color)
        for pos, tpl in slots.items():
            fx, fy = POSITIONS[pos]
            text = fill(tpl, i)
            y = g.vh - my - size * 0.8 if fy == 1 else (my if fy == 0 else g.vh / 2)
            if fx == 0:
                draw_line(c, text, mx, y, size, family, bold, "left")
            elif fx == 1:
                draw_line(c, text, g.vw - mx, y, size, family, bold, "right")
            else:
                draw_line(c, text, g.vw / 2, y, size, family, bold, "center")
        c.restoreState()

    forms = overlay_forms(pdf, _preview_targets(ctx, targets), draw)
    for n, (i, form) in enumerate(forms.items()):
        stamp(pdf, pdf.pages[i], form, kind="Header", tag="PDFATY-Header")
        ctx.progress(100 * (n + 1) / max(1, len(forms)))
    _finish(ctx, pdf, f.stem + ".pdf", targets)


# --------------------------------------------------------------------------- burned-in edits
def _draw_item(c, it: dict, g: Geometry, ctx: Context) -> None:
    t = it.get("type")
    vh = g.vh
    opacity = float(it.get("opacity", 1))
    c.saveState()
    c.setFillAlpha(opacity)
    c.setStrokeAlpha(opacity)
    x, y = float(it.get("x", 0)), float(it.get("y", 0))
    w, h = float(it.get("w", 0)), float(it.get("h", 0))
    rot = float(it.get("rotation", 0) or 0)
    if rot and t in ("text", "image", "rect", "ellipse", "whiteout"):
        cx, cy = x + w / 2, vh - (y + h / 2)
        c.translate(cx, cy)
        c.rotate(-rot)
        c.translate(-cx, -cy)
    if t in ("text",):
        text = str(it.get("text", ""))
        size = float(it.get("size", 12))
        family = it.get("family", "sans")
        bold = bool(it.get("bold"))
        color = parse_color(it.get("color"), (0, 0, 0))
        if it.get("bg"):
            c.setFillColorRGB(*parse_color(it.get("bg"), (1, 1, 1)))
            c.rect(x, vh - y - h, w, h, stroke=0, fill=1)
        c.setFillColorRGB(*color)
        align = it.get("align") or ("right" if is_rtl(text) else "left")
        lh = float(it.get("line_height", 1.25)) * size
        lines = wrap_text(text, w if w > 0 and it.get("wrap", True) else 0, size, family, bold)
        base = vh - y - size * 0.92
        for k, line in enumerate(lines):
            ax = x if align == "left" else (x + w if align == "right" else x + w / 2)
            draw_line(c, line, ax, base - k * lh, size, family, bold, align)
            if it.get("underline"):
                lw = text_width(line, size, family, bold)
                lx = ax if align == "left" else (ax - lw if align == "right" else ax - lw / 2)
                c.setStrokeColorRGB(*color)
                c.setLineWidth(max(0.5, size / 16))
                c.line(lx, base - k * lh - size * 0.12, lx + lw, base - k * lh - size * 0.12)
    elif t == "image":
        idx = it.get("file")
        f = _image_input(ctx, int(idx) if idx is not None else None)
        reader, _ = _reader(f.path)
        c.drawImage(reader, x, vh - y - h, w, h, mask="auto")
    elif t in ("rect", "ellipse", "whiteout"):
        stroke_color = it.get("stroke")
        fill_color = it.get("fill") if t != "whiteout" else (it.get("fill") or "#ffffff")
        sw = float(it.get("stroke_width", 1.5))
        if stroke_color:
            c.setStrokeColorRGB(*parse_color(stroke_color))
            c.setLineWidth(sw)
        if fill_color:
            c.setFillColorRGB(*parse_color(fill_color, (1, 1, 1)))
        if t == "ellipse":
            c.ellipse(x, vh - y - h, x + w, vh - y, stroke=1 if stroke_color else 0, fill=1 if fill_color else 0)
        else:
            c.rect(x, vh - y - h, w, h, stroke=1 if stroke_color else 0, fill=1 if fill_color else 0)
    elif t in ("line", "arrow"):
        x1, y1, x2, y2 = (float(it.get(k, 0)) for k in ("x1", "y1", "x2", "y2"))
        sw = float(it.get("stroke_width", 2))
        col = parse_color(it.get("stroke") or it.get("color"), (0.8, 0, 0))
        c.setStrokeColorRGB(*col)
        c.setFillColorRGB(*col)
        c.setLineWidth(sw)
        c.setLineCap(1)
        c.line(x1, vh - y1, x2, vh - y2)
        if t == "arrow":
            ang = math.atan2((vh - y2) - (vh - y1), x2 - x1)
            L = max(8, sw * 4)
            p = c.beginPath()
            p.moveTo(x2, vh - y2)
            p.lineTo(x2 - L * math.cos(ang - 0.45), vh - y2 - L * math.sin(ang - 0.45))
            p.lineTo(x2 - L * math.cos(ang + 0.45), vh - y2 - L * math.sin(ang + 0.45))
            p.close()
            c.drawPath(p, stroke=0, fill=1)
    elif t == "ink":
        col = parse_color(it.get("stroke") or it.get("color"), (0, 0, 0.6))
        c.setStrokeColorRGB(*col)
        c.setLineWidth(float(it.get("stroke_width", 2)))
        c.setLineCap(1)
        c.setLineJoin(1)
        for path in it.get("paths", []):
            if len(path) < 2:
                continue
            p = c.beginPath()
            p.moveTo(float(path[0][0]), vh - float(path[0][1]))
            for pt in path[1:]:
                p.lineTo(float(pt[0]), vh - float(pt[1]))
            c.drawPath(p, stroke=1, fill=0)
    c.restoreState()


def add_link(pdf: pikepdf.Pdf, page: pikepdf.Page, g: Geometry, it: dict) -> None:
    rect = g.rect_tl_to_user(float(it["x"]), float(it["y"]), float(it["w"]), float(it["h"]))
    annot = Dictionary(Type=Name.Annot, Subtype=Name.Link, Rect=Array(rect), Border=Array([0, 0, 0]))
    if it.get("url"):
        url = str(it["url"]).strip()
        if not url.lower().startswith(("http://", "https://", "mailto:")):
            raise UserError("bad_url")
        annot.A = Dictionary(S=Name.URI, URI=pikepdf.String(url))
    elif it.get("dest_page") is not None:
        dp = int(it["dest_page"])
        if dp < 0 or dp >= len(pdf.pages):
            raise UserError("page_out_of_range")
        annot.Dest = Array([pdf.pages[dp].obj, Name.Fit])
    else:
        raise UserError("bad_params", "link")
    if "/Annots" not in page.obj:
        page.obj.Annots = Array()
    page.obj.Annots.append(pdf.make_indirect(annot))


@op("edit_overlay")
def edit_overlay(ctx: Context) -> None:
    f = ctx.first_pdf()
    pdf = ctx.open_pdf(f)
    items = ctx.p("items") or []
    if not isinstance(items, list) or not items:
        raise UserError("no_items")
    by_page: dict[int, list[dict]] = {}
    links = []
    n = len(pdf.pages)
    for it in items:
        if not isinstance(it, dict):
            raise UserError("bad_params", "items")
        pages = it.get("pages")
        idx = parse_pages(pages, n) if pages is not None else [int(it.get("page", 0))]
        for pi in idx:
            if pi < 0 or pi >= n:
                raise UserError("page_out_of_range")
            if it.get("type") == "link":
                links.append((pi, it))
            else:
                by_page.setdefault(pi, []).append(it)

    def draw(c, i, g):
        for it in by_page.get(i, []):
            _draw_item(c, it, g, ctx)

    forms = overlay_forms(pdf, sorted(by_page), draw)
    for i, form in forms.items():
        stamp(pdf, pdf.pages[i], form, kind="Edit", artifact=False)
    from .geom import geometry
    for pi, it in links:
        add_link(pdf, pdf.pages[pi], geometry(pdf.pages[pi]), it)
    ctx.save_pdf(pdf, f.stem + ".pdf")
    ctx.result = {"pages_changed": len(forms) + len({p for p, _ in links})}
