# Windows: run PDFATY with Docker Desktop and publish it through a free Cloudflare Tunnel.
# Usage (PowerShell, inside the project folder):  .\scripts\cloudflare-tunnel.ps1
# Named tunnel with your own domain:              $env:TUNNEL_TOKEN="xxx"; .\scripts\cloudflare-tunnel.ps1
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
docker compose up -d --build
Write-Host "Waiting for PDFATY to start..."
for ($i = 0; $i -lt 90; $i++) {
  try { Invoke-WebRequest -UseBasicParsing http://localhost:7860/api/health | Out-Null; break } catch { Start-Sleep -Seconds 2 }
}
Write-Host "PDFATY is running on http://localhost:7860"
if ($env:TUNNEL_TOKEN) {
  cloudflared tunnel --no-autoupdate run --token $env:TUNNEL_TOKEN
} else {
  cloudflared tunnel --no-autoupdate --url http://localhost:7860
}
