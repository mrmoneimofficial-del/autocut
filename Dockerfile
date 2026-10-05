# قصّاص — production image (UI + API + ffmpeg engine in one container)
# Works on: Railway, Render, Fly.io, Hetzner, any VPS, docker run
#
#   docker build -t autocut .
#   docker run -p 3000:3000 -v autocut-data:/app/storage autocut

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
    PORT=3000 \
    HOSTNAME=0.0.0.0

# standalone Next server + the pipeline runner (resolves ../storage/jobs itself)
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/scripts ./scripts
RUN mkdir -p storage/jobs

EXPOSE 3000
CMD ["node", "server.js"]
