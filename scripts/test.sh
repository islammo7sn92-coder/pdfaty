#!/usr/bin/env bash
# Runs every check: backend unit+API tests, frontend unit tests, i18n, type-check, build, browser e2e.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "== backend tests";   (cd "$ROOT/backend" && python3 -m pytest -q)
echo "== i18n check";      (cd "$ROOT/frontend" && npm run i18n)
echo "== unit tests";      (cd "$ROOT/frontend" && npm test)
echo "== build";           (cd "$ROOT/frontend" && npm run build)
echo "== browser e2e";     (cd "$ROOT/frontend" && npx playwright test)
