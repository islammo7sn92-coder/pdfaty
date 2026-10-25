"""Interactive forms (AcroForm): list, fill (with Arabic-capable appearances), create, flatten."""
from __future__ import annotations

import io
import re

import pikepdf
import pypdfium2 as pdfium
import pypdfium2.raw  # noqa: F401
from pikepdf import Array, Dictionary, Name, String

from .base import Context, UserError, op, parse_color
from .geom import geometry, new_canvas
from .text import draw_line, is_rtl, wrap_text


def _inh(field, key):
    node = field
    for _ in range(32):
        if key in node:
            return node[key]
        if "/Parent" not in node:
            return None
        node = node.Parent
    return None


def _full_name(field) -> str:
    parts = []
    node = field
    for _ in range(32):
        if "/T" in node:
            parts.append(str(node.T))
        if "/Parent" not in node:
            break
        node = node.Parent
    return ".".join(reversed(parts))


def _terminal_fields(pdf: pikepdf.Pdf):
    acro = pdf.Root.get("/AcroForm")
    if acro is None or "/Fields" not in acro:
        return []
    out = []
    stack = list(acro.Fields)
    seen = set()
    while stack:
        f = stack.pop(0)
        if f.objgen in seen:
            continue
        seen.add(f.objgen)
        kids = f.get("/Kids")
        if kids and any("/T" in k for k in kids):
            stack = [k for k in kids] + stack
            continue
        out.append(f)
    return out


def _widgets(field):
    kids = field.get("/Kids")
    if kids:
        return [k for k in kids]
    return [field]


def _page_index(pdf: pikepdf.Pdf) -> dict:
    return {p.obj.objgen: i for i, p in enumerate(pdf.pages)}


def _find_page(pdf, widget, pidx) -> int:
    if "/P" in widget and widget.P.objgen in pidx:
        return pidx[widget.P.objgen]
    for i, p in enumerate(pdf.pages):
        for a in p.obj.get("/Annots", []) or []:
            if a.objgen == widget.objgen:
                return i
    return -1


def _on_states(widget) -> list[str]:
    try:
        return [str(k).lstrip("/") for k in widget.AP.N.keys() if str(k) != "/Off"]
    except (AttributeError, KeyError):
        return []


def field_type(field) -> str:
    ft = str(_inh(field, "/FT") or "")
    ff = int(_inh(field, "/Ff") or 0)
    if ft == "/Btn":
        if ff & (1 << 16):
            return "button"
        if ff & (1 << 15):
            return "radio"
        return "checkbox"
    if ft == "/Tx":
        return "text"
    if ft == "/Ch":
        return "combo" if ff & (1 << 17) else "list"
    if ft == "/Sig":
        return "signature"
    return "unknown"


@op("forms_list")
def forms_list(ctx: Context) -> None:
    pdf = ctx.open_pdf()
    pidx = _page_index(pdf)
    fields = []
    for f in _terminal_fields(pdf):
        t = field_type(f)
        v = _inh(f, "/V")
        ff = int(_inh(f, "/Ff") or 0)
        entry = {
            "name": _full_name(f), "type": t, "value": str(v).lstrip("/") if v is not None else "",
            "readonly": bool(ff & 1), "required": bool(ff & 2), "multiline": t == "text" and bool(ff & (1 << 12)),
            "tooltip": str(f.get("/TU", "")), "widgets": [],
        }
        if t in ("combo", "list"):
            opts = []
            for o in _inh(f, "/Opt") or []:
                if isinstance(o, pikepdf.Array):
                    opts.append({"value": str(o[0]), "label": str(o[1])})
                else:
                    opts.append({"value": str(o), "label": str(o)})
            entry["options"] = opts
        if t in ("checkbox", "radio"):
            states = []
            for w in _widgets(f):
                for s in _on_states(w):
                    if s not in states:
                        states.append(s)
            entry["options"] = [{"value": s, "label": s} for s in states]
        for w in _widgets(f):
            pi = _find_page(pdf, w, pidx)
            if pi < 0 or "/Rect" not in w:
                continue
            r = [float(x) for x in w.Rect]
            g = geometry(pdf.pages[pi])
            entry["widgets"].append({"page": pi, "rect": [round(v, 2) for v in g.user_rect_to_tl(min(r[0], r[2]), min(r[1], r[3]), max(r[0], r[2]), max(r[1], r[3]))]})
        fields.append(entry)
    acro = pdf.Root.get("/AcroForm")
    ctx.result = {"fields": fields, "xfa": bool(acro is not None and "/XFA" in acro)}


def _parse_da(da: str) -> tuple[float, tuple[float, float, float]]:
    size = 0.0
    color = (0.0, 0.0, 0.0)
    m = re.search(r"([\d.]+)\s+Tf", da or "")
    if m:
        size = float(m.group(1))
    m = re.search(r"([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg", da or "")
    if m:
        color = tuple(float(x) for x in m.groups())  # type: ignore[assignment]
    else:
        m = re.search(r"([\d.]+)\s+g\b", da or "")
        if m:
            g = float(m.group(1))
            color = (g, g, g)
    return size, color


def text_appearance(pdf: pikepdf.Pdf, widget, value: str, da: str, q: int, multiline: bool, comb: int = 0) -> pikepdf.Stream:
    r = [float(x) for x in widget.Rect]
    w, h = abs(r[2] - r[0]), abs(r[3] - r[1])
    size, color = _parse_da(da)
    if size <= 0:
        size = max(6.0, min(12.0, h * 0.65)) if not multiline else 10.0
    c, buf = new_canvas(max(w, 1), max(h, 1))
    mk = widget.get("/MK")
    if mk is not None and "/BG" in mk and len(mk.BG) == 3:
        c.setFillColorRGB(*[float(x) for x in mk.BG])
        c.rect(0, 0, w, h, stroke=0, fill=1)
    c.setFillColorRGB(*color)
    pad = 2
    rtl = is_rtl(value)
    align = {0: "left", 1: "center", 2: "right"}.get(q, "left")
    if rtl and q == 0:
        align = "right"
    lines = wrap_text(value, w - 2 * pad, size) if multiline else [value.replace("\n", " ")]
    if multiline:
        y = h - pad - size
    else:
        y = (h - size) / 2 + size * 0.22
    for line in lines:
        x = pad if align == "left" else (w - pad if align == "right" else w / 2)
        draw_line(c, line, x, y, size, align=align, actual_text=False)
        y -= size * 1.2
        if y < -size:
            break
    c.showPage()
    c.save()
    buf.seek(0)
    src = pikepdf.open(buf)
    form = pdf.copy_foreign(src.pages[0].as_form_xobject())
    form.BBox = Array([0, 0, w, h])
    return form


def _set_checkbox(widget, on: bool, want: str | None = None) -> str | None:
    states = _on_states(widget)
    if not states:
        return None
    target = want if want in states else states[0]
    widget.AS = Name("/" + target) if on and target else Name.Off
    return target if on else None


@op("forms_fill")
def forms_fill(ctx: Context) -> None:
    f = ctx.first_pdf()
    pdf = ctx.open_pdf(f)
    values = ctx.p("values") or {}
    if not isinstance(values, dict):
        raise UserError("bad_params", "values")
    acro = pdf.Root.get("/AcroForm")
    if acro is None:
        raise UserError("no_form")
    if "/XFA" in acro and ctx.p("drop_xfa", True):
        # XFA data would override AcroForm values in some viewers; the AcroForm copy is kept.
        del acro["/XFA"]
    da_default = str(acro.get("/DA", "/Helv 0 Tf 0 g"))
    filled = 0
    for fld in _terminal_fields(pdf):
        name = _full_name(fld)
        if name not in values:
            continue
        val = values[name]
        t = field_type(fld)
        ff = int(_inh(fld, "/Ff") or 0)
        if ff & 1:
            continue  # read-only
        if t in ("text", "combo", "list"):
            sval = "" if val is None else str(val)[:5000]
            fld.V = String(sval)
            da = str(_inh(fld, "/DA") or da_default)
            q = int(_inh(fld, "/Q") or 0)
            for w in _widgets(fld):
                if "/Rect" not in w:
                    continue
                w.AP = Dictionary(N=text_appearance(pdf, w, sval, da, q, bool(ff & (1 << 12))))
            filled += 1
        elif t == "checkbox":
            on = val in (True, "true", "on", "On", "Yes", "yes", 1, "1") or (isinstance(val, str) and val not in ("", "Off", "false", "0"))
            chosen = None
            for w in _widgets(fld):
                chosen = _set_checkbox(w, on, val if isinstance(val, str) else None) or chosen
            fld.V = Name("/" + chosen) if chosen else Name.Off
            filled += 1
        elif t == "radio":
            chosen = str(val or "")
            for w in _widgets(fld):
                states = _on_states(w)
                w.AS = Name("/" + chosen) if chosen in states else Name.Off
            fld.V = Name("/" + chosen) if chosen else Name.Off
            filled += 1
    acro.NeedAppearances = False
    tmp = ctx.tmp("filled.pdf")
    pdf.save(tmp)
    if ctx.p("flatten"):
        tmp = _flatten_file(tmp, ctx.tmp("flat.pdf"))
    out = pikepdf.open(tmp)
    ctx.save_pdf(out, f.stem + "_filled.pdf")
    ctx.result = {"filled": filled}


def _flatten_file(src: str, dst: str, password: str = "") -> str:
    doc = pdfium.PdfDocument(src, password=password or None)
    doc.init_forms()
    for i in range(len(doc)):
        page = doc[i]
        pdfium.raw.FPDFPage_Flatten(page.raw, pdfium.raw.FLAT_NORMALDISPLAY)
        page.close()
    doc.save(dst)
    doc.close()
    with pikepdf.open(dst, allow_overwriting_input=True) as p:
        if "/AcroForm" in p.Root:
            del p.Root["/AcroForm"]
        p.save(dst)
    return dst


@op("flatten")
def flatten(ctx: Context) -> None:
    f = ctx.first_pdf()
    ctx.open_pdf(f)  # permission/password check
    out = _flatten_file(f.path, ctx.tmp("flat.pdf"), ctx.password_for(ctx.inputs.index(f)))
    ctx.save_pdf(pikepdf.open(out), f.stem + "_flattened.pdf")


def _ensure_acroform(pdf: pikepdf.Pdf):
    if "/AcroForm" not in pdf.Root:
        pdf.Root.AcroForm = pdf.make_indirect(Dictionary(Fields=Array()))
    acro = pdf.Root.AcroForm
    if "/Fields" not in acro:
        acro.Fields = Array()
    if "/DR" not in acro:
        acro.DR = Dictionary()
    if "/Font" not in acro.DR:
        acro.DR.Font = Dictionary()
    if "/Helv" not in acro.DR.Font:
        acro.DR.Font.Helv = pdf.make_indirect(Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica,
                                                         Encoding=Name.WinAnsiEncoding))
    if "/ZaDb" not in acro.DR.Font:
        acro.DR.Font.ZaDb = pdf.make_indirect(Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.ZapfDingbats))
    if "/DA" not in acro:
        acro.DA = String("/Helv 0 Tf 0 g")
    return acro


def _check_ap(pdf, w, h, on: bool, radio: bool) -> pikepdf.Stream:
    ops = ["1 1 1 rg", f"0 0 {w} {h} re f" if not radio else "", "0.3 0.3 0.3 RG 1 w"]
    if radio:
        r = min(w, h) / 2 - 1
        cx, cy = w / 2, h / 2
        k = 0.5523 * r
        circle = (f"{cx + r} {cy} m {cx + r} {cy + k} {cx + k} {cy + r} {cx} {cy + r} c "
                  f"{cx - k} {cy + r} {cx - r} {cy + k} {cx - r} {cy} c {cx - r} {cy - k} {cx - k} {cy - r} {cx} {cy - r} c "
                  f"{cx + k} {cy - r} {cx + r} {cy - k} {cx + r} {cy} c")
        ops.append(circle + " S")
        if on:
            r2 = r * 0.5
            k2 = 0.5523 * r2
            ops.append("0 g " + (f"{cx + r2} {cy} m {cx + r2} {cy + k2} {cx + k2} {cy + r2} {cx} {cy + r2} c "
                                 f"{cx - k2} {cy + r2} {cx - r2} {cy + k2} {cx - r2} {cy} c {cx - r2} {cy - k2} {cx - k2} {cy - r2} {cx} {cy - r2} c "
                                 f"{cx + k2} {cy - r2} {cx + r2} {cy - k2} {cx + r2} {cy} c f"))
    else:
        ops.append(f"0.5 0.5 {w - 1} {h - 1} re S")
        if on:
            ops.append(f"0 G {max(1, min(w, h) / 9):.2f} w 1 J 1 j {w * 0.22:.2f} {h * 0.52:.2f} m {w * 0.42:.2f} {h * 0.28:.2f} l "
                       f"{w * 0.8:.2f} {h * 0.76:.2f} l S")
    st = pdf.make_stream("\n".join(o for o in ops if o).encode())
    st.Type, st.Subtype = Name.XObject, Name.Form
    st.BBox = Array([0, 0, w, h])
    return st


@op("forms_create")
def forms_create(ctx: Context) -> None:
    f = ctx.first_pdf()
    pdf = ctx.open_pdf(f)
    specs = ctx.p("fields") or []
    if not specs:
        raise UserError("no_items")
    acro = _ensure_acroform(pdf)
    existing = {_full_name(x) for x in _terminal_fields(pdf)}
    radio_groups: dict[str, pikepdf.Object] = {}
    created = 0
    for s in specs:
        t = s.get("type", "text")
        name = re.sub(r"[.\s]+", "_", str(s.get("name") or f"field{created + 1}"))[:100]
        pi = int(s.get("page", 0))
        if pi < 0 or pi >= len(pdf.pages):
            raise UserError("page_out_of_range")
        page = pdf.pages[pi]
        g = geometry(page)
        rect = g.rect_tl_to_user(float(s["x"]), float(s["y"]), float(s["w"]), float(s["h"]))
        w, h = rect[2] - rect[0], rect[3] - rect[1]
        if g.rot in (90, 270):
            w, h = h, w
        if t != "radio":
            base = name
            n = 2
            while name in existing:
                name = f"{base}_{n}"
                n += 1
            existing.add(name)
        border = parse_color(s.get("border"), (0.2, 0.35, 0.7))
        mk = Dictionary(BC=Array(list(border)), BG=Array([1, 1, 1]))
        if g.rot:
            mk.R = g.rot
        widget = Dictionary(Type=Name.Annot, Subtype=Name.Widget, Rect=Array(rect), F=4, P=page.obj, MK=mk,
                            Border=Array([0, 0, 1]))
        if s.get("tooltip"):
            widget.TU = String(str(s["tooltip"]))
        ff = 2 if s.get("required") else 0
        size = float(s.get("font_size", 0) or 0)
        if t in ("text", "date"):
            widget.FT = Name.Tx
            widget.T = String(name)
            widget.DA = String(f"/Helv {size:g} Tf 0 g")
            if s.get("multiline"):
                ff |= 1 << 12
            if t == "date":
                widget.TU = String(str(s.get("tooltip") or "DD/MM/YYYY"))
            val = str(s.get("value") or "")
            widget.V = String(val)
            widget.AP = Dictionary(N=text_appearance(pdf, widget, val, f"/Helv {size:g} Tf 0 g", 0, bool(ff & (1 << 12))))
        elif t == "checkbox":
            widget.FT = Name.Btn
            widget.T = String(name)
            on = bool(s.get("value"))
            widget.V = Name.Yes if on else Name.Off
            widget.AS = Name.Yes if on else Name.Off
            widget.MK.CA = String("4")
            widget.DA = String("/ZaDb 0 Tf 0 g")
            widget.AP = Dictionary(N=Dictionary(Yes=_check_ap(pdf, w, h, True, False), Off=_check_ap(pdf, w, h, False, False)))
        elif t == "radio":
            group = radio_groups.get(name)
            if group is None:
                group = pdf.make_indirect(Dictionary(FT=Name.Btn, T=String(name), Ff=(1 << 15) | (1 << 14) | ff,
                                                     Kids=Array(), V=Name.Off))
                radio_groups[name] = group
                acro.Fields.append(group)
            export = re.sub(r"[^\w]+", "_", str(s.get("export") or f"opt{len(group.Kids) + 1}"))
            widget.Parent = group
            widget.AS = Name.Off
            widget.MK.CA = String("l")
            widget.DA = String("/ZaDb 0 Tf 0 g")
            widget.AP = Dictionary(N=Dictionary({"/" + export: _check_ap(pdf, w, h, True, True), "/Off": _check_ap(pdf, w, h, False, True)}))
            if s.get("value"):
                group.V = Name("/" + export)
                widget.AS = Name("/" + export)
            wobj = pdf.make_indirect(widget)
            group.Kids.append(wobj)
            if "/Annots" not in page.obj:
                page.obj.Annots = Array()
            page.obj.Annots.append(wobj)
            created += 1
            continue
        elif t in ("dropdown", "list"):
            widget.FT = Name.Ch
            widget.T = String(name)
            if t == "dropdown":
                ff |= 1 << 17
            opts = [str(o) for o in (s.get("options") or [])][:500]
            if not opts:
                raise UserError("options_required")
            widget.Opt = Array([String(o) for o in opts])
            val = str(s.get("value") or opts[0])
            widget.V = String(val)
            widget.DA = String(f"/Helv {size:g} Tf 0 g")
            widget.AP = Dictionary(N=text_appearance(pdf, widget, val, f"/Helv {size:g} Tf 0 g", 0, False))
        elif t == "signature":
            widget.FT = Name.Sig
            widget.T = String(name)
        else:
            raise UserError("bad_params", "type")
        if ff:
            widget.Ff = ff
        wobj = pdf.make_indirect(widget)
        acro.Fields.append(wobj)
        if "/Annots" not in page.obj:
            page.obj.Annots = Array()
        page.obj.Annots.append(wobj)
        created += 1
    if any(s.get("type") == "signature" for s in specs):
        acro.SigFlags = 1
    ctx.save_pdf(pdf, f.stem + "_form.pdf")
    ctx.result = {"created": created}
