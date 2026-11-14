# The Supervisor builds each add-on from its own directory, so the
# Dockerfile cannot copy files from the repository root. The server is
# therefore packaged into this directory before the image is built.
FROM node:22-bookworm-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server
COPY package.json package-lock.json ./
COPY web/package.json ./web/package.json
COPY scripts/build-web.mjs ./scripts/build-web.mjs
RUN npm ci

COPY src/ ./src/
COPY web/ ./web/
COPY tsconfig.json ./
RUN npm run build && npm run build:web

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PAPERLOOM_HOST=0.0.0.0 \
    PAPERLOOM_PORT=8099 \
    PAPERLOOM_DATA_DIR=/share/paperloom

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server
COPY package.json package-lock.json ./
COPY web/package.json ./web/package.json
COPY scripts/build-web.mjs ./scripts/build-web.mjs
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/server/dist ./dist
COPY --from=builder /app/server/web/dist ./web/dist
COPY rootfs/ /

RUN chmod +x /run.sh \
    && mkdir -p /share/paperloom

EXPOSE 8099
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/bin/bash", "/run.sh"]
