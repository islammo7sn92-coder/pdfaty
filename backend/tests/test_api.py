"""HTTP-level tests: upload validation, limits, job lifecycle, downloads and security headers."""
import io
import json
import os
import time

import pikepdf
import pytest
from fastapi.testclient import TestClient

from app.main import app, limiter
from app.jobs import manager
from app.config import settings


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def wait(client, jid, timeout=180):
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = client.get(f"/api/jobs/{jid}")
        assert r.status_code == 200
        d = r.json()
        if d["status"] in ("done", "error"):
            return d
        time.sleep(0.2)
    raise AssertionError("job timeout")


def submit(client, op, files, params=None):
    fs = [("files", (os.path.basename(p) if isinstance(p, str) else p[0],
                     open(p, "rb") if isinstance(p, str) else p[1], "application/octet-stream")) for p in files]
    return client.post("/api/jobs", data={"op": op, "params": json.dumps(params or {})}, files=fs)


def test_health_and_capabilities(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"
    caps = client.get("/api/capabilities").json()
    assert "merge" in caps["ops"] and caps["limits"]["max_upload_mb"] == settings.max_upload_mb
    assert "ara" in caps["ocr_languages"] and caps["office"] is True


def test_security_headers(client):
    r = client.get("/api/health")
    h = r.headers
    assert "default-src 'self'" in h["content-security-policy"]
    assert h["x-content-type-options"] == "nosniff" and h["referrer-policy"] == "no-referrer"
    assert h["cache-control"] == "no-store" and h["x-frame-options"] == "DENY"
    assert "set-cookie" not in h


def test_full_job_lifecycle_merge_and_download(client, samples):
    r = submit(client, "merge", [samples["english"], samples["arabic"]])
    assert r.status_code == 200, r.text
    jid = r.json()["id"]
    assert len(jid) >= 30
    d = wait(client, jid)
    assert d["status"] == "done", d
    out = d["outputs"][0]
    assert out["mime"] == "application/pdf"
    r = client.get(f"/api/jobs/{jid}/files/0")
    assert r.status_code == 200 and r.content.startswith(b"%PDF")
    assert "attachment" in r.headers["content-disposition"]
    with pikepdf.open(io.BytesIO(r.content)) as p:
        assert len(p.pages) > 6
    job_dir = manager.get(jid).dir
    assert os.path.isdir(job_dir)
    assert client.delete(f"/api/jobs/{jid}").status_code == 204
    assert not os.path.exists(job_dir)  # files removed from the server
    assert client.get(f"/api/jobs/{jid}").status_code == 404


def test_error_job_reports_code(client, samples):
    r = submit(client, "info", [samples["encrypted"]])
    d = wait(client, r.json()["id"])
    assert d["status"] == "error" and d["error"] == "password_required"
    r = submit(client, "info", [samples["bad"]])
    d = wait(client, r.json()["id"])
    assert d["status"] == "error" and d["error"] == "invalid_pdf"


def test_rejects_non_pdf_disguised(client, tmp_path):
    p = tmp_path / "evil.pdf"
    p.write_bytes(b"MZ\x90\x00 this is an exe")
    r = submit(client, "merge", [str(p), str(p)])
    assert r.status_code == 415 and r.json()["error"] == "unsupported_file_type"


def test_rejects_unknown_op_and_bad_params(client, samples):
    r = submit(client, "rm_rf", [samples["english"]])
    assert r.status_code == 400 and r.json()["error"] == "unknown_op"
    r = client.post("/api/jobs", data={"op": "merge", "params": "not json"},
                    files=[("files", ("a.pdf", open(samples["english"], "rb"), "application/pdf"))])
    assert r.status_code == 400 and r.json()["error"] == "bad_params"


def test_upload_size_limit(client, tmp_path):
    big = tmp_path / "big.pdf"
    with open(big, "wb") as fh:
        fh.write(b"%PDF-1.4\n")
        fh.write(b"0" * (settings.max_upload_bytes + 1024))
    r = submit(client, "info", [str(big)])
    assert r.status_code == 413 and r.json()["error"] == "file_too_large"
    assert not [j for j in manager.jobs.values() if j.status == "queued" and j.op == "info" and not os.path.exists(j.dir)]


def test_too_many_files(client, samples):
    files = [samples["english"]] * (settings.max_files + 1)
    r = submit(client, "merge", files)
    assert r.status_code == 413 and r.json()["error"] == "too_many_files"


def test_rate_limit(client, samples):
    old = limiter.per_minute
    limiter.per_minute = 2
    limiter.hits.clear()
    try:
        codes = [submit(client, "info", [samples["english"]]).status_code for _ in range(3)]
        assert codes[:2] == [200, 200] and codes[2] == 429
    finally:
        limiter.per_minute = old
        limiter.hits.clear()


def test_path_traversal_filename(client, samples):
    data = open(samples["english"], "rb").read()
    r = submit(client, "info", [("../../../../etc/passwd.pdf", io.BytesIO(data))])
    assert r.status_code == 200
    jid = r.json()["id"]
    wait(client, jid)
    job = manager.get(jid)
    for root, _, files in os.walk(job.dir):
        assert os.path.commonpath([root, job.dir]) == job.dir
    meta = json.load(open(os.path.join(job.dir, "meta.json")))
    assert "/" not in meta["inputs"][0]["name"] and ".." not in meta["inputs"][0]["file"]


def test_unknown_job_and_file_index(client, samples):
    assert client.get("/api/jobs/doesnotexist").status_code == 404
    r = submit(client, "info", [samples["english"]])
    jid = r.json()["id"]
    wait(client, jid)
    assert client.get(f"/api/jobs/{jid}/files/5").status_code == 404
    assert client.get("/api/whatever").status_code == 404


def test_large_pdf_processing(client, tmp_path):
    # 400-page document: must be processed within limits
    from reportlab.pdfgen import canvas

    p = str(tmp_path / "large.pdf")
    c = canvas.Canvas(p)
    for i in range(400):
        c.drawString(72, 700, f"Large document page {i + 1}")
        c.showPage()
    c.save()
    r = submit(client, "split", [p], {"mode": "every", "every": 100})
    d = wait(client, r.json()["id"])
    assert d["status"] == "done" and len([o for o in d["outputs"] if o["name"].endswith(".pdf")]) == 4
    r = submit(client, "compress", [p], {"level": "medium"})
    d = wait(client, r.json()["id"])
    assert d["status"] == "done"


def test_ocr_via_api_with_progress(client, samples):
    r = submit(client, "ocr", [samples["scanned"]], {"languages": ["ara", "eng"]})
    d = wait(client, r.json()["id"], timeout=300)
    assert d["status"] == "done" and d["result"]["stats"][0]["words"] > 20


def test_no_logs_of_passwords(client, samples, caplog):
    caplog.set_level("DEBUG")
    r = submit(client, "info", [samples["encrypted"]], {"password": "user123"})
    wait(client, r.json()["id"])
    assert "user123" not in caplog.text
