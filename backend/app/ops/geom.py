"""Page geometry and content stamping.

Client coordinates are *visible* page points with a top-left origin, i.e. the
page as shown on screen after /Rotate and CropBox are applied (this matches a
pdf.js viewport at scale 1). Helpers here convert them to PDF user space."""
from __future__ import annotations

import io
from dataclasses import dataclass
from typing import Callable, Iterable

import pikepdf
from pikepdf import Array, Dictionary, Name
from reportlab.pdfgen import canvas as rl_canvas

MARK_KEY = Name("/PDFATY")


def inherited(page_obj: pikepdf.Dictionary, key: str):
    node = page_obj
    for _ in range(64):
        if key in node:
            return node[key]
        if "/Parent" not in node:
            return None
        node = node.Parent
    return None


@dataclass
class Geometry:
    x0: float
    y0: float
    w: float  # unrotated box width (user space)
    h: float
    rot: int

    @property
    def vw(self) -> float:
        return self.w if self.rot in (0, 180) else self.h

    @property
    def vh(self) -> float:
        return self.h if self.rot in (0, 180) else self.w

    def matrix(self) -> tuple[float, float, float, float, float, float]:
        """Visible (bottom-left origin) -> user space."""
        x0, y0, w, h = self.x0, self.y0, self.w, self.h
        if self.rot == 90:
            return (0, 1, -1, 0, x0 + w, y0)
        if self.rot == 180:
            return (-1, 0, 0, -1, x0 + w, y0 + h)
        if self.rot == 270:
            return (0, -1, 1, 0, x0, y0 + h)
        return (1, 0, 0, 1, x0, y0)

    def to_user(self, u: float, v: float) -> tuple[float, float]:
        a, b, c, d, e, f = self.matrix()
        return (a * u + c * v + e, b * u + d * v + f)

    def tl_to_user(self, x: float, y: float) -> tuple[float, float]:
        """Visible top-left coords -> user space."""
        return self.to_user(x, self.vh - y)

    def rect_tl_to_user(self, x: float, y: float, w: float, h: float) -> list[float]:
        pts = [self.tl_to_user(x, y), self.tl_to_user(x + w, y), self.tl_to_user(x, y + h), self.tl_to_user(x + w, y + h)]
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        return [min(xs), min(ys), max(xs), max(ys)]

    def user_to_tl(self, x: float, y: float) -> tuple[float, float]:
        a, b, c, d, e, f = self.matrix()
        # invert the 2x2 (orthonormal rotation) matrix
        det = a * d - b * c
        px, py = x - e, y - f
        u = (d * px - c * py) / det
        v = (-b * px + a * py) / det
        return (u, self.vh - v)

    def user_rect_to_tl(self, l: float, b: float, r: float, t: float) -> list[float]:
        pts = [self.user_to_tl(l, b), self.user_to_tl(r, b), self.user_to_tl(l, t), self.user_to_tl(r, t)]
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        return [min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)]


def _box(page_obj) -> list[float]:
    box = inherited(page_obj, "/CropBox") or inherited(page_obj, "/MediaBox")
    if box is None:
        return [0, 0, 612, 792]
    vals = [float(v) for v in box]
    mb = inherited(page_obj, "/MediaBox")
    if mb is not None and box is not mb:
        m = [float(v) for v in mb]
        # intersect CropBox with MediaBox
        vals = [max(min(vals[0], vals[2]), min(m[0], m[2])), max(min(vals[1], vals[3]), min(m[1], m[3])),
                min(max(vals[0], vals[2]), max(m[0], m[2])), min(max(vals[1], vals[3]), max(m[1], m[3]))]
    return [min(vals[0], vals[2]), min(vals[1], vals[3]), max(vals[0], vals[2]), max(vals[1], vals[3])]


def geometry(page: pikepdf.Page) -> Geometry:
    x0, y0, x1, y1 = _box(page.obj)
    rot = inherited(page.obj, "/Rotate")
    r = int(rot) % 360 if rot is not None else 0
    if r not in (0, 90, 180, 270):
        r = 0
    return Geometry(x0, y0, x1 - x0, y1 - y0, r)


def new_canvas(vw: float, vh: float) -> tuple[rl_canvas.Canvas, io.BytesIO]:
    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=(vw, vh), pageCompression=1)
    c.setAuthor("")
    c.setProducer("PDFATY")
    return c, buf


def overlay_forms(pdf: pikepdf.Pdf, page_indices: Iterable[int],
                  draw: Callable[[rl_canvas.Canvas, int, Geometry], bool]) -> dict[int, pikepdf.Object]:
    """Draw, with reportlab, one visible-space overlay per page and return Form XObjects
    (owned by `pdf`) keyed by page index. `draw` may return False to skip a page."""
    pages = list(page_indices)
    if not pages:
        return {}
    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pageCompression=1)
    c.setProducer("PDFATY")
    drawn: list[int] = []
    for i in pages:
        g = geometry(pdf.pages[i])
        c.setPageSize((g.vw, g.vh))
        if draw(c, i, g) is False:
            continue
        c.showPage()
        drawn.append(i)
    if not drawn:
        return {}
    c.save()
    buf.seek(0)
    src = pikepdf.open(buf)
    forms: dict[int, pikepdf.Object] = {}
    for k, i in enumerate(drawn):
        form = src.pages[k].as_form_xobject()
        forms[i] = pdf.copy_foreign(form)
    return forms


def _wrap_existing(pdf: pikepdf.Pdf, page: pikepdf.Page) -> None:
    """Isolate existing content in q/Q so its graphics state cannot leak into stamps."""
    if page.obj.get("/PDFATYWrapped"):
        return
    page.contents_coalesce()
    page.contents_add(pikepdf.Stream(pdf, b"q\n"), prepend=True)
    page.contents_add(pikepdf.Stream(pdf, b"\nQ\n"), prepend=False)


def stamp(pdf: pikepdf.Pdf, page: pikepdf.Page, form: pikepdf.Object, *, under: bool = False,
          kind: str = "Watermark", tag: str = "", artifact: bool = True) -> None:
    """Place a visible-space Form XObject on the page, mapped through the page rotation.
    The content is wrapped in a marked-content block so PDFATY (and other tools that
    honour /Artifact watermarks) can find and remove it later."""
    g = geometry(page)
    a, b, c, d, e, f = g.matrix()
    resources = page.obj.get("/Resources")
    if resources is None:
        page.obj.Resources = Dictionary()
        resources = page.obj.Resources
    if "/XObject" not in resources:
        resources.XObject = Dictionary()
    n = 0
    while Name(f"/PDFATY{kind[:2]}{n}") in resources.XObject:
        n += 1
    xname = Name(f"/PDFATY{kind[:2]}{n}")
    resources.XObject[xname] = form
    _wrap_existing(pdf, page)
    if artifact:
        props = f"/Artifact <</Type /Pagination /Subtype /{kind} /PDFATY ({tag or kind})>> BDC"
        if kind == "Background":
            props = f"/Artifact <</Type /Background /Subtype /Background /PDFATY ({tag or kind})>> BDC"
    else:
        props = f"/PDFATY <</Kind ({kind})>> BDC"
    content = f"{props}\nq {a:.6f} {b:.6f} {c:.6f} {d:.6f} {e:.4f} {f:.4f} cm {xname} Do Q\nEMC\n".encode()
    page.contents_add(pikepdf.Stream(pdf, content), prepend=under)


def hex_color(rgb) -> str:
    return "#%02x%02x%02x" % tuple(int(round(v * 255)) for v in rgb)


def make_image_xobject(pdf: pikepdf.Pdf, pil_img, jpeg_quality: int = 90) -> pikepdf.Stream:
    """Create an Image XObject (with SMask for alpha) from a PIL image."""
    import zlib

    img = pil_img
    smask = None
    if img.mode in ("RGBA", "LA", "PA") or (img.mode == "P" and "transparency" in img.info):
        img = img.convert("RGBA")
        alpha = img.getchannel("A")
        if alpha.getextrema() != (255, 255):
            smask = pikepdf.Stream(pdf, zlib.compress(alpha.tobytes()))
            smask.Type = Name.XObject
            smask.Subtype = Name.Image
            smask.Width, smask.Height = img.size
            smask.ColorSpace = Name.DeviceGray
            smask.BitsPerComponent = 8
            smask.Filter = Name.FlateDecode
        img = img.convert("RGB")
    elif img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    if smask is None and img.mode == "RGB" and getattr(pil_img, "format", None) == "JPEG":
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=jpeg_quality)
        data, filt = buf.getvalue(), Name.DCTDecode
    else:
        data, filt = zlib.compress(img.tobytes()), Name.FlateDecode
    st = pikepdf.Stream(pdf, data)
    st.Type = Name.XObject
    st.Subtype = Name.Image
    st.Width, st.Height = img.size
    st.ColorSpace = Name.DeviceRGB if img.mode == "RGB" else Name.DeviceGray
    st.BitsPerComponent = 8
    st.Filter = filt
    if smask is not None:
        st.SMask = smask
    return st


def page_array(*vals: float) -> Array:
    return Array([float(round(v, 4)) for v in vals])
