"""In-memory job queue. Each job runs in an isolated child process (app.worker)
with a hard timeout and memory limit, inside its own random temp directory.
Job directories are deleted after the client fetches the result or when the
TTL expires — nothing is kept permanently."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import shutil
import signal
import sys
import time
from dataclasses import dataclass, field
from typing import Any

from .config import settings

log = logging.getLogger("pdfaty.jobs")

SLOW_OPS = {"ocr", "compare", "convert_to_pdf", "compress", "pdf_to_docx", "pdf_to_pptx", "redact_apply"}


@dataclass
class Job:
    id: str
    op: str
    dir: str
    client: str
    status: str = "queued"  # queued | running | done | error
    progress: float = 0.0
    message: str = ""
    error: str | None = None
    error_detail: str | None = None
    created: float = field(default_factory=time.time)
    finished: float | None = None
    outputs: list[dict[str, Any]] = field(default_factory=list)
    result: dict[str, Any] = field(default_factory=dict)
    proc: asyncio.subprocess.Process | None = None

    def public(self) -> dict[str, Any]:
        if self.status == "running":
            self._refresh_progress()
        return {
            "id": self.id,
            "op": self.op,
            "status": self.status,
            "progress": round(self.progress, 1),
            "message": self.message,
            "error": self.error,
            "error_detail": self.error_detail,
            "outputs": [
                {"index": i, "name": o["name"], "size": o["size"], "mime": o["mime"]}
                for i, o in enumerate(self.outputs)
            ],
            "result": self.result,
        }

    def _refresh_progress(self) -> None:
        try:
            with open(os.path.join(self.dir, "progress.json"), "r", encoding="utf-8") as fh:
                data = json.load(fh)
            self.progress = float(data.get("progress", self.progress))
            self.message = str(data.get("message", self.message))[:200]
        except (OSError, ValueError):
            pass


class JobManager:
    def __init__(self) -> None:
        self.jobs: dict[str, Job] = {}
        self.queue: asyncio.Queue[str] = asyncio.Queue()
        self._workers: list[asyncio.Task] = []
        self._janitor: asyncio.Task | None = None
        os.makedirs(settings.tmp_dir, mode=0o700, exist_ok=True)

    async def start(self) -> None:
        # Remove leftovers from a previous run (crash / restart).
        for name in os.listdir(settings.tmp_dir):
            shutil.rmtree(os.path.join(settings.tmp_dir, name), ignore_errors=True)
        for _ in range(max(1, settings.max_concurrent_jobs)):
            self._workers.append(asyncio.create_task(self._worker_loop()))
        self._janitor = asyncio.create_task(self._janitor_loop())

    async def stop(self) -> None:
        for t in self._workers:
            t.cancel()
        if self._janitor:
            self._janitor.cancel()
        for job in self.jobs.values():
            if job.proc and job.proc.returncode is None:
                try:
                    job.proc.kill()
                except ProcessLookupError:
                    pass
            shutil.rmtree(job.dir, ignore_errors=True)

    # ----- creation -------------------------------------------------------
    def active_for(self, client: str) -> int:
        return sum(1 for j in self.jobs.values() if j.client == client and j.status in ("queued", "running"))

    def pending(self) -> int:
        return sum(1 for j in self.jobs.values() if j.status in ("queued", "running"))

    def new_job(self, op: str, client: str) -> Job:
        jid = secrets.token_urlsafe(24)
        jdir = os.path.join(settings.tmp_dir, jid)
        os.makedirs(os.path.join(jdir, "in"), mode=0o700)
        os.makedirs(os.path.join(jdir, "out"), mode=0o700)
        job = Job(id=jid, op=op, dir=jdir, client=client)
        self.jobs[jid] = job
        return job

    async def submit(self, job: Job) -> None:
        await self.queue.put(job.id)

    def get(self, jid: str) -> Job | None:
        return self.jobs.get(jid)

    def delete(self, jid: str) -> bool:
        job = self.jobs.pop(jid, None)
        if not job:
            return False
        if job.proc and job.proc.returncode is None:
            try:
                job.proc.kill()
            except ProcessLookupError:
                pass
        shutil.rmtree(job.dir, ignore_errors=True)
        return True

    # ----- execution ------------------------------------------------------
    async def _worker_loop(self) -> None:
        while True:
            jid = await self.queue.get()
            job = self.jobs.get(jid)
            if not job or job.status != "queued":
                continue
            try:
                await self._run(job)
            except Exception:  # pragma: no cover - defensive
                log.exception("job runner failure op=%s", job.op)
                job.status = "error"
                job.error = "processing_failed"
                job.finished = time.time()

    async def _run(self, job: Job) -> None:
        job.status = "running"
        timeout = settings.ocr_timeout if job.op in ("ocr", "compare") else settings.job_timeout
        env = dict(os.environ)
        env["PDFATY_WORKER_MEMORY_MB"] = str(settings.worker_memory_mb)
        env["OMP_THREAD_LIMIT"] = "1"  # keep tesseract from saturating all cores
        backend_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        started = time.time()
        job.proc = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "app.worker", job.dir,
            cwd=backend_root, env=env,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        try:
            _, stderr = await asyncio.wait_for(job.proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            try:
                os.killpg(job.proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            await job.proc.wait()
            job.status = "error"
            job.error = "timeout"
            job.finished = time.time()
            log.warning("job timeout op=%s after %ss", job.op, timeout)
            return
        # Make sure nothing spawned by the worker (e.g. soffice) survives it.
        try:
            os.killpg(job.proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        job.finished = time.time()
        result_path = os.path.join(job.dir, "result.json")
        data: dict[str, Any] = {}
        try:
            with open(result_path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            pass
        if job.proc.returncode == 0 and data.get("ok"):
            job.status = "done"
            job.progress = 100
            job.outputs = data.get("outputs", [])
            job.result = data.get("result", {})
            job.message = ""
            log.info("job done op=%s in %.1fs outputs=%d", job.op, job.finished - started, len(job.outputs))
        else:
            job.status = "error"
            job.error = data.get("error") or ("out_of_memory" if job.proc.returncode in (-9, 137) else "processing_failed")
            job.error_detail = data.get("detail")
            tail = (stderr or b"")[-600:].decode("utf-8", "replace") if not data else ""
            log.warning("job failed op=%s code=%s rc=%s %s", job.op, job.error, job.proc.returncode, tail.replace("\n", " | "))

    async def _janitor_loop(self) -> None:
        while True:
            await asyncio.sleep(30)
            now = time.time()
            for jid, job in list(self.jobs.items()):
                ref = job.finished or job.created
                limit = settings.result_ttl if job.finished else settings.result_ttl + settings.ocr_timeout
                if now - ref > limit:
                    self.delete(jid)


manager = JobManager()
