# قصّاص — production image (UI + API + ffmpeg engine in one container)
#
# Works on: Hugging Face Spaces (free), Railway, Render, Fly.io, any VPS, docker run
#
#   docker build -t autocut .
#   docker run -p 3000:3000 -e PORT=3000 -v autocut-data:/app/storage autocut
#
# Hugging Face Spaces notes:
#   * Spaces run containers as UID 1000 → we run as the built-in `node` user (UID 1000)
#   * Spaces expect the app on port 7860 (default here; Railway/VPS inject PORT env)
#   * Put this in the Space's README.md YAML:
#       ---
#       title: Qattaas
#       emoji: ✂️
#       colorFrom: orange
#       colorTo: yellow
#       sdk: docker
#       app_port: 7860
#       ---

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
