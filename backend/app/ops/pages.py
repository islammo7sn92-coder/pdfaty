"""Page management: info, merge, split, organize (reorder/rotate/delete/insert/replace/blank),
blank-page detection, blank documents."""
from __future__ import annotations

import pikepdf
import pypdfium2 as pdfium
from pikepdf import Array, Dictionary, Name

from .base import Context, UserError, op, parse_pages, open_pdf
from .geom import inherited

PAPER = {
    "a4": (595.276, 841.89), "a3": (841.89, 1190.55), "a5": (419.53, 595.276),
    "letter": (612, 792), "legal": (612, 1008),
}


def paper_size(name: str | None, orientation: str | None = None, w: float | None = None, h: float | None = None):
    if w and h:
        size = (float(w), float(h))
    else:
        size = PAPER.get(str(name or "a4").lower(), PAPER["a4"])
    if orientation == "landscape" and size[0] < size[1] or orientation == "portrait" and size[0] > size[1]:
        size = (size[1], size[0])
    return size


def blank_page_obj(pdf: pikepdf.Pdf, w: float, h: float) -> pikepdf.Page:
    obj = pdf.make_indirect(Dictionary(
        Type=Name.Page, MediaBox=Array([0, 0, w, h]), Resources=Dictionary(),
        Contents=pdf.make_stream(b""),
    ))
    return pikepdf.Page(obj)


def fix_acroform(pdf: pikepdf.Pdf) -> None:
    """Rebuild /AcroForm /Fields from the widgets actually present on pages, so form fields
    survive merges, reordering and page imports."""
    fields: list = []
    seen: set = set()
    names: dict[str, int] = {}
    for page in pdf.pages:
        for annot in page.obj.get("/Annots", []) or []:
            try:
                if annot.get("/Subtype") != Name.Widget:
                    continue
                top = annot
                for _ in range(32):
                    if "/Parent" not in top:
                        break
                    top = top.Parent
                key = top.objgen
                if key in seen or key == (0, 0):
                    continue
                seen.add(key)
                t = str(top.get("/T", ""))
                if t:
                    if t in names:
                        names[t] += 1
                        top.T = pikepdf.String(f"{t}_{names[t]}")
                    else:
                        names[t] = 1
                fields.append(top)
            except (AttributeError, TypeError, ValueError):
                continue
    if not fields:
        if "/AcroForm" in pdf.Root and not pdf.Root.AcroForm.get("/Fields"):
            del pdf.Root["/AcroForm"]
        return
    if "/AcroForm" not in pdf.Root:
        pdf.Root.AcroForm = pdf.make_indirect(Dictionary(Fields=Array(), DA=pikepdf.String("/Helv 0 Tf 0 g")))
    pdf.Root.AcroForm.Fields = Array(fields)


def _merge_acroform_resources(dst: pikepdf.Pdf, src: pikepdf.Pdf) -> None:
    if "/AcroForm" not in src.Root:
        return
    sa = src.Root.AcroForm
    if "/AcroForm" not in dst.Root:
        dst.Root.AcroForm = dst.make_indirect(Dictionary(Fields=Array()))
    da = dst.Root.AcroForm
    if "/DA" in sa and "/DA" not in da:
        da.DA = sa.DA
    if "/NeedAppearances" in sa:
        da.NeedAppearances = sa.NeedAppearances
    if "/DR" in sa:
        dr = sa.DR if sa.DR.is_indirect else src.make_indirect(sa.DR)
        dr_src = dst.copy_foreign(dr)
        if "/DR" not in da:
            da.DR = dr_src
        else:
            for cat in ("/Font", "/XObject", "/ColorSpace"):
                if cat in dr_src:
                    if cat not in da.DR:
                        da.DR[cat] = Dictionary()
                    for k, v in dr_src[cat].items():
                        if k not in da.DR[cat]:
                            da.DR[cat][k] = v


def _materialize_inherited(page: pikepdf.Page) -> None:
    for key in ("/Resources", "/MediaBox", "/CropBox", "/Rotate"):
        if key not in page.obj:
            v = inherited(page.obj, key)
            if v is not None:
                page.obj[key] = v


@op("info")
def info(ctx: Context) -> None:
    f = ctx.first_pdf()
    pdf = ctx.open_pdf(f)
    enc = pdf.encryption if pdf.is_encrypted else None
    allow = pdf.allow
    meta = {}
    try:
        for k, v in (pdf.docinfo or {}).items():
            meta[str(k).lstrip("/")] = str(v)[:500]
    except (TypeError, ValueError):
        pass
    acro = pdf.Root.get("/AcroForm")
    attachments = list(pdf.attachments.keys())
    sizes = []
    for p in pdf.pages[:50]:
        mb = [float(x) for x in (inherited(p.obj, "/MediaBox") or [0, 0, 612, 792])]
        sizes.append([round(mb[2] - mb[0], 1), round(mb[3] - mb[1], 1)])
    ctx.result = {
        "pages": len(pdf.pages),
        "version": pdf.pdf_version,
        "encrypted": pdf.is_encrypted,
        "encryption": {"user_password": bool(ctx.password_for(0)) and pdf.is_encrypted,
                       "method": str(enc.stream_method).split(".")[-1], "bits": enc.bits, "R": enc.R} if enc else None,
        "permissions": {k: bool(getattr(allow, k)) for k in ("accessibility", "extract", "modify_annotation", "modify_assembly",
                                                              "modify_form", "modify_other", "print_lowres", "print_highres")},
        "metadata": meta,
        "has_forms": bool(acro and acro.get("/Fields")),
        "form_fields": len(acro.Fields) if acro and acro.get("/Fields") else 0,
        "xfa": bool(acro and "/XFA" in acro),
        "attachments": attachments,
        "javascript": "/JavaScript" in pdf.Root.get("/Names", {}) or "/OpenAction" in pdf.Root and "/JS" in str(pdf.Root.OpenAction)[:2000],
        "tagged": bool(pdf.Root.get("/MarkInfo", {}).get("/Marked", False)) if "/MarkInfo" in pdf.Root else False,
        "lang": str(pdf.Root.get("/Lang", "")),
        "page_sizes": sizes,
        "linearized": pdf.is_linearized,
    }


@op("merge")
def merge(ctx: Context) -> None:
    pdfs = ctx.pdf_inputs()
    if len(pdfs) < 2:
        raise UserError("need_two_pdfs")
    ranges = ctx.p("ranges") or []
    out = pikepdf.new()
    total = 0
    for n, f in enumerate(pdfs):
        src = ctx.open_pdf(f)
        spec = ranges[n] if n < len(ranges) else None
        idx = parse_pages(spec, len(src.pages))
        total += len(idx)
        if total > ctx.max_pages:
            raise UserError("too_many_pages", str(ctx.max_pages))
        _merge_acroform_resources(out, src)
        for i in idx:
            _materialize_inherited(src.pages[i])
            out.pages.append(src.pages[i])
        if ctx.p("bookmarks", True):
            with out.open_outline() as outline:
                outline.root.append(pikepdf.OutlineItem(f.stem, total - len(idx)))
        ctx.progress(100 * (n + 1) / len(pdfs))
    fix_acroform(out)
    out.docinfo["/Title"] = ctx.p("title") or pdfs[0].stem
    out.docinfo["/Producer"] = "PDFATY"
    ctx.save_pdf(out, (ctx.p("output_name") or "merged") + ".pdf")
    ctx.result = {"pages": len(out.pages)}


@op("split")
def split(ctx: Context) -> None:
    f = ctx.first_pdf()
    src = ctx.open_pdf(f)
    n = len(src.pages)
    mode = ctx.p("mode", "ranges")
    groups: list[list[int]] = []
    if mode == "each":
        groups = [[i] for i in range(n)]
    elif mode == "every":
        k = ctx.pint("every", 1, 1, n)
        groups = [list(range(i, min(i + k, n))) for i in range(0, n, k)]
    elif mode == "odd_even":
        groups = [list(range(0, n, 2)), list(range(1, n, 2))]
    else:
        spec = ctx.p("ranges") or ""
        parts = spec if isinstance(spec, list) else [s for s in str(spec).replace("؛", ";").split(";") if s.strip()]
        if not parts:
            raise UserError("bad_page_range")
        groups = [parse_pages(p, n) for p in parts]
    groups = [g for g in groups if g]
    if len(groups) > 1000:
        raise UserError("too_many_outputs")
    names = ctx.p("names") or []
    for gi, g in enumerate(groups):
        out = pikepdf.new()
        for i in g:
            _materialize_inherited(src.pages[i])
            out.pages.append(src.pages[i])
        fix_acroform(out)
        name = names[gi] if gi < len(names) and names[gi] else (
            f"{f.stem}_p{g[0] + 1}.pdf" if len(g) == 1 else f"{f.stem}_part{gi + 1}.pdf")
        if not name.lower().endswith(".pdf"):
            name += ".pdf"
        ctx.save_pdf(out, name)
        ctx.progress(100 * (gi + 1) / len(groups))
    from .convert import bundle

    bundle(ctx, f"{f.stem}_split.zip")
    ctx.result = {"files": len(groups)}


@op("organize")
def organize(ctx: Context) -> None:
    """params.pages: [{src: inputIndex, page: 0-based, rotate: deg}, {blank: true, w, h}, ...]"""
    items = ctx.p("pages")
    if not isinstance(items, list) or not items:
        raise UserError("no_pages")
    if len(items) > ctx.max_pages:
        raise UserError("too_many_pages", str(ctx.max_pages))
    pdf_inputs = ctx.pdf_inputs()
    base_f = pdf_inputs[0]
    base = ctx.open_pdf(base_f)
    sources: dict[int, pikepdf.Pdf] = {0: base}
    dup_sources: dict[int, list[pikepdf.Pdf]] = {}
    used: set[tuple[int, int]] = set()
    new_pages: list[pikepdf.Page] = []
    first_size = None
    if len(base.pages):
        g = base.pages[0].mediabox
        first_size = (float(g[2]) - float(g[0]), float(g[3]) - float(g[1]))
    for k, it in enumerate(items):
        if not isinstance(it, dict):
            raise UserError("bad_params", "pages")
        if it.get("blank"):
            w = float(it.get("w") or (first_size or PAPER["a4"])[0])
            h = float(it.get("h") or (first_size or PAPER["a4"])[1])
            pg = blank_page_obj(base, w, h)
        else:
            s = int(it.get("src", 0))
            pi = int(it.get("page", 0))
            if s < 0 or s >= len(pdf_inputs):
                raise UserError("bad_params", "src")
            if s not in sources:
                sources[s] = ctx.open_pdf(pdf_inputs[s])
                _merge_acroform_resources(base, sources[s])
            src = sources[s]
            if pi < 0 or pi >= len(src.pages):
                raise UserError("page_out_of_range", f"{pi + 1}")
            if s == 0 and (s, pi) not in used:
                pg = base.pages[pi]
                _materialize_inherited(pg)
            else:
                if (s, pi) in used:
                    # duplicates need an independent copy of the page and its annotations
                    copies = dup_sources.setdefault(s, [])
                    holder = open_pdf(pdf_inputs[s].path, ctx.password_for(ctx.inputs.index(pdf_inputs[s])))
                    copies.append(holder)
                    srcp = holder.pages[pi]
                else:
                    srcp = src.pages[pi]
                _materialize_inherited(srcp)
                pg = pikepdf.Page(base.copy_foreign(srcp.obj))
                if "/Parent" in pg.obj:
                    del pg.obj["/Parent"]
            used.add((s, pi))
        rot = int(it.get("rotate", 0) or 0)
        if rot % 90:
            raise UserError("bad_params", "rotate")
        if rot:
            cur = int(pg.obj.get("/Rotate", 0))
            pg.obj.Rotate = (cur + rot) % 360
        new_pages.append(pg)
        ctx.progress(80 * (k + 1) / len(items))
    del base.pages[:]
    for pg in new_pages:
        base.pages.append(pg)
    fix_acroform(base)
    ctx.save_pdf(base, (ctx.p("output_name") or base_f.stem) + ".pdf")
    ctx.result = {"pages": len(base.pages)}


@op("rotate")
def rotate(ctx: Context) -> None:
    pdf = ctx.open_pdf()
    angle = ctx.pint("angle", 90)
    if angle % 90:
        raise UserError("bad_params", "angle")
    for i in parse_pages(ctx.p("pages"), len(pdf.pages)):
        p = pdf.pages[i]
        cur = int(inherited(p.obj, "/Rotate") or 0)
        p.obj.Rotate = (cur + angle) % 360
    ctx.save_pdf(pdf, ctx.first_pdf().stem + ".pdf")


@op("delete_pages")
def delete_pages(ctx: Context) -> None:
    pdf = ctx.open_pdf()
    idx = sorted(parse_pages(ctx.p("pages"), len(pdf.pages), default_all=False), reverse=True)
    if not idx:
        raise UserError("bad_page_range")
    if len(idx) >= len(pdf.pages):
        raise UserError("cannot_delete_all_pages")
    for i in idx:
        del pdf.pages[i]
    fix_acroform(pdf)
    ctx.save_pdf(pdf, ctx.first_pdf().stem + ".pdf")
    ctx.result = {"pages": len(pdf.pages), "deleted": len(idx)}


@op("extract_pages")
def extract_pages(ctx: Context) -> None:
    f = ctx.first_pdf()
    src = ctx.open_pdf(f)
    idx = parse_pages(ctx.p("pages"), len(src.pages), default_all=False)
    if not idx:
        raise UserError("bad_page_range")
    if ctx.p("separate"):
        for i in idx:
            out = pikepdf.new()
            _materialize_inherited(src.pages[i])
            out.pages.append(src.pages[i])
            fix_acroform(out)
            ctx.save_pdf(out, f"{f.stem}_p{i + 1}.pdf")
        from .convert import bundle

        bundle(ctx, f"{f.stem}_pages.zip")
    else:
        out = pikepdf.new()
        _merge_acroform_resources(out, src)
        for i in idx:
            _materialize_inherited(src.pages[i])
            out.pages.append(src.pages[i])
        fix_acroform(out)
        ctx.save_pdf(out, (ctx.p("output_name") or f"{f.stem}_extract") + ".pdf")
    ctx.result = {"pages": len(idx)}


@op("insert_blank")
def insert_blank(ctx: Context) -> None:
    pdf = ctx.open_pdf()
    after = ctx.pint("after", len(pdf.pages), 0, len(pdf.pages))  # 0 = at start
    count = ctx.pint("count", 1, 1, 200)
    ref = pdf.pages[min(max(after - 1, 0), len(pdf.pages) - 1)].mediabox
    w, h = float(ref[2]) - float(ref[0]), float(ref[3]) - float(ref[1])
    if ctx.p("size") and ctx.p("size") != "same":
        w, h = paper_size(ctx.p("size"), ctx.p("orientation"))
    for k in range(count):
        pg = blank_page_obj(pdf, w, h)
        pdf.pages.insert(after + k, pg)
    ctx.save_pdf(pdf, ctx.first_pdf().stem + ".pdf")
    ctx.result = {"pages": len(pdf.pages)}


def page_ink_stats(path: str, password: str, max_pages: int, progress=None) -> list[dict]:
    doc = pdfium.PdfDocument(path, password=password or None)
    stats = []
    n = len(doc)
    for i in range(min(n, max_pages)):
        page = doc[i]
        tp = page.get_textpage()
        text = tp.get_text_range().strip()
        bmp = page.render(scale=0.35, grayscale=True, may_draw_forms=True, draw_annots=True)
        img = bmp.to_pil().convert("L")
        hist = img.histogram()
        total = sum(hist) or 1
        dark = sum(hist[:235])
        stats.append({"page": i, "ink": dark / total, "chars": len(text)})
        tp.close()
        page.close()
        if progress:
            progress(100 * (i + 1) / n)
    doc.close()
    return stats


@op("detect_blank")
def detect_blank(ctx: Context) -> None:
    f = ctx.first_pdf()
    threshold = ctx.pfloat("threshold", 0.003, 0.0, 0.2)
    stats = page_ink_stats(f.path, ctx.password_for(ctx.inputs.index(f)), ctx.max_pages, ctx.progress)
    blank = [s["page"] for s in stats if s["ink"] <= threshold and s["chars"] == 0]
    ctx.result = {"blank_pages": blank, "stats": [{"page": s["page"], "ink": round(s["ink"], 5), "chars": s["chars"]} for s in stats]}


@op("remove_blank")
def remove_blank(ctx: Context) -> None:
    f = ctx.first_pdf()
    threshold = ctx.pfloat("threshold", 0.003, 0.0, 0.2)
    stats = page_ink_stats(f.path, ctx.password_for(ctx.inputs.index(f)), ctx.max_pages, lambda p: ctx.progress(p * 0.8))
    blank = [s["page"] for s in stats if s["ink"] <= threshold and s["chars"] == 0]
    pdf = ctx.open_pdf(f)
    if len(blank) >= len(pdf.pages):
        raise UserError("cannot_delete_all_pages")
    for i in sorted(blank, reverse=True):
        del pdf.pages[i]
    fix_acroform(pdf)
    ctx.save_pdf(pdf, f.stem + ".pdf")
    ctx.result = {"removed": [b + 1 for b in blank], "pages": len(pdf.pages)}


@op("blank_pdf")
def blank_pdf(ctx: Context) -> None:
    w, h = paper_size(ctx.p("size", "a4"), ctx.p("orientation", "portrait"), ctx.p("width"), ctx.p("height"))
    count = ctx.pint("count", 1, 1, 500)
    pdf = pikepdf.new()
    for _ in range(count):
        pdf.pages.append(blank_page_obj(pdf, w, h))
    pdf.docinfo["/Title"] = ctx.p("title") or "Untitled"
    pdf.docinfo["/Producer"] = "PDFATY"
    ctx.save_pdf(pdf, (ctx.p("output_name") or "blank") + ".pdf")
