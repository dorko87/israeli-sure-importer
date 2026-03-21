# syntax=docker/dockerfile:1

# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /build

# Install build tools required to compile better-sqlite3 (native addon)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# Prune dev dependencies so the runtime image stays lean
RUN npm prune --omit=dev

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

# Install Chromium and required fonts via apt.
# PUPPETEER_SKIP_CHROMIUM_DOWNLOAD is set so the puppeteer post-install script
# does not download a second Chromium binary.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    TZ=Asia/Jerusalem

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-ipafont-gothic \
      fonts-wqy-zenhei \
      fonts-thai-tlwg \
      fonts-kacst \
      fonts-freefont-ttf \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The node image already provides a 'node' user at uid/gid 1000:1000.
# We use it to run as non-root, matching the Unraid volume ownership convention.
WORKDIR /app

COPY --from=builder --chown=node:node /build/dist/ ./dist/
COPY --from=builder --chown=node:node /build/node_modules/ ./node_modules/

# Runtime directories are bind-mounted from the host; create placeholders so
# the container starts cleanly even if the host paths are pre-created.
RUN mkdir -p /app/logs /app/cache /app/browser-data && chown -R node:node /app

USER node

CMD ["node", "dist/index.js"]
