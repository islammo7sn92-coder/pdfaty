"""Watermark / background analysis and removal.

The analyser classifies what it finds:
  * separate objects (marked /Artifact blocks, optional-content layers, watermark
    annotations, repeated XObjects, repeated rotated text, full-page fills/images)
    -> removable, only the selected object is deleted;
  * content baked into a scanned page image -> reported as NOT removable.
"""
from __future__ import annotations

import hashlib
from collections import defaultdict

import pikepdf
from pikepdf import Name

from .base import Context, UserError, op
from .geom import geometry

WM_WORDS = ("watermark", "water mark", "علامة", "draft", "confidential", "copy", "sample")
BG_WORDS = ("background", "خلفية")
PAINT_OPS = {"f", "F", "f*", "B", "B*", "b", "b*", "S", "s", "Tj", "TJ", "'", '"', "Do", "sh", "BI"}


def _op(ins) -> str:
    try:
        return str(ins.operator)
    except AttributeError:
        return "BI"


def _resolve_props(page, operand):
    if isinstance(operand, pikepdf.Dictionary):
        return operand
    if isinstance(operand, pikepdf.Name):
        try:
            return page.obj.Resources.Properties[operand]
        except (AttributeError, KeyError, TypeError):
            return None
    return None


def _ocg_name(ocg) -> str:
    try:
        return str(ocg.get("/Name", ""))
    except (AttributeError, TypeError):
        return ""


def _classify_words(name: str) -> str | None:
    low = name.lower()
    if any(w in low for w in BG_WORDS):
        return "background"
    if any(w in low for w in WM_WORDS):
        return "watermark"
    return None


def _xobjects(page):
    try:
        return page.obj.Resources.XObject
    except (AttributeError, KeyError):
        return {}


def _text_of_block(instrs, a: int, b: int) -> bytes:
    out = b""
    for ins in instrs[a:b + 1]:
        if _op(ins) in ("Tj", "'", '"'):
            for o in ins.operands:
                if isinstance(o, pikepdf.String):
                    out += bytes(o)
        elif _op(ins) == "TJ":
            for o in ins.operands[0]:
                if isinstance(o, pikepdf.String):
                    out += bytes(o)
    return out


def _readable(b: bytes) -> str:
    try:
        s = b.decode("utf-16-be") if b.startswith(b"\xfe\xff") else b.decode("latin-1")
    except UnicodeDecodeError:
        s = ""
    s = "".join(ch if ch.isprintable() else "" for ch in s)
    return s[:60]


def analyse_page(page, pi: int) -> list[dict]:
    """Return raw candidate occurrences on one page: {id, kind, source, ranges:[(a,b)], ...}."""
    try:
        instrs = pikepdf.parse_content_stream(page)
    except pikepdf.PdfError:
        return []
    found: list[dict] = []
    # independent tracker of filled vector shapes by fill colour: catches watermarks that
    # were converted to outlines ("Microsoft Print to PDF", design tools, scanners' software)
    fill = (0.0, 0.0, 0.0)
    fill_stack: list[tuple] = []
    cpath = None
    color_fills: dict[tuple, list[tuple[int, int]]] = {}
    stack: list[tuple[int, str, object]] = []
    rot_stack: list[bool] = []
    ctm_rotated = False
    bt_start = None
    bt_rotated = False
    has_text = False
    do_count = 0
    first_paint_seen = False
    path_start = None
    g = geometry(page)
    page_area = g.w * g.h
    xobjs = _xobjects(page)
    for k, ins in enumerate(instrs):
        o = _op(ins)
        try:
            if o == "q":
                fill_stack.append(fill)
            elif o == "Q":
                fill = fill_stack.pop() if fill_stack else (0.0, 0.0, 0.0)
            elif o in ("rg", "sc", "scn") and len(ins.operands) == 3:
                fill = tuple(round(float(v), 3) for v in ins.operands)
            elif o in ("g",) or (o in ("sc", "scn") and len(ins.operands) == 1 and not isinstance(ins.operands[0], pikepdf.Name)):
                v = round(float(ins.operands[0]), 3)
                fill = (v, v, v)
            elif o == "k" or (o in ("sc", "scn") and len(ins.operands) == 4):
                c_, m_, y_, k_ = (float(v) for v in ins.operands)
                fill = tuple(round((1 - min(1, x + k_)), 3) for x in (c_, m_, y_))
        except (ValueError, TypeError):
            pass
        if o in ("m", "re") and cpath is None:
            cpath = k
        elif o in ("f", "F", "f*") and cpath is not None:
            color_fills.setdefault(fill, []).append((cpath, k))
            cpath = None
        elif o in ("n", "S", "s", "B", "B*", "b", "b*"):
            cpath = None
        if o in ("BDC", "BMC"):
            tag = str(ins.operands[0]) if ins.operands else ""
            props = _resolve_props(page, ins.operands[1]) if o == "BDC" and len(ins.operands) > 1 else None
            stack.append((k, tag, props))
        elif o == "EMC" and stack:
            a, tag, props = stack.pop()
            if props is None:
                continue
            if tag == "/Artifact":
                sub = str(props.get("/Subtype", ""))
                typ = str(props.get("/Type", ""))
                mark = str(props.get("/PDFATY", "")) if "/PDFATY" in props else ""
                if mark:
                    kind = "background" if "Background" in mark else ("header" if "Header" in mark else "watermark")
                    found.append({"id": f"mc:{mark}", "kind": kind, "source": "pdfaty", "ranges": [(a, k)], "label": mark})
                elif sub == "/Watermark" or typ == "/Background" or sub == "/Background":
                    kind = "background" if "Background" in sub + typ else "watermark"
                    found.append({"id": f"mc:artifact-{kind}", "kind": kind, "source": "artifact", "ranges": [(a, k)],
                                  "label": f"Artifact {sub or typ}"})
            elif tag == "/OC":
                ocg = props
                name = _ocg_name(ocg)
                kind = _classify_words(name)
                if kind:
                    found.append({"id": f"ocg:{ocg.objgen[0]}_{ocg.objgen[1]}", "kind": kind, "source": "layer",
                                  "ranges": [(a, k)], "label": name})
        elif o == "q":
            rot_stack.append(ctm_rotated)
        elif o == "Q":
            ctm_rotated = rot_stack.pop() if rot_stack else False
        elif o == "cm":
            try:
                if abs(float(ins.operands[1])) > 1e-3 or abs(float(ins.operands[2])) > 1e-3:
                    ctm_rotated = True
            except (ValueError, TypeError, IndexError):
                pass
        elif o == "BT":
            bt_start, bt_rotated = k, ctm_rotated
        elif o == "Tm" and bt_start is not None:
            try:
                bmat, cmat = float(ins.operands[1]), float(ins.operands[2])
                if abs(bmat) > 1e-3 or abs(cmat) > 1e-3:
                    bt_rotated = True
            except (ValueError, TypeError, IndexError):
                pass
        elif o == "ET" and bt_start is not None:
            raw = _text_of_block(instrs, bt_start, k)
            if raw.strip():
                has_text = True
                if bt_rotated:
                    h = hashlib.sha1(raw, usedforsecurity=False).hexdigest()[:12]
                    found.append({"id": f"text:{h}", "kind": "watermark", "source": "text", "ranges": [(bt_start, k)],
                                  "label": _readable(raw)})
            bt_start = None
        elif o in ("re", "m") and path_start is None:
            path_start = k
        elif o in ("f", "F", "f*") and path_start is not None and not first_paint_seen:
            first_paint_seen = True
            ins_re = instrs[path_start]
            if _op(ins_re) == "re" and k - path_start <= 2:
                try:
                    w, h = abs(float(ins_re.operands[2])), abs(float(ins_re.operands[3]))
                    if w * h >= 0.9 * page_area:
                        found.append({"id": "fill:first", "kind": "background", "source": "fill",
                                      "ranges": [(path_start, k)], "label": "Full-page colour fill", "_pending": True})
                except (ValueError, TypeError, IndexError):
                    pass
            path_start = None
        elif o in ("n", "S", "s", "B", "B*", "b", "b*", "W", "W*"):
            if o != "W" and o != "W*":
                path_start = None
                first_paint_seen = first_paint_seen or o != "n"
        elif o == "Do":
            do_count += 1
            name = ins.operands[0]
            xo = xobjs.get(name) if hasattr(xobjs, "get") else None
            if xo is None:
                continue
            first = not first_paint_seen
            first_paint_seen = True
            oc = xo.get("/OC")
            if oc is not None and _classify_words(_ocg_name(oc)):
                found.append({"id": f"ocg:{oc.objgen[0]}_{oc.objgen[1]}", "kind": _classify_words(_ocg_name(oc)),
                              "source": "layer", "ranges": [(k, k)], "label": _ocg_name(oc)})
                continue
            sub = str(xo.get("/Subtype", ""))
            entry = {"id": f"xobj:{xo.objgen[0]}_{xo.objgen[1]}", "kind": "watermark", "source": "xobject",
                     "ranges": [(k, k)], "label": f"{'Image' if sub == '/Image' else 'Form'} object",
                     "subtype": sub, "first": first}
            if sub == "/Image":
                entry["size"] = [int(xo.get("/Width", 0)), int(xo.get("/Height", 0))]
            found.append(entry)
    for color, ranges in color_fills.items():
        if max(color) < 0.25 or min(color) > 0.97 or len(ranges) < 8:
            continue  # black body text / white fills / a few isolated shapes
        hexc = "#%02x%02x%02x" % tuple(int(round(v * 255)) for v in color)
        found.append({"id": f"color:{hexc[1:]}", "kind": "watermark", "source": "color", "ranges": ranges,
                      "label": f"{hexc} × {len(ranges)}", "color": hexc})
    # Post-process page-level facts
    for f in found:
        f["page"] = pi
        if f.get("_pending"):
            # a full-page fill is only a "background" when other content follows it
            f.pop("_pending")
            if not has_text and do_count == 0:
                f["drop"] = True
        if f["source"] == "xobject" and f.get("subtype") == "/Image" and f.get("first"):
            if has_text:
                f["kind"] = "background"
                f["label"] = "Full-page image behind content"
            elif do_count == 1:
                f["scan"] = True  # page is just one image (scan) – not separable
    return [f for f in found if not f.get("drop")]


def analyse(pdf: pikepdf.Pdf, max_pages: int = 500, progress=None) -> dict:
    n = len(pdf.pages)
    occ: dict[str, dict] = {}
    scanned_pages = 0
    for pi in range(min(n, max_pages)):
        page = pdf.pages[pi]
        for f in analyse_page(page, pi):
            if f.get("scan"):
                scanned_pages += 1
                continue
            c = occ.setdefault(f["id"], {"id": f["id"], "kind": f["kind"], "source": f["source"], "label": f["label"],
                                         "pages": [], "count": 0, "color": f.get("color")})
            if pi not in c["pages"]:
                c["pages"].append(pi)
            c["count"] += 1
        for annot in page.obj.get("/Annots", []) or []:
            try:
                if annot.get("/Subtype") == Name("/Watermark"):
                    c = occ.setdefault("annot:watermark", {"id": "annot:watermark", "kind": "watermark", "source": "annotation",
                                                           "label": "Watermark annotation", "pages": [], "count": 0})
                    if pi not in c["pages"]:
                        c["pages"].append(pi)
                    c["count"] += 1
            except (AttributeError, TypeError):
                pass
        if progress:
            progress(100 * (pi + 1) / n)
    total = min(n, max_pages)
    cands = []
    for c in occ.values():
        if c["source"] in ("xobject", "text", "color"):
            # only objects repeated on many pages look like a watermark
            if total >= 2 and len(c["pages"]) < max(2, int(total * 0.5)):
                continue
            if total == 1 and c["source"] == "xobject" and c["kind"] != "background":
                continue
        c["removable"] = True
        c["page_count"] = len(c["pages"])
        c["pages"] = c["pages"][:50]
        cands.append(c)
    order = {"pdfaty": 0, "artifact": 1, "layer": 2, "annotation": 3, "text": 4, "color": 5, "fill": 6, "xobject": 7}
    cands.sort(key=lambda c: (order.get(c["source"], 9), -c["page_count"]))
    return {"candidates": cands, "scanned_pages": scanned_pages, "pages": n}


@op("watermark_analyze")
def watermark_analyze(ctx: Context) -> None:
    pdf = ctx.open_pdf()
    ctx.result = analyse(pdf, progress=ctx.progress)


def remove_candidates(pdf: pikepdf.Pdf, ids: set[str]) -> dict:
    removed = defaultdict(int)
    for pi, page in enumerate(pdf.pages):
        found = [f for f in analyse_page(page, pi) if f["id"] in ids and not f.get("scan")]
        if found:
            instrs = pikepdf.parse_content_stream(page)
            kill: set[int] = set()
            for f in found:
                for a, b in f["ranges"]:
                    kill.update(range(a, b + 1))
                removed[f["id"]] += 1
            # keep q/Q balanced: never delete unmatched graphics-state operators
            kept = []
            for k, ins in enumerate(instrs):
                if k in kill and _op(ins) not in ("q", "Q"):
                    continue
                kept.append(ins)
            # remove q ... Q pairs that became empty
            page.obj.Contents = pdf.make_stream(pikepdf.unparse_content_stream(kept))
        if "annot:watermark" in ids and "/Annots" in page.obj:
            keep = [a for a in page.obj.Annots if a.get("/Subtype") != Name("/Watermark")]
            n_removed = len(page.obj.Annots) - len(keep)
            if n_removed:
                page.obj.Annots = pikepdf.Array(keep)
                removed["annot:watermark"] += n_removed
    return dict(removed)


@op("watermark_remove")
def watermark_remove(ctx: Context) -> None:
    f = ctx.first_pdf()
    pdf = ctx.open_pdf(f)
    ids = ctx.p("ids")
    kinds = ctx.p("kinds")  # e.g. ["watermark"] or ["background"] for automatic mode
    if not ids:
        info = analyse(pdf)
        auto_sources = {"pdfaty", "artifact", "layer", "annotation"}
        ids = [c["id"] for c in info["candidates"]
               if (not kinds or c["kind"] in kinds) and (c["source"] in auto_sources or ctx.p("aggressive"))]
        if not ids:
            raise UserError("nothing_to_remove", "embedded" if info["scanned_pages"] else None)
    preview = ctx.p("preview_page")
    if preview is not None:
        pi = int(preview)
        if pi < 0 or pi >= len(pdf.pages):
            raise UserError("page_out_of_range")
        for k in range(len(pdf.pages) - 1, -1, -1):
            if k != pi:
                del pdf.pages[k]
    removed = remove_candidates(pdf, set(map(str, ids)))
    if not removed and preview is None:
        raise UserError("nothing_to_remove")
    ctx.save_pdf(pdf, ("preview" if preview is not None else f.stem) + ".pdf")
    ctx.result = {"removed": removed}


@op("background_remove")
def background_remove(ctx: Context) -> None:
    ctx.params.setdefault("kinds", ["background"])
    watermark_remove(ctx)
