"""Text extraction with correct Arabic reading order.

PDFs normally store Arabic glyphs in *visual* order. Extractors apply bidi only per
text run, so whole lines often come out with reversed word order. Here every
character is collected with its box, lines are rebuilt geometrically (sorted by x =
visual order) and then converted to logical order with a small bidi pass that keeps
an index map, so each logical character still knows its box (needed for search,
redaction and comparison highlights)."""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

import pypdfium2 as pdfium
import pypdfium2.raw as pc

_AR = re.compile(r"[֐-ࣿיִ-﷿ﹰ-﻿]")


@dataclass
class Char:
    ch: str
    l: float
    t: float
    r: float
    b: float
    size: float = 10.0
    bold: bool = False
    obj: int = 0  # owning PDFium text object (pointer value), when requested


@dataclass
class Line:
    text: str
    l: float
    t: float
    r: float
    b: float
    size: float = 11
    bold: bool = False
    rtl: bool = False
    chars: list = field(default_factory=list)  # logical order, same length as text


def _is_rtl_char(c: str) -> bool:
    return bool(_AR.match(c))


def _is_ltr_char(c: str) -> bool:
    return c.isalpha() and not _is_rtl_char(c)


def geometries(path: str, password: str = "") -> list:
    """Visible-page geometry for every page (rotation + crop box aware)."""
    import pikepdf

    from .geom import geometry

    with pikepdf.open(path, password=password or "") as pdf:
        return [geometry(p) for p in pdf.pages]


def page_chars(page: pdfium.PdfPage, tp: pdfium.PdfTextPage, geo=None, with_obj: bool = False) -> list[Char]:
    """Characters with boxes in visible top-left coordinates (when `geo` is given) or in
    unrotated page coordinates with a top-left origin."""
    height = page.get_height()
    out: list[Char] = []
    n = tp.count_chars()
    last_size, last_bold, last_font_idx = 10.0, False, -100
    for i in range(n):
        code = pc.FPDFText_GetUnicode(tp.raw, i)
        if code in (0, 0xFFFE, 0xFFFF, 13, 10, 2):
            continue
        ch = chr(code)
        if pc.FPDFText_IsGenerated(tp.raw, i) == 1:
            continue
        l, b, r, t = tp.get_charbox(i, loose=True)
        if r - l <= 0 and ch != " ":
            continue
        if i - last_font_idx > 8:
            last_size = float(pc.FPDFText_GetFontSize(tp.raw, i) or last_size)
            last_bold = pc.FPDFText_GetFontWeight(tp.raw, i) >= 600
            last_font_idx = i
        ch = unicodedata.normalize("NFKC", ch) if "ﭐ" <= ch <= "﻿" else ch
        if geo is not None:
            x, y, w, h = geo.user_rect_to_tl(l, b, r, t)
            c = Char(ch, x, y, x + w, y + h, last_size, last_bold)
        else:
            c = Char(ch, l, height - t, r, height - b, last_size, last_bold)
        if with_obj:
            import ctypes

            c.obj = ctypes.cast(pc.FPDFText_GetTextObject(tp.raw, i), ctypes.c_void_p).value or 0
        out.append(c)
    return out


def _visual_to_logical(chars: list[Char], page_width: float | None = None) -> tuple[list[Char], bool]:
    """chars sorted left->right. Returns logical-order chars and line direction."""
    rtl_n = sum(1 for c in chars if _is_rtl_char(c.ch))
    ltr_n = sum(1 for c in chars if _is_ltr_char(c.ch))
    base_rtl = rtl_n > ltr_n
    # Base direction by majority of strong characters (the same rule poppler uses);
    # alignment is not reliable because RTL paragraphs may be left-aligned and vice versa.
    # classify into strong RTL (R), LTR-ish (L: latin + digits), neutral (N)
    cls = []
    for c in chars:
        if _is_rtl_char(c.ch):
            cls.append("R")
        elif _is_ltr_char(c.ch) or c.ch.isdigit():
            cls.append("L")
        else:
            cls.append("N")
    # numbers keep their separators: N between two L digits joins the L run
    for i in range(1, len(cls) - 1):
        if cls[i] == "N" and cls[i - 1] == "L" and cls[i + 1] == "L" and chars[i].ch in ".,:/-%٫٬":
            cls[i] = "L"
    # neutrals take the direction of their neighbours if both agree, else the base
    resolved = cls[:]
    for i, c in enumerate(cls):
        if c != "N":
            continue
        left = next((cls[j] for j in range(i - 1, -1, -1) if cls[j] != "N"), None)
        right = next((cls[j] for j in range(i + 1, len(cls)) if cls[j] != "N"), None)
        if left and left == right:
            resolved[i] = left
        else:
            resolved[i] = "R" if base_rtl else "L"
    runs: list[tuple[str, list[Char]]] = []
    for c, d in zip(chars, resolved):
        if runs and runs[-1][0] == d:
            runs[-1][1].append(c)
        else:
            runs.append((d, [c]))
    if base_rtl:
        out: list[Char] = []
        for d, rc in reversed(runs):
            out.extend(reversed(rc) if d == "R" else rc)
        return out, True
    out = []
    for d, rc in runs:
        out.extend(reversed(rc) if d == "R" else rc)
    return out, False


def build_lines(chars: list[Char], split_gap: float = 3.0, page_width: float | None = None) -> list[Line]:
    if not chars:
        return []
    items = sorted(chars, key=lambda c: ((c.t + c.b) / 2, c.l))
    rows: list[list[Char]] = []
    for c in items:
        cy = (c.t + c.b) / 2
        h = max(1.0, c.b - c.t)
        if rows:
            row = rows[-1]
            ry = sum((x.t + x.b) / 2 for x in row[-6:]) / len(row[-6:])
            rh = max(1.0, sum(x.b - x.t for x in row[-6:]) / len(row[-6:]))
            if abs(cy - ry) < 0.5 * max(h, rh):
                row.append(c)
                continue
        rows.append([c])
    lines: list[Line] = []
    for row in rows:
        row.sort(key=lambda c: (c.l + c.r) / 2)  # centre x: robust for ligature parts sharing a box edge
        # split far-apart segments (columns / table cells) into separate lines
        segs: list[list[Char]] = [[]]
        for c in row:
            if segs[-1]:
                prev = segs[-1][-1]
                if c.l - prev.r > split_gap * max(4.0, c.size, prev.size) * 0.6:
                    segs.append([])
            segs[-1].append(c)
        for seg in segs:
            if not any(c.ch != " " for c in seg):
                continue
            # keep real spaces (collapsed) and add spaces at clear visual gaps
            spaced: list[Char] = []
            # real space glyphs often carry unreliable boxes; word breaks are rebuilt from gaps
            max_r = 0.0
            for c in seg:
                if c.ch == " ":
                    continue
                if spaced and spaced[-1].ch != " ":
                    prev = spaced[-1]
                    gap = c.l - max_r
                    if gap > 0.12 * max(c.size, prev.size):
                        spaced.append(Char(" ", max_r, min(prev.t, c.t), c.l, max(prev.b, c.b), c.size))
                spaced.append(c)
                max_r = max(max_r, c.r) if len(spaced) > 1 else c.r
            while spaced and spaced[-1].ch == " ":
                spaced.pop()
            logical, rtl = _visual_to_logical(spaced, page_width)
            text = "".join(c.ch for c in logical)
            if not text.strip():
                continue
            sizes = sorted(c.size for c in seg)
            lines.append(Line(text, min(c.l for c in seg), min(c.t for c in seg), max(c.r for c in seg), max(c.b for c in seg),
                              sizes[len(sizes) // 2], sum(c.bold for c in seg) > len(seg) / 2, rtl, logical))
    return lines


def page_lines(page: pdfium.PdfPage, tp: pdfium.PdfTextPage | None = None, geo=None) -> list[Line]:
    own = tp is None
    tp = tp or page.get_textpage()
    try:
        return build_lines(page_chars(page, tp, geo), page_width=geo.vw if geo is not None else page.get_width())
    finally:
        if own:
            tp.close()


def lines_text(lines: list[Line]) -> str:
    """Plain text: lines on the same row are joined (right-to-left for RTL rows)."""
    out: list[str] = []
    rows: list[list[Line]] = []
    for ln in lines:
        if rows and abs(rows[-1][0].t - ln.t) < 0.5 * max(1, ln.b - ln.t):
            rows[-1].append(ln)
        else:
            rows.append([ln])
    for row in rows:
        rtl = sum(len(l.text) for l in row if l.rtl) > sum(len(l.text) for l in row if not l.rtl)
        row.sort(key=lambda l: -l.r if rtl else l.l)
        out.append("   ".join(l.text for l in row))
    return "\n".join(out)


def text_in_rect(chars: list[Char], l: float, t: float, r: float, b: float) -> str:
    inside = [c for c in chars if l <= (c.l + c.r) / 2 <= r and t <= (c.t + c.b) / 2 <= b]
    return " ".join(ln.text for ln in build_lines(inside, split_gap=50)).strip()


def page_tables(pdf_path: str, password: str, page_index: int, chars: list[Char]) -> list[dict]:
    """Detect ruled tables with pdfplumber; fill cell text from our ordered characters."""
    import pdfplumber

    out = []
    try:
        with pdfplumber.open(pdf_path, password=password or None, pages=[page_index + 1]) as doc:
            pg = doc.pages[0]
            good = []
            for strategy in (None, {"vertical_strategy": "lines", "horizontal_strategy": "lines", "snap_tolerance": 4}):
                tables = pg.find_tables(table_settings=strategy) if strategy else pg.find_tables()
                good = [t for t in tables if len(t.rows) >= 2 and max(len(r.cells) for r in t.rows) >= 2]
                if good:
                    break
            x_off, y_off = float(pg.bbox[0]), float(pg.bbox[1])
            for t in good:
                rows = []
                for row in t.rows:
                    cells = []
                    for cell in row.cells:
                        if cell is None:
                            cells.append("")
                            continue
                        x0, top, x1, bottom = cell
                        cells.append(text_in_rect(chars, x0 - x_off, top - y_off, x1 - x_off, bottom - y_off))
                    rows.append(cells)
                # RTL tables: pdfplumber lists cells left->right; logical order is right->left
                ar = sum(1 for r in rows for c in r if _AR.search(c or ""))
                if ar > sum(1 for r in rows for c in r if c) / 2:
                    rows = [list(reversed(r)) for r in rows]
                out.append({"bbox": [t.bbox[0] - x_off, t.bbox[1] - y_off, t.bbox[2] - x_off, t.bbox[3] - y_off],
                            "rows": rows, "rtl": ar > 0})
    except Exception:  # noqa: BLE001 – table detection is best effort
        return out
    return out


def find_spans(lines: list[Line], pattern: re.Pattern) -> list[tuple[str, list[list[float]]]]:
    """Regex search over logical line text; returns (match, [l,t,r,b] boxes merged per run)."""
    hits = []
    for ln in lines:
        for m in pattern.finditer(ln.text):
            if not m.group(0).strip():
                continue
            cs = [c for c in ln.chars[m.start():m.end()] if c.ch != " " or True]
            if not cs:
                continue
            # merge char boxes that are visually contiguous
            cs_vis = sorted(cs, key=lambda c: c.l)
            boxes: list[list[float]] = []
            for c in cs_vis:
                if boxes and c.l - boxes[-1][2] < max(2.0, 0.6 * c.size) and abs(c.t - boxes[-1][1]) < c.size:
                    bx = boxes[-1]
                    bx[0], bx[1], bx[2], bx[3] = min(bx[0], c.l), min(bx[1], c.t), max(bx[2], c.r), max(bx[3], c.b)
                else:
                    boxes.append([c.l, c.t, c.r, c.b])
            hits.append((m.group(0), boxes))
    return hits
