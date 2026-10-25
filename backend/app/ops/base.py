"""Shared helpers for operations executed inside the worker process."""
from __future__ import annotations

import json
import mimetypes
import os
import re
from dataclasses import dataclass, field
from typing import Any, Callable

import pikepdf


class UserError(Exception):
    """An expected failure whose `code` is shown to the user (translated client-side)."""

    def __init__(self, code: str, detail: str | None = None):
        super().__init__(code)
        self.code = code
        self.detail = detail


@dataclass
class InputFile:
    path: str
    name: str  # original (sanitised) filename, for display only
    kind: str  # pdf | image | office | text | html | other

    @property
    def stem(self) -> str:
        return os.path.splitext(self.name)[0] or "file"


@dataclass
class Context:
    job_dir: str
    inputs: list[InputFile]
    params: dict[str, Any]
    outputs: list[dict[str, Any]] = field(default_factory=list)
    result: dict[str, Any] = field(default_factory=dict)
    max_pages: int = 2000
    op: str = ""
    _last_progress: float = -1

    @property
    def out_dir(self) -> str:
        return os.path.join(self.job_dir, "out")

    def tmp(self, name: str) -> str:
        d = os.path.join(self.job_dir, "work")
        os.makedirs(d, exist_ok=True)
        return os.path.join(d, name)

    def progress(self, pct: float, message: str = "") -> None:
        pct = max(0.0, min(99.0, float(pct)))
        if abs(pct - self._last_progress) < 0.5 and not message:
            return
        self._last_progress = pct
        tmp = os.path.join(self.job_dir, "progress.json.tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"progress": pct, "message": message}, fh)
        os.replace(tmp, os.path.join(self.job_dir, "progress.json"))

    def out_path(self, name: str) -> str:
        safe = safe_filename(name)
        base, ext = os.path.splitext(safe)
        path = os.path.join(self.out_dir, safe)
        n = 2
        while os.path.exists(path):
            path = os.path.join(self.out_dir, f"{base}-{n}{ext}")
            n += 1
        return path

    def add_output(self, path: str, name: str | None = None) -> None:
        name = safe_filename(name or os.path.basename(path))
        mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
        self.outputs.append({"file": os.path.basename(path), "name": name, "size": os.path.getsize(path), "mime": mime})

    def save_pdf(self, pdf: pikepdf.Pdf, name: str, **kw: Any) -> str:
        path = self.out_path(name)
        save_pdf(pdf, path, **kw)
        self.add_output(path, name)
        return path

    # --- parameter helpers ---
    def p(self, key: str, default: Any = None) -> Any:
        return self.params.get(key, default)

    def pint(self, key: str, default: int, lo: int | None = None, hi: int | None = None) -> int:
        try:
            v = int(self.params.get(key, default))
        except (TypeError, ValueError):
            raise UserError("bad_params", key)
        if lo is not None and v < lo:
            v = lo
        if hi is not None and v > hi:
            v = hi
        return v

    def pfloat(self, key: str, default: float, lo: float | None = None, hi: float | None = None) -> float:
        try:
            v = float(self.params.get(key, default))
        except (TypeError, ValueError):
            raise UserError("bad_params", key)
        if lo is not None and v < lo:
            v = lo
        if hi is not None and v > hi:
            v = hi
        return v

    def pdf_inputs(self) -> list[InputFile]:
        return [f for f in self.inputs if f.kind == "pdf"]

    def first_pdf(self) -> InputFile:
        pdfs = self.pdf_inputs()
        if not pdfs:
            raise UserError("no_pdf")
        return pdfs[0]

    def password_for(self, index: int) -> str:
        pw = self.params.get("passwords")
        if isinstance(pw, list) and index < len(pw) and pw[index]:
            return str(pw[index])
        if isinstance(pw, dict) and pw.get(str(index)):
            return str(pw[str(index)])
        return str(self.params.get("password") or "")

    def open_pdf(self, f: InputFile | None = None, index: int | None = None) -> pikepdf.Pdf:
        if f is None:
            f = self.first_pdf()
        if index is None:
            index = self.inputs.index(f)
        pdf = open_pdf(f.path, self.password_for(index))
        check_permission(pdf, OP_PERMISSION.get(self.op, "modify_other"))
        if len(pdf.pages) > self.max_pages:
            raise UserError("too_many_pages", str(self.max_pages))
        return pdf


_SAFE_RE = re.compile(r"[^\w\-. ()\[\]؀-ۿ]+", re.UNICODE)


def safe_filename(name: str, default: str = "file") -> str:
    name = os.path.basename(str(name or "").replace("\\", "/"))
    name = _SAFE_RE.sub("_", name).strip(" ._")
    if not name:
        name = default
    if len(name) > 120:
        base, ext = os.path.splitext(name)
        name = base[: 120 - len(ext)] + ext
    return name


def open_pdf(path: str, password: str = "") -> pikepdf.Pdf:
    try:
        return pikepdf.open(path, password=password or "")
    except pikepdf.PasswordError:
        raise UserError("wrong_password" if password else "password_required")
    except pikepdf.PdfError as e:
        raise UserError("invalid_pdf", str(e)[:200])


# Which PDF permission each operation needs. Restrictions set by the document owner
# are honoured: without the owner password the operation is refused, never bypassed.
OP_PERMISSION: dict[str, str | None] = {
    "info": None, "inspect": None, "watermark_analyze": None, "forms_list": None, "text_objects": None,
    "detect_blank": None, "unprotect": None,
    "compare": "extract", "pdf_to_text": "extract", "pdf_to_docx": "extract", "pdf_to_xlsx": "extract",
    "pdf_to_csv": "extract", "pdf_to_pptx": "extract", "pdf_to_images": "extract", "extract_images": "extract",
    "redact_search": "extract",
    "merge": "modify_assembly", "split": "modify_assembly", "organize": "modify_assembly", "rotate": "modify_assembly",
    "delete_pages": "modify_assembly", "extract_pages": "modify_assembly", "insert_blank": "modify_assembly",
    "remove_blank": "modify_assembly",
    "annotate": "modify_annotation", "annot_edit": "modify_annotation",
    "forms_fill": "modify_form", "sign_certificate": "modify_form", "signatures_verify": None,
}


def check_permission(pdf: pikepdf.Pdf, perm: str | None) -> None:
    if not perm or not pdf.is_encrypted or pdf.owner_password_matched:
        return
    if not getattr(pdf.allow, perm, True):
        raise UserError("permission_denied", perm)


def save_pdf(pdf: pikepdf.Pdf, path: str, **kw: Any) -> None:
    kw.setdefault("compress_streams", True)
    kw.setdefault("object_stream_mode", pikepdf.ObjectStreamMode.generate)
    # Keep an encrypted document encrypted (same passwords/permissions) unless the
    # operation explicitly sets or removes encryption.
    kw.setdefault("encryption", True if pdf.is_encrypted else False)
    pdf.save(path, **kw)


def parse_pages(spec: Any, total: int, default_all: bool = True) -> list[int]:
    """Parse a page selection like "1-3, 5, 8-" or [1,2,3] (1-based) into 0-based indices.
    Supports 'odd', 'even', 'last', 'all'."""
    if spec is None or spec == "" or spec == "all":
        return list(range(total)) if default_all else []
    if isinstance(spec, list):
        out = []
        for v in spec:
            try:
                i = int(v) - 1
            except (TypeError, ValueError):
                raise UserError("bad_page_range", str(v))
            if 0 <= i < total and i not in out:
                out.append(i)
        return out
    s = str(spec).strip().lower().replace("،", ",").replace("–", "-").replace("—", "-")
    s = s.translate(str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789"))
    if s in ("odd", "فردي", "الفردية"):
        return list(range(0, total, 2))
    if s in ("even", "زوجي", "الزوجية"):
        return list(range(1, total, 2))
    out: list[int] = []
    for part in [p.strip() for p in s.split(",") if p.strip()]:
        part = part.replace("last", str(total)).replace("end", str(total))
        m = re.fullmatch(r"(\d*)\s*-\s*(\d*)", part)
        if m:
            a = int(m.group(1)) if m.group(1) else 1
            b = int(m.group(2)) if m.group(2) else total
            if a > b:
                rng = range(b, a + 1)[::-1]
            else:
                rng = range(a, b + 1)
        elif part.isdigit():
            rng = [int(part)]
        else:
            raise UserError("bad_page_range", part)
        for p in rng:
            if p < 1 or p > total:
                raise UserError("page_out_of_range", f"{p}/{total}")
            if p - 1 not in out:
                out.append(p - 1)
    if not out:
        raise UserError("bad_page_range", str(spec))
    return out


def parse_color(value: Any, default: tuple[float, float, float] = (0, 0, 0)) -> tuple[float, float, float]:
    if isinstance(value, (list, tuple)) and len(value) >= 3:
        return tuple(max(0.0, min(1.0, float(c) / (255 if max(value[:3]) > 1 else 1))) for c in value[:3])  # type: ignore
    if isinstance(value, str):
        v = value.strip().lstrip("#")
        if len(v) == 3:
            v = "".join(c * 2 for c in v)
        if re.fullmatch(r"[0-9a-fA-F]{6}", v):
            return (int(v[0:2], 16) / 255, int(v[2:4], 16) / 255, int(v[4:6], 16) / 255)
    return default


OpFunc = Callable[[Context], None]
REGISTRY: dict[str, OpFunc] = {}


def op(name: str) -> Callable[[OpFunc], OpFunc]:
    def deco(fn: OpFunc) -> OpFunc:
        REGISTRY[name] = fn
        return fn

    return deco
