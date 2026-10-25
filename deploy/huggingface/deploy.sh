#!/usr/bin/env bash
# Publish PDFATY to a free Hugging Face Docker Space.
# Requirements: git, git-lfs (optional), a Hugging Face account and a WRITE token.
# Usage: HF_TOKEN=hf_xxx HF_SPACE=username/pdfaty ./deploy/huggingface/deploy.sh
set -euo pipefail
: "${HF_TOKEN:?set HF_TOKEN (https://huggingface.co/settings/tokens, role: write)}"
: "${HF_SPACE:?set HF_SPACE, e.g. yourname/pdfaty}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Create the Space if it doesn't exist (Docker SDK, public).
curl -fsS -X POST https://huggingface.co/api/repos/create \
  -H "Authorization: Bearer $HF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"type\":\"space\",\"name\":\"${HF_SPACE#*/}\",\"organization\":null,\"sdk\":\"docker\",\"private\":false}" \
  >/dev/null 2>&1 || true

git clone "https://user:${HF_TOKEN}@huggingface.co/spaces/${HF_SPACE}" "$WORK/space"
rsync -a --delete --exclude .git --exclude node_modules --exclude 'frontend/dist' --exclude 'frontend/public/pdfjs' \
  --exclude 'frontend/e2e/.samples' --exclude '__pycache__' --exclude '.pytest_cache' "$ROOT/" "$WORK/space/"
cp "$ROOT/deploy/huggingface/README.md" "$WORK/space/README.md"   # Space metadata header
cd "$WORK/space"
git add -A
git -c user.name="pdfaty-deploy" -c user.email="deploy@localhost" commit -m "Deploy PDFATY" || true
git push origin HEAD:main
echo "Deployed. The app will be available at: https://${HF_SPACE/\//-}.hf.space (build takes ~10 minutes)."
