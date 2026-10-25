#!/usr/bin/env bash
# Publish PDFATY running on THIS machine through a free Cloudflare Tunnel (HTTPS link).
# 1) needs Docker and cloudflared installed: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
# 2) quick mode (no account): prints a temporary https://xxxx.trycloudflare.com link
#    named mode (free Cloudflare account + your domain):  TUNNEL_TOKEN=xxx ./scripts/cloudflare-tunnel.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
docker compose up -d --build
echo "Waiting for PDFATY to start..."
for _ in $(seq 1 60); do curl -fs http://localhost:7860/api/health >/dev/null && break; sleep 2; done
if [ -n "${TUNNEL_TOKEN:-}" ]; then
  exec cloudflared tunnel --no-autoupdate run --token "$TUNNEL_TOKEN"
else
  exec cloudflared tunnel --no-autoupdate --url http://localhost:7860
fi
