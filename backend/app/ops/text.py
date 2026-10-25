"""Text drawing with Arabic shaping + bidi and per-script font fallback (reportlab).

Visible text is drawn with shaped (presentation-form) glyphs, wrapped in an
/ActualText marked-content span carrying the logical Unicode string so that
copy/search in viewers returns the real text instead of presentation forms."""
from __future__ import annotations

import os
import re
from functools import lru_cache

import arabic_reshaper
from bidi.algorithm import get_display
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

FONT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "fonts")

# family -> (latin regular, latin bold, arabic regular, arabic bold)
FAMILIES = {
    "sans": ("NotoSans-Regular", "NotoSans-Bold", "NotoSansArabic-Regular", "NotoSansArabic-Bold"),
    "serif": ("NotoSerif-Regular", "NotoSerif-Bold", "NotoNaskhArabic-Regular", "NotoNaskhArabic-Bold"),
    "naskh": ("NotoSerif-Regular", "NotoSerif-Bold", "NotoNaskhArabic-Regular", "NotoNaskhArabic-Bold"),
    "mono": ("DejaVuSansMono", "DejaVuSansMono", "NotoSansArabic-Regular", "NotoSansArabic-Bold"),
}

_ARABIC_RE = re.compile(r"[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]")
_reshaper = arabic_reshaper.ArabicReshaper(configuration={"delete_harakat": False, "support_ligatures": True})


@lru_cache(maxsize=None)
def ensure_font(name: str) -> str:
    if name not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont(name, os.path.join(FONT_DIR, name + ".ttf")))
    return name


def family_fonts(family: str, bold: bool = False) -> tuple[str, str]:
    fam = FAMILIES.get((family or "sans").lower(), FAMILIES["sans"])
    latin = fam[1] if bold else fam[0]
    arabic = fam[3] if bold else fam[2]
    return ensure_font(latin), ensure_font(arabic)


def has_arabic(text: str) -> bool:
    return bool(_ARABIC_RE.search(text or ""))


def is_rtl(text: str) -> bool:
    """Paragraph direction from the first strong character."""
    for ch in text:
        if _ARABIC_RE.match(ch) or "֐" <= ch <= "׿":
            return True
        if ch.isalpha():
            return False
    return False


def visual_runs(text: str, family: str = "sans", bold: bool = False, rtl: bool | None = None) -> list[tuple[str, str]]:
    """Return [(visual_text, font_name)] left-to-right."""
    latin, arabic = family_fonts(family, bold)
    if not text:
        return []
    if rtl is None:
        rtl = is_rtl(text)
    shaped = _reshaper.reshape(text) if has_arabic(text) else text
    visual = get_display(shaped, base_dir="R" if rtl else "L")
    runs: list[tuple[str, str]] = []
    cur, cur_font = "", None
    for ch in visual:
        if _ARABIC_RE.match(ch):
            f = arabic
        elif ch.isspace() or not ch.isprintable():
            f = cur_font or (arabic if rtl else latin)
        else:
            f = latin
        if f != cur_font and cur:
            runs.append((cur, cur_font))  # type: ignore[arg-type]
            cur = ""
        cur_font = f
        cur += ch
    if cur:
        runs.append((cur, cur_font))  # type: ignore[arg-type]
    return runs


def text_width(text: str, size: float, family: str = "sans", bold: bool = False) -> float:
    return sum(pdfmetrics.stringWidth(t, f, size) for t, f in visual_runs(text, family, bold))


def _utf16_hex(s: str) -> str:
    return "FEFF" + s.encode("utf-16-be").hex().upper()


def draw_line(c, text: str, x: float, y: float, size: float, family: str = "sans", bold: bool = False,
              align: str = "left", actual_text: bool = True, rtl: bool | None = None) -> float:
    """Draw one line with its baseline at y. `x` is the left, center or right anchor per `align`.
    Returns the drawn width."""
    runs = visual_runs(text, family, bold, rtl)
    width = sum(pdfmetrics.stringWidth(t, f, size) for t, f in runs)
    if align == "center":
        x -= width / 2
    elif align == "right":
        x -= width
    if actual_text and runs:
        c._code.append(f"/Span <</ActualText <{_utf16_hex(text)}>>> BDC")
    for t, f in runs:
        c.setFont(f, size)
        c.drawString(x, y, t)
        x += pdfmetrics.stringWidth(t, f, size)
    if actual_text and runs:
        c._code.append("EMC")
    return width


def wrap_text(text: str, max_width: float, size: float, family: str = "sans", bold: bool = False) -> list[str]:
    lines: list[str] = []
    for para in (text or "").replace("\r\n", "\n").split("\n"):
        words = para.split(" ")
        cur = ""
        for w in words:
            trial = (cur + " " + w) if cur else w
            if max_width <= 0 or text_width(trial, size, family, bold) <= max_width or not cur:
                cur = trial
            else:
                lines.append(cur)
                cur = w
        lines.append(cur)
    return lines


def to_arabic_digits(s: str) -> str:
    return s.translate(str.maketrans("0123456789", "٠١٢٣٤٥٦٧٨٩"))
