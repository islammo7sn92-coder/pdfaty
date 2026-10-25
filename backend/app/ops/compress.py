"""PDF compression: image downsampling/recompression + structural optimisation."""
from __future__ import annotations

import io
import math
import os
import shutil
import zlib

import pikepdf
import pypdfium2 as pdfium
from PIL import Image
from pikepdf import Name, PdfImage

from .base import Context, UserError, op

LEVELS = {
    "light": {"dpi": 220, "quality": 85, "images": True},
    "medium": {"dpi": 150, "quality": 72, "images": True},
    "strong": {"dpi": 96, "quality": 55, "images": True},
}


def _mul(m1, m2):
    a, b, c, d, e, f = m1
    A, B, C, D, E, F = m2
    return (a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F)


def image_display_sizes(pdf: pikepdf.Pdf) -> dict[tuple[int, int], float]:
    """Largest on-page width/height (points) each image XObject is drawn at."""
    sizes: dict[tuple[int, int], float] = {}

    def walk(content_owner, resources, ctm, depth):
        if depth > 6 or resources is None:
            return
        try:
            instrs = pikepdf.parse_content_stream(content_owner)
        except (pikepdf.PdfError, TypeError):
            return
        stack = []
        cur = ctm
        xobjs = resources.get("/XObject", {}) if hasattr(resources, "get") else {}
        for ins in instrs:
            try:
                o = str(ins.operator)
            except AttributeError:
                continue
            if o == "q":
                stack.append(cur)
            elif o == "Q" and stack:
                cur = stack.pop()
            elif o == "cm":
                try:
                    cur = _mul(tuple(float(v) for v in ins.operands), cur)
                except (ValueError, TypeError):
                    pass
            elif o == "Do":
                xo = xobjs.get(ins.operands[0]) if hasattr(xobjs, "get") else None
                if xo is None:
                    continue
                if xo.get("/Subtype") == Name.Image:
                    a, b, c, d, _, _ = cur
                    disp = max(math.hypot(a, b), math.hypot(c, d))
                    key = xo.objgen
                    sizes[key] = max(sizes.get(key, 0), disp)
                elif xo.get("/Subtype") == Name.Form:
                    m = tuple(float(v) for v in xo.get("/Matrix", [1, 0, 0, 1, 0, 0]))
                    walk(xo, xo.get("/Resources"), _mul(m, cur), depth + 1)

    for page in pdf.pages:
        walk(page, page.obj.get("/Resources"), (1, 0, 0, 1, 0, 0), 0)
    return sizes


def recompress_images(pdf: pikepdf.Pdf, target_dpi: float, quality: int, gray: bool = False, progress=None) -> dict:
    sizes = image_display_sizes(pdf)
    stats = {"images": 0, "recompressed": 0, "saved_bytes": 0}
    seen = set()
    objs = [o for o in pdf.objects if isinstance(o, pikepdf.Stream) and o.get("/Subtype") == Name.Image]
    for n, xo in enumerate(objs):
        if progress and n % 5 == 0:
            progress(80 * n / max(1, len(objs)))
        if xo.objgen in seen:
            continue
        seen.add(xo.objgen)
        stats["images"] += 1
        if xo.get("/ImageMask") or int(xo.get("/BitsPerComponent", 8)) == 1:
            continue
        w, h = int(xo.get("/Width", 0)), int(xo.get("/Height", 0))
        if w < 64 or h < 64:
            continue
        filt = xo.get("/Filter")
        filters = [str(f) for f in filt] if isinstance(filt, pikepdf.Array) else ([str(filt)] if filt else [])
        if any(f in ("/JBIG2Decode", "/CCITTFaxDecode", "/JPXDecode") for f in filters):
            continue
        is_smask_target = False
        try:
            raw_len = len(xo.read_raw_bytes())
        except pikepdf.PdfError:
            continue
        disp = sizes.get(xo.objgen)
        scale = 1.0
        if disp:
            eff_dpi = max(w, h) / (disp / 72.0)
            if eff_dpi > target_dpi * 1.15:
                scale = target_dpi / eff_dpi
        try:
            pil = PdfImage(xo).as_pil_image()
        except Exception:  # noqa: BLE001 – exotic colour spaces are left untouched
            continue
        if pil.mode in ("RGBA", "LA", "P", "PA", "I", "F", "1"):
            if pil.mode in ("I", "F", "1"):
                continue
            pil = pil.convert("RGB")
        if pil.mode == "CMYK":
            pil = pil.convert("RGB")
        if gray and pil.mode != "L":
            pil = pil.convert("L")
        if scale < 1:
            nw, nh = max(1, int(w * scale)), max(1, int(h * scale))
            pil = pil.resize((nw, nh), Image.LANCZOS)
        buf = io.BytesIO()
        pil.save(buf, "JPEG", quality=quality, optimize=True)
        data = buf.getvalue()
        smask = xo.get("/SMask")
        if len(data) >= raw_len * 0.95 and scale >= 1:
            continue
        xo.write(data, filter=Name.DCTDecode)
        xo.Width, xo.Height = pil.size
        xo.ColorSpace = Name.DeviceGray if pil.mode == "L" else Name.DeviceRGB
        xo.BitsPerComponent = 8
        for k in ("/DecodeParms", "/Decode", "/Intent"):
            if k in xo:
                del xo[k]
        if smask is not None and scale < 1:
            try:
                m = PdfImage(smask).as_pil_image().convert("L").resize(pil.size, Image.LANCZOS)
                smask.write(zlib.compress(m.tobytes()), filter=Name.FlateDecode)
                smask.Width, smask.Height = pil.size
                smask.BitsPerComponent = 8
                for k in ("/DecodeParms", "/Decode"):
                    if k in smask:
                        del smask[k]
            except Exception:  # noqa: BLE001
                pass
        stats["recompressed"] += 1
        stats["saved_bytes"] += max(0, raw_len - len(data))
    return stats


def validate_pdf(path: str, expected_pages: int, password: str = "") -> bool:
    try:
        with pikepdf.open(path, password=password) as p:
            if len(p.pages) != expected_pages:
                return False
        doc = pdfium.PdfDocument(path, password=password or None)
        ok = len(doc) == expected_pages
        if ok:
            page = doc[0]
            page.render(scale=0.2)
            page.close()
        doc.close()
        return ok
    except Exception:  # noqa: BLE001
        return False


@op("compress")
def compress(ctx: Context) -> None:
    f = ctx.first_pdf()
    before = os.path.getsize(f.path)
    pdf = ctx.open_pdf(f)
    n_pages = len(pdf.pages)
    level = ctx.p("level", "medium")
    cfg = dict(LEVELS.get(level, LEVELS["medium"]))
    if ctx.p("dpi"):
        cfg["dpi"] = ctx.pint("dpi", cfg["dpi"], 50, 600)
    if ctx.p("quality"):
        cfg["quality"] = ctx.pint("quality", cfg["quality"], 20, 95)
    stats = {}
    if cfg["images"]:
        stats = recompress_images(pdf, cfg["dpi"], cfg["quality"], bool(ctx.p("grayscale")), ctx.progress)
    if ctx.p("remove_metadata"):
        from .security import sanitize

        sanitize(pdf, {"metadata": True, "javascript": False, "attachments": False, "thumbnails": True})
    try:
        pdf.remove_unreferenced_resources()
    except pikepdf.PdfError:
        pass
    tmp = ctx.tmp("compressed.pdf")
    pdf.save(tmp, compress_streams=True, recompress_flate=True, object_stream_mode=pikepdf.ObjectStreamMode.generate,
             linearize=bool(ctx.p("linearize", False)))
    pdf.close()
    after = os.path.getsize(tmp)
    if not validate_pdf(tmp, n_pages):
        raise UserError("output_validation_failed")
    kept_original = False
    name = f.stem + "_compressed.pdf"
    dest = ctx.out_path(name)
    if after >= before:
        # never hand back a bigger file
        shutil.copy(f.path, dest)
        after, kept_original = before, True
    else:
        shutil.copy(tmp, dest)
    ctx.add_output(dest, name)
    ctx.result = {"before": before, "after": after, "ratio": round(100 * (before - after) / before, 1) if before else 0,
                  "level": level, "images": stats, "kept_original": kept_original, "valid": True}
