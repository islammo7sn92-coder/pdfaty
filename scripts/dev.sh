#!/usr/bin/env bash
# Local development: API on :8000 (auto-reload) + Vite dev server on :5173 (proxying /api).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
(cd "$ROOT/backend" && python3 -m uvicorn app.main:app --reload --port 8000) &
API=$!
trap 'kill $API 2>/dev/null' EXIT
cd "$ROOT/frontend" && npm run dev
