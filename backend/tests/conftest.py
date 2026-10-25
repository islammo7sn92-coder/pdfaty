import os

os.environ.setdefault("PDFATY_MAX_UPLOAD_MB", "20")
os.environ.setdefault("PDFATY_RATE_LIMIT_PER_MIN", "1000")
os.environ.setdefault("PDFATY_MAX_ACTIVE_JOBS_PER_IP", "50")
os.environ.setdefault("PDFATY_MAX_QUEUE", "100")
import shutil
import sys
import tempfile

import pikepdf
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.ops import REGISTRY, Context, InputFile  # noqa: E402
from app.ops.base import UserError  # noqa: E402

@pytest.fixture(scope="session")
def samples(tmp_path_factory):
    from samples import build_samples

    return build_samples(tmp_path_factory.mktemp("samples"))


KIND = {".pdf": "pdf", ".png": "image", ".jpg": "image", ".docx": "office", ".xlsx": "office", ".txt": "text", ".html": "html", ".p12": "other"}


def run_op(op: str, params: dict, files: list[str]):
    jd = tempfile.mkdtemp(prefix="job")
    os.makedirs(os.path.join(jd, "out"))
    inputs = [InputFile(f, os.path.basename(f), KIND.get(os.path.splitext(f)[1].lower(), "other")) for f in files]
    ctx = Context(jd, inputs, dict(params), op=op)
    REGISTRY[op](ctx)
    outs = [os.path.join(jd, "out", o["file"]) for o in ctx.outputs]
    return ctx, outs


def pdf_text(path: str, password: str = "") -> str:
    import pypdfium2 as pdfium

    from app.ops.extract import geometries, lines_text, page_lines

    geos = geometries(path, password)
    doc = pdfium.PdfDocument(path, password=password or None)
    parts = []
    for i in range(len(doc)):
        page = doc[i]
        parts.append(lines_text(page_lines(page, geo=geos[i])))
        page.close()
    doc.close()
    return "\n".join(parts)


@pytest.fixture
def run():
    return run_op


@pytest.fixture
def text_of():
    return pdf_text


@pytest.fixture
def user_error():
    return UserError
