"""Child-process entry point: `python -m app.worker <job_dir>`.

Runs exactly one operation, writes out/ files and result.json, then exits.
Running in a separate process lets the server enforce timeouts and memory
limits, and keeps a crash in a native PDF library from taking the server down."""
from __future__ import annotations

import json
import logging
import os
import resource
import sys
import traceback


def _limit_memory() -> None:
    mb = int(os.environ.get("PDFATY_WORKER_MEMORY_MB", "3072") or 0)
    if mb > 0:
        try:
            resource.setrlimit(resource.RLIMIT_AS, (mb * 1024 * 1024, mb * 1024 * 1024))
        except (ValueError, OSError):
            pass


def main(job_dir: str) -> int:
    _limit_memory()
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = 120_000_000  # decompression-bomb guard

    from .ops import REGISTRY, UserError, Context, InputFile  # noqa: WPS433 (import after limits)

    with open(os.path.join(job_dir, "meta.json"), "r", encoding="utf-8") as fh:
        meta = json.load(fh)
    inputs = [InputFile(path=os.path.join(job_dir, "in", i["file"]), name=i["name"], kind=i["kind"]) for i in meta["inputs"]]
    ctx = Context(job_dir=job_dir, inputs=inputs, params=meta.get("params") or {}, max_pages=int(meta.get("max_pages", 2000)), op=meta["op"])
    result: dict = {"ok": False}
    code = 1
    try:
        fn = REGISTRY.get(meta["op"])
        if fn is None:
            raise UserError("unknown_op")
        fn(ctx)
        result = {"ok": True, "outputs": ctx.outputs, "result": ctx.result}
        code = 0
    except UserError as e:
        result = {"ok": False, "error": e.code, "detail": (e.detail or None)}
    except MemoryError:
        result = {"ok": False, "error": "out_of_memory"}
    except Exception as e:  # noqa: BLE001
        # Log only the exception type + location, never document content or params.
        tb = traceback.extract_tb(e.__traceback__)
        where = f"{tb[-1].filename.rsplit('/', 1)[-1]}:{tb[-1].lineno}" if tb else "?"
        logging.getLogger("pdfaty.worker").error("op=%s failed: %s at %s", meta.get("op"), type(e).__name__, where)
        sys.stderr.write(f"{type(e).__name__} at {where}\n")
        if os.environ.get("PDFATY_DEBUG") == "1":
            traceback.print_exc()
        result = {"ok": False, "error": _classify(e)}
    with open(os.path.join(job_dir, "result.json"), "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False)
    return code


def _classify(e: Exception) -> str:
    name = type(e).__name__
    if "Password" in name:
        return "password_required"
    if name in ("PdfError", "PdfiumError", "DependencyError") or "pdf" in name.lower():
        return "invalid_pdf"
    return "processing_failed"


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
