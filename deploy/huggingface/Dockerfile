# Hugging Face Space Dockerfile: builds PDFATY directly from the public GitHub repository.
# To update the Space after pushing to GitHub: Space → Settings → "Factory rebuild".
FROM alpine/git:latest AS src
RUN git clone --depth 1 https://github.com/islammo7sn92-coder/pdfaty /src

FROM node:22-bookworm-slim AS web
WORKDIR /app/frontend
COPY --from=src /src/frontend/ ./
RUN npm ci --no-audit --no-fund && npm run build

FROM python:3.13-slim-trixie
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=7860 \
    PDFATY_STATIC_DIR=/app/frontend/dist PDFATY_TMP_DIR=/tmp/pdfaty-jobs HOME=/home/app
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tesseract-ocr tesseract-ocr-ara tesseract-ocr-eng \
      libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui libreoffice-draw-nogui \
      fonts-noto-core fonts-dejavu-core fonts-liberation fonts-crosextra-carlito fonts-crosextra-caladea \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1000 app
WORKDIR /app/backend
COPY --from=src /src/backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY --from=src /src/backend/app ./app
COPY --from=web /app/frontend/dist /app/frontend/dist
USER app
EXPOSE 7860
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-7860} --workers 1 --proxy-headers --forwarded-allow-ips='*'"]
