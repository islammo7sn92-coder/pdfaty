"""Advanced inspection (fonts, images, colours, print/archival indicators, accessibility)
and document-level editing (metadata, bookmarks, attachments, language/title)."""
from __future__ import annotations

import datetime as _dt
import math
import os

import pikepdf
from pikepdf import Array, Dictionary, Name, String

from .base import Context, UserError, op, safe_filename
from .compress import image_display_sizes
from .geom import inherited


def _walk_resources(pdf: pikepdf.Pdf):
    """Yield (page_index, resources) for pages and nested form XObjects."""
    for pi, page in enumerate(pdf.pages):
        stack = [inherited(page.obj, "/Resources")]
        seen = set()
        while stack:
            res = stack.pop()
            if res is None:
                continue
            try:
                key = res.objgen
            except AttributeError:
                key = id(res)
            if key in seen and key != (0, 0):
                continue
            seen.add(key)
            yield pi, res
            for _, xo in (res.get("/XObject") or {}).items():
                if xo.get("/Subtype") == Name.Form and "/Resources" in xo:
                    stack.append(xo.Resources)


def _cs_name(cs) -> str:
    if cs is None:
        return "-"
    if isinstance(cs, pikepdf.Name):
        return str(cs).lstrip("/")
    if isinstance(cs, pikepdf.Array) and len(cs):
        base = str(cs[0]).lstrip("/")
        if base == "ICCBased":
            try:
                return f"ICCBased(N={int(cs[1].get('/N', 0))})"
            except (AttributeError, TypeError):
                return "ICCBased"
        if base in ("Separation", "DeviceN"):
            return f"{base}({str(cs[1])[:40]})"
        return base
    return str(cs)[:40]


@op("inspect")
def inspect(ctx: Context) -> None:
    f = ctx.first_pdf()
    pdf = ctx.open_pdf(f)
    fonts: dict = {}
    images: dict = {}
    colorspaces: dict[str, int] = {}
    transparency = False
    overprint = False
    sizes = image_display_sizes(pdf)
    for pi, res in _walk_resources(pdf):
        for name, font in (res.get("/Font") or {}).items():
            key = font.objgen if font.objgen != (0, 0) else (pi, str(name))
            if key in fonts:
                fonts[key]["pages"].add(pi + 1)
                continue
            sub = str(font.get("/Subtype", "")).lstrip("/")
            base = str(font.get("/BaseFont", "")).lstrip("/")
            desc = font.get("/FontDescriptor")
            if sub == "Type0" and "/DescendantFonts" in font:
                desc = font.DescendantFonts[0].get("/FontDescriptor")
            embedded = bool(desc is not None and any(k in desc for k in ("/FontFile", "/FontFile2", "/FontFile3")))
            if sub == "Type3":
                embedded = True
            fonts[key] = {"name": base.split("+")[-1] or str(name), "type": sub, "embedded": embedded,
                          "subset": "+" in base[:8], "unicode": "/ToUnicode" in font, "pages": {pi + 1}}
        for _, xo in (res.get("/XObject") or {}).items():
            if xo.get("/Subtype") != Name.Image:
                continue
            key = xo.objgen
            w, h = int(xo.get("/Width", 0)), int(xo.get("/Height", 0))
            if key in images:
                images[key]["pages"].add(pi + 1)
                continue
            disp = sizes.get(key)
            dpi = round(max(w, h) / (disp / 72)) if disp else None
            filt = xo.get("/Filter")
            fl = ",".join(str(x).lstrip("/") for x in filt) if isinstance(filt, pikepdf.Array) else (str(filt).lstrip("/") if filt else "None")
            cs = _cs_name(xo.get("/ColorSpace")) if not xo.get("/ImageMask") else "Mask"
            images[key] = {"width": w, "height": h, "bpc": int(xo.get("/BitsPerComponent", 0) or 0), "colorspace": cs,
                           "filter": fl, "dpi": dpi, "has_alpha": "/SMask" in xo, "pages": {pi + 1}}
            colorspaces[cs] = colorspaces.get(cs, 0) + 1
            if "/SMask" in xo:
                transparency = True
        for _, cs in (res.get("/ColorSpace") or {}).items():
            n = _cs_name(cs)
            colorspaces[n] = colorspaces.get(n, 0) + 1
        for _, gs in (res.get("/ExtGState") or {}).items():
            try:
                if float(gs.get("/CA", 1)) < 1 or float(gs.get("/ca", 1)) < 1 or ("/SMask" in gs and gs.SMask != Name("/None")) \
                        or str(gs.get("/BM", "/Normal")) not in ("/Normal", "/Compatible"):
                    transparency = True
                if gs.get("/OP") or gs.get("/op"):
                    overprint = True
            except (TypeError, ValueError):
                pass
    for page in pdf.pages:
        if "/Group" in page.obj and page.obj.Group.get("/S") == Name.Transparency:
            transparency = True

    root = pdf.Root
    xmp = ""
    pdfa_claim = pdfx_claim = None
    try:
        meta = pdf.open_metadata(set_pikepdf_as_editor=False)
        part = meta.get("pdfaid:part")
        conf = meta.get("pdfaid:conformance")
        if part:
            pdfa_claim = f"PDF/A-{part}{(conf or '').lower()}"
        xmp = "yes" if "/Metadata" in root else "no"
    except Exception:  # noqa: BLE001
        xmp = "error"
    info = pdf.docinfo
    if "/GTS_PDFXVersion" in info:
        pdfx_claim = str(info.GTS_PDFXVersion)
    output_intents = [str(oi.get("/S", "")).lstrip("/") for oi in root.get("/OutputIntents", [])] if "/OutputIntents" in root else []
    marked = bool(root.get("/MarkInfo", {}).get("/Marked", False)) if "/MarkInfo" in root else False
    struct = "/StructTreeRoot" in root
    lang = str(root.get("/Lang", ""))
    title = str(info.get("/Title", "")) if info is not None else ""
    display_title = bool(root.get("/ViewerPreferences", {}).get("/DisplayDocTitle", False)) if "/ViewerPreferences" in root else False
    figures = figures_alt = 0
    headings = 0
    if struct:
        stack = [root.StructTreeRoot]
        visited = 0
        while stack and visited < 50000:
            node = stack.pop()
            visited += 1
            try:
                s = str(node.get("/S", ""))
            except AttributeError:
                continue
            if s == "/Figure":
                figures += 1
                if "/Alt" in node or "/ActualText" in node:
                    figures_alt += 1
            if s in ("/H", "/H1", "/H2", "/H3", "/H4", "/H5", "/H6"):
                headings += 1
            k = node.get("/K")
            if isinstance(k, pikepdf.Array):
                stack.extend([x for x in k if isinstance(x, pikepdf.Dictionary)])
            elif isinstance(k, pikepdf.Dictionary):
                stack.append(k)
    acro = root.get("/AcroForm")
    has_js = "/JavaScript" in (root.get("/Names") or {}) or "/OpenAction" in root and "/JS" in str(root.OpenAction)[:3000]
    has_embedded = "/EmbeddedFiles" in (root.get("/Names") or {})
    encrypted = pdf.is_encrypted
    unembedded = [x["name"] for x in fonts.values() if not x["embedded"]]
    low_res = [x for x in images.values() if x["dpi"] and x["dpi"] < 150 and x["width"] > 64]
    rgb_used = any(k.startswith(("DeviceRGB", "ICCBased(N=3)")) for k in colorspaces)
    device_cs = any(k in ("DeviceRGB", "DeviceCMYK", "DeviceGray") for k in colorspaces)
    trim = all("/TrimBox" in p.obj or "/ArtBox" in p.obj for p in pdf.pages)
    bleed = any("/BleedBox" in p.obj for p in pdf.pages)

    def chk(cid, ok, level="fail"):
        return {"id": cid, "status": "pass" if ok else level}

    pdfa = [
        chk("fonts_embedded", not unembedded), chk("not_encrypted", not encrypted), chk("no_javascript", not has_js),
        chk("xmp_metadata", xmp == "yes", "warn"), chk("pdfa_identification", bool(pdfa_claim), "warn"),
        chk("output_intent", bool(output_intents) or not device_cs, "warn"),
        chk("no_transparency_pdfa1", not transparency, "warn"), chk("no_embedded_files_pdfa2", not has_embedded, "warn"),
    ]
    pdfx = [
        chk("fonts_embedded", not unembedded), chk("not_encrypted", not encrypted),
        chk("output_intent", bool(output_intents), "warn"), chk("trimbox", trim, "warn"),
        chk("image_resolution", not low_res, "warn"), chk("cmyk_or_managed", not rgb_used, "warn"),
        chk("pdfx_identification", bool(pdfx_claim), "warn"),
    ]
    access = [
        chk("tagged", marked and struct), chk("language", bool(lang)), chk("title", bool(title), "warn"),
        chk("display_title", display_title, "warn"),
        chk("figures_alt", figures == figures_alt, "warn" if figures else "pass"),
        chk("headings", headings > 0 or not struct, "warn"), chk("text_unicode", all(x["unicode"] or x["type"] == "Type1" for x in fonts.values()), "warn"),
        chk("not_scanned", bool(fonts), "warn"),
    ]
    ctx.result = {
        "fonts": [{**v, "pages": sorted(v["pages"])[:20]} for v in fonts.values()][:500],
        "images": [{**v, "pages": sorted(v["pages"])[:20]} for v in images.values()][:500],
        "colorspaces": colorspaces, "transparency": transparency, "overprint": overprint,
        "pdf_version": pdf.pdf_version, "pages": len(pdf.pages),
        "claims": {"pdfa": pdfa_claim, "pdfx": pdfx_claim, "output_intents": output_intents},
        "structure": {"tagged": marked, "struct_tree": struct, "lang": lang, "title": title, "figures": figures,
                      "figures_with_alt": figures_alt, "headings": headings},
        "forms": {"acroform": acro is not None, "xfa": bool(acro is not None and "/XFA" in acro)},
        "javascript": has_js, "attachments": list(pdf.attachments.keys()), "encrypted": encrypted,
        "boxes": {"trim": trim, "bleed": bleed},
        "checks": {"pdfa": pdfa, "pdfx": pdfx, "accessibility": access},
        "disclaimer": "indicative_only",
    }


def _pdf_date(d: _dt.datetime | None = None) -> str:
    d = d or _dt.datetime.now(_dt.timezone.utc)
    return d.strftime("D:%Y%m%d%H%M%SZ")


@op("metadata_set")
def metadata_set(ctx: Context) -> None:
    f = ctx.first_pdf()
    pdf = ctx.open_pdf(f)
    fields = {"title": "/Title", "author": "/Author", "subject": "/Subject", "keywords": "/Keywords",
              "creator": "/Creator", "producer": "/Producer"}
    md = ctx.p("metadata") or {}
    with pdf.open_metadata(set_pikepdf_as_editor=False) as meta:
        for k, key in fields.items():
            if k not in md:
                continue
            v = str(md[k] or "")[:2000]
            if v:
                pdf.docinfo[key] = String(v)
            elif key in pdf.docinfo:
                del pdf.docinfo[key]
        meta.load_from_docinfo(pdf.docinfo)
    pdf.docinfo["/ModDate"] = String(_pdf_date())
    if md.get("lang") is not None:
        if md["lang"]:
            pdf.Root.Lang = String(str(md["lang"])[:20])
        elif "/Lang" in pdf.Root:
            del pdf.Root["/Lang"]
    if md.get("display_title"):
        if "/ViewerPreferences" not in pdf.Root:
            pdf.Root.ViewerPreferences = Dictionary()
        pdf.Root.ViewerPreferences.DisplayDocTitle = True
    ctx.save_pdf(pdf, f.stem + ".pdf")


@op("bookmarks_set")
def bookmarks_set(ctx: Context) -> None:
    """params.bookmarks: [{title, page (0-based), children: [...]}] replaces the outline."""
    f = ctx.first_pdf()
    pdf = ctx.open_pdf(f)
    items = ctx.p("bookmarks")
    if not isinstance(items, list):
        raise UserError("bad_params", "bookmarks")
    n = len(pdf.pages)

    def build(lst, depth=0):
        out = []
        for it in lst[:2000]:
            page = max(0, min(n - 1, int(it.get("page", 0))))
            oi = pikepdf.OutlineItem(str(it.get("title") or "-")[:300], page)
            if depth < 8:
                oi.children.extend(build(it.get("children") or [], depth + 1))
            out.append(oi)
        return out

    with pdf.open_outline() as outline:
        outline.root.clear()
        outline.root.extend(build(items))
    if items:
        pdf.Root.PageMode = Name.UseOutlines
    ctx.save_pdf(pdf, f.stem + ".pdf")


@op("bookmarks_get")
def bookmarks_get(ctx: Context) -> None:
    pdf = ctx.open_pdf()
    pages = {p.obj.objgen: i for i, p in enumerate(pdf.pages)}

    def conv(items, depth=0):
        out = []
        for oi in items:
            page = None
            try:
                dest = oi.destination
                if dest is None and oi.action is not None and "/D" in oi.action:
                    dest = oi.action.D
                if isinstance(dest, pikepdf.Array) and len(dest):
                    page = pages.get(dest[0].objgen)
                elif dest is not None:
                    names = pdf.Root.get("/Names")
                    if names is not None and "/Dests" in names:
                        tree = pikepdf.NameTree(names.Dests)
                        d = tree.get(str(dest))
                        if d is not None:
                            d = d.D if isinstance(d, pikepdf.Dictionary) else d
                            page = pages.get(d[0].objgen)
            except (AttributeError, KeyError, TypeError, ValueError):
                page = None
            out.append({"title": oi.title, "page": page, "children": conv(oi.children, depth + 1) if depth < 8 else []})
        return out

    with pdf.open_outline() as outline:
        ctx.result = {"bookmarks": conv(outline.root)}


@op("attachments_add")
def attachments_add(ctx: Context) -> None:
    f = ctx.first_pdf()
    pdf = ctx.open_pdf(f)
    added = []
    for inp in ctx.inputs:
        if inp is f:
            continue
        name = safe_filename(inp.name)
        with open(inp.path, "rb") as fh:
            data = fh.read()
        spec = pikepdf.AttachedFileSpec(pdf, data, filename=name, description=str(ctx.p("description") or ""))
        pdf.attachments[name] = spec
        added.append(name)
    if not added:
        raise UserError("no_files")
    ctx.save_pdf(pdf, f.stem + ".pdf")
    ctx.result = {"added": added}


@op("attachments_remove")
def attachments_remove(ctx: Context) -> None:
    f = ctx.first_pdf()
    pdf = ctx.open_pdf(f)
    names = ctx.p("names") or list(pdf.attachments.keys())
    removed = []
    for n in names:
        if n in pdf.attachments:
            del pdf.attachments[n]
            removed.append(n)
    ctx.save_pdf(pdf, f.stem + ".pdf")
    ctx.result = {"removed": removed}


@op("attachments_extract")
def attachments_extract(ctx: Context) -> None:
    from .convert import bundle

    f = ctx.first_pdf()
    pdf = ctx.open_pdf(f)
    if not pdf.attachments:
        raise UserError("no_attachments")
    for name, spec in pdf.attachments.items():
        data = spec.get_file().read_bytes()
        path = ctx.out_path(safe_filename(name))
        with open(path, "wb") as fh:
            fh.write(data)
        ctx.add_output(path, safe_filename(name))
    bundle(ctx, f.stem + "_attachments.zip")
