"""Runtime configuration, read once from environment variables (see .env.example)."""
from __future__ import annotations

import os
import shutil
import tempfile
from dataclasses import dataclass, field


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def _bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Settings:
    max_upload_mb: int = field(default_factory=lambda: _int("PDFATY_MAX_UPLOAD_MB", 100))
    max_total_mb: int = field(default_factory=lambda: _int("PDFATY_MAX_TOTAL_MB", 250))
    max_files: int = field(default_factory=lambda: _int("PDFATY_MAX_FILES", 30))
    max_pages: int = field(default_factory=lambda: _int("PDFATY_MAX_PAGES", 2000))
    job_timeout: int = field(default_factory=lambda: _int("PDFATY_JOB_TIMEOUT", 300))
    ocr_timeout: int = field(default_factory=lambda: _int("PDFATY_OCR_TIMEOUT", 1800))
    max_concurrent_jobs: int = field(default_factory=lambda: _int("PDFATY_MAX_CONCURRENT_JOBS", 2))
    max_queue: int = field(default_factory=lambda: _int("PDFATY_MAX_QUEUE", 30))
    max_jobs_per_ip: int = field(default_factory=lambda: _int("PDFATY_MAX_ACTIVE_JOBS_PER_IP", 4))
    result_ttl: int = field(default_factory=lambda: _int("PDFATY_RESULT_TTL", 900))
    rate_limit_per_min: int = field(default_factory=lambda: _int("PDFATY_RATE_LIMIT_PER_MIN", 40))
    worker_memory_mb: int = field(default_factory=lambda: _int("PDFATY_WORKER_MEMORY_MB", 3072))
    trust_proxy: bool = field(default_factory=lambda: _bool("PDFATY_TRUST_PROXY", True))
    tmp_dir: str = field(
        default_factory=lambda: os.environ.get("PDFATY_TMP_DIR")
        or os.path.join(tempfile.gettempdir(), "pdfaty-jobs")
    )
    static_dir: str = field(
        default_factory=lambda: os.environ.get("PDFATY_STATIC_DIR")
        or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "..", "frontend", "dist")
    )
    log_level: str = field(default_factory=lambda: os.environ.get("PDFATY_LOG_LEVEL", "INFO"))

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    @property
    def max_total_bytes(self) -> int:
        return self.max_total_mb * 1024 * 1024


settings = Settings()


def tool_available(name: str) -> bool:
    return shutil.which(name) is not None


def soffice_path() -> str | None:
    return shutil.which("soffice") or shutil.which("libreoffice")
