#!/usr/bin/env bash
# Production-like local run without Docker (needs tesseract + libreoffice installed).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
(cd "$ROOT/frontend" && npm ci && npm run build)
cd "$ROOT/backend"
pip install -r requirements.txt
PDFATY_STATIC_DIR="$ROOT/frontend/dist" exec python3 -m uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --workers 1
