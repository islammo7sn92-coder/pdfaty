"""PDFATY HTTP API + static frontend server."""
from __future__ import annotations

import json
import logging
import os
import subprocess
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import quote

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from . import __version__
from .config import settings, soffice_path, tool_available
from .jobs import manager
from .ops.base import safe_filename
from .ops import REGISTRY
from .ops.catalog import OP_INPUT_KINDS

KNOWN_OPS = set(REGISTRY)

logging.basicConfig(level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("pdfaty")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await manager.start()
    yield
    await manager.stop()


app = FastAPI(title="PDFATY", version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

CSP = (
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; "
    "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; "
    "connect-src 'self' blob: data:; object-src 'none'; frame-src 'self' blob:; frame-ancestors 'none'; "
    "base-uri 'self'; form-action 'self'"
)


class SecurityHeaders(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        h = response.headers
        h.setdefault("Content-Security-Policy", CSP)
        h.setdefault("X-Content-Type-Options", "nosniff")
        h.setdefault("Referrer-Policy", "no-referrer")
        h.setdefault("X-Frame-Options", "DENY")
        h.setdefault("Cross-Origin-Opener-Policy", "same-origin")
        h.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()")
        if request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https":
            h.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        if request.url.path.startswith("/api/"):
            h["Cache-Control"] = "no-store"
        return response


app.add_middleware(SecurityHeaders)


# --------------------------------------------------------------------------- helpers
def client_id(request: Request) -> str:
    if settings.trust_proxy:
        xff = request.headers.get("x-forwarded-for")
        if xff:
            # The right-most entry is the one appended by our own reverse proxy.
            return xff.split(",")[-1].strip()[:64]
    return request.client.host if request.client else "unknown"


class RateLimiter:
    def __init__(self, per_minute: int) -> None:
        self.per_minute = per_minute
        self.hits: dict[str, deque[float]] = defaultdict(deque)

    def allow(self, key: str) -> bool:
        now = time.time()
        q = self.hits[key]
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= self.per_minute:
            return False
        q.append(now)
        if len(self.hits) > 10000:  # bound memory
            for k in list(self.hits)[:5000]:
                if not self.hits[k] or now - self.hits[k][-1] > 60:
                    self.hits.pop(k, None)
        return True


limiter = RateLimiter(settings.rate_limit_per_min)


def err(status: int, code: str, detail: str | None = None) -> HTTPException:
    return HTTPException(status_code=status, detail={"error": code, "detail": detail})


@app.exception_handler(HTTPException)
async def http_exc_handler(request: Request, exc: HTTPException):
    detail = exc.detail if isinstance(exc.detail, dict) else {"error": "http_error", "detail": str(exc.detail)}
    return JSONResponse(status_code=exc.status_code, content=detail)


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception):  # pragma: no cover
    log.error("unhandled %s on %s", type(exc).__name__, request.url.path)
    return JSONResponse(status_code=500, content={"error": "server_error"})


OFFICE_EXT = {".doc", ".docx", ".odt", ".rtf", ".xls", ".xlsx", ".ods", ".ppt", ".pptx", ".odp", ".odg", ".vsd", ".vsdx", ".pub", ".wpd", ".dxf", ".svg", ".cdr", ".eps"}
TEXT_EXT = {".txt", ".csv", ".md", ".tsv", ".log", ".json", ".xml"}
HTML_EXT = {".html", ".htm", ".xhtml"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff", ".webp"}


def sniff_kind(head: bytes, filename: str) -> str:
    ext = os.path.splitext(filename.lower())[1]
    if b"%PDF-" in head[:1024]:
        return "pdf"
    if head.startswith(b"\x89PNG\r\n\x1a\n") or head.startswith(b"\xff\xd8\xff") or head[:6] in (b"GIF87a", b"GIF89a") \
            or head.startswith(b"BM") and ext == ".bmp" or head[:4] in (b"II*\x00", b"MM\x00*") \
            or (head[:4] == b"RIFF" and head[8:12] == b"WEBP"):
        return "image"
    if ext in OFFICE_EXT and (head.startswith(b"PK\x03\x04") or head.startswith(b"\xd0\xcf\x11\xe0") or head.startswith(b"{\\rtf")
                              or ext in (".svg", ".dxf", ".eps")):
        return "office"
    if ext in HTML_EXT:
        return "html"
    if ext in TEXT_EXT:
        try:
            head.decode("utf-8")
            return "text"
        except UnicodeDecodeError:
            # tolerate a truncated multibyte char at the end of the sniffed head
            try:
                head[:-4].decode("utf-8")
                return "text"
            except UnicodeDecodeError:
                return "text" if b"\x00" not in head else "other"
    return "other"


# --------------------------------------------------------------------------- routes
@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {"status": "ok", "version": __version__, "queue": manager.pending()}


_caps_cache: dict[str, Any] = {}


@app.get("/api/capabilities")
async def capabilities() -> dict[str, Any]:
    if not _caps_cache:
        langs: list[str] = []
        if tool_available("tesseract"):
            try:
                out = subprocess.run(["tesseract", "--list-langs"], capture_output=True, text=True, timeout=10).stdout
                langs = [l.strip() for l in out.splitlines()[1:] if l.strip() and l.strip() != "osd"]
            except (OSError, subprocess.SubprocessError):
                pass
        _caps_cache.update({
            "version": __version__,
            "ops": sorted(KNOWN_OPS),
            "ocr": bool(langs),
            "ocr_languages": langs,
            "office": soffice_path() is not None,
            "limits": {
                "max_upload_mb": settings.max_upload_mb,
                "max_total_mb": settings.max_total_mb,
                "max_files": settings.max_files,
                "max_pages": settings.max_pages,
                "job_timeout": settings.job_timeout,
                "result_ttl": settings.result_ttl,
            },
        })
    return _caps_cache


@app.post("/api/jobs")
async def create_job(request: Request, op: str = Form(...), params: str = Form("{}"),
                     files: list[UploadFile] | None = File(None)):
    files = files or []
    if op not in KNOWN_OPS:
        raise err(400, "unknown_op")
    cid = client_id(request)
    if not limiter.allow(cid):
        raise err(429, "rate_limited")
    if manager.active_for(cid) >= settings.max_jobs_per_ip:
        raise err(429, "too_many_active_jobs")
    if manager.pending() >= settings.max_queue:
        raise err(503, "server_busy")
    if len(files) > settings.max_files:
        raise err(413, "too_many_files", str(settings.max_files))
    try:
        p = json.loads(params or "{}")
        if not isinstance(p, dict):
            raise ValueError
    except ValueError:
        raise err(400, "bad_params")
    if len(params) > 2_000_000:
        raise err(413, "params_too_large")

    allowed = OP_INPUT_KINDS.get(op, {"pdf"})
    job = manager.new_job(op, cid)
    total = 0
    inputs = []
    try:
        for i, uf in enumerate(files):
            name = safe_filename(uf.filename or f"file{i}")
            dest_name = f"{i:03d}{os.path.splitext(name)[1].lower()[:10]}"
            dest = os.path.join(job.dir, "in", dest_name)
            size = 0
            head = b""
            with open(dest, "wb") as out:
                while True:
                    chunk = await uf.read(1024 * 1024)
                    if not chunk:
                        break
                    if not head:
                        head = chunk[:2048]
                    size += len(chunk)
                    total += len(chunk)
                    if size > settings.max_upload_bytes:
                        raise err(413, "file_too_large", str(settings.max_upload_mb))
                    if total > settings.max_total_bytes:
                        raise err(413, "total_too_large", str(settings.max_total_mb))
                    out.write(chunk)
            await uf.close()
            if size == 0:
                raise err(400, "empty_file", name)
            kind = sniff_kind(head, name)
            if kind not in allowed and "any" not in allowed:
                raise err(415, "unsupported_file_type", name)
            inputs.append({"file": dest_name, "name": name, "kind": kind})
        with open(os.path.join(job.dir, "meta.json"), "w", encoding="utf-8") as fh:
            json.dump({"op": op, "params": p, "inputs": inputs, "max_pages": settings.max_pages}, fh, ensure_ascii=False)
    except HTTPException:
        manager.delete(job.id)
        raise
    await manager.submit(job)
    return {"id": job.id, "status": job.status}


def _job_or_404(jid: str):
    job = manager.get(jid)
    if job is None or len(jid) > 64:
        raise err(404, "job_not_found")
    return job


@app.get("/api/jobs/{jid}")
async def job_status(jid: str):
    return _job_or_404(jid).public()


@app.get("/api/jobs/{jid}/files/{index}")
async def job_file(jid: str, index: int, inline: int = 0):
    job = _job_or_404(jid)
    if job.status != "done" or index < 0 or index >= len(job.outputs):
        raise err(404, "file_not_found")
    o = job.outputs[index]
    path = os.path.join(job.dir, "out", os.path.basename(o["file"]))
    if not os.path.isfile(path):
        raise err(404, "file_not_found")
    disp = "inline" if inline else "attachment"
    ascii_name = o["name"].encode("ascii", "replace").decode().replace("?", "_").replace('"', "")
    headers = {"Content-Disposition": f"{disp}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(o['name'])}"}
    return FileResponse(path, media_type=o["mime"], headers=headers)


@app.delete("/api/jobs/{jid}")
async def job_delete(jid: str):
    manager.delete(jid)
    return Response(status_code=204)


@app.api_route("/api/{rest:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def api_404(rest: str):
    raise err(404, "not_found")


# --------------------------------------------------------------------------- frontend
static_dir = os.path.abspath(settings.static_dir)
if os.path.isdir(static_dir):
    assets = os.path.join(static_dir, "assets")
    if os.path.isdir(assets):
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{path:path}")
    async def spa(path: str):
        candidate = os.path.abspath(os.path.join(static_dir, path))
        if path and candidate.startswith(static_dir + os.sep) and os.path.isfile(candidate):
            return FileResponse(candidate)
        return FileResponse(os.path.join(static_dir, "index.html"), headers={"Cache-Control": "no-cache"})
