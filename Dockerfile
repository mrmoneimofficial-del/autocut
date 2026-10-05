# قصّاص — production image (UI + API + ffmpeg engine in one container)
#
# Works on: Railway, Render, Fly.io, any VPS, docker run — or Hugging Face Spaces (PRO $9/mo since 2025)
#
#   docker build -t autocut .
#   docker run -p 3000:3000 -e PORT=3000 -v autocut-data:/app/storage autocut
#
# Free hosting notes (Oct 2026):
#   * Hugging Face Spaces now requires a PRO subscription ($9/mo) for Docker SDK
#   * Free alternatives shipped in this repo: colab.ipynb (one-click Colab) and
#     modal_app.py (Modal — $30/month free credits, deploys THIS Dockerfile)

# ---------- build stage ----------
FROM node:22-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
# next build + stage static/public into .next/standalone (see package.json "build")
RUN npm run build

# ---------- runtime stage ----------
FROM node:22-slim
WORKDIR /app

# ffmpeg = the whole engine (scan, chunk render, concat, verify)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=7860 \
    HOSTNAME=0.0.0.0

# standalone Next server + the pipeline runner (resolves ../storage/jobs itself)
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/scripts ./scripts
RUN mkdir -p storage/jobs && chown -R node:node /app

# non-root (UID 1000) — required by HF Spaces, good practice everywhere.
# ports > 1024 (7860/3000) bind fine as non-root.
USER node

EXPOSE 7860
CMD ["node", "server.js"]
