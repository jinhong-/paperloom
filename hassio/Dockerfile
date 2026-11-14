# Build Paperloom from the repository's canonical server directory.
# The Home Assistant build action supplies the repository root as the
# build context; local builds should use the same command from the root.
#
# The Node image is selected by the builder for the target platform. It
# provides the Node.js runtime and package manager, while the native
# dependencies are installed for the same target architecture.
ARG BUILDPLATFORM
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
COPY server/web/package.json ./web/package.json
COPY server/scripts/build-web.mjs ./scripts/build-web.mjs
RUN npm ci

COPY server/src/ ./src/
COPY server/web/ ./web/
COPY server/tsconfig.json ./
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
COPY server/package.json server/package-lock.json ./
COPY server/web/package.json ./web/package.json
COPY server/scripts/build-web.mjs ./scripts/build-web.mjs
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/server/dist ./dist
COPY --from=builder /app/server/web/dist ./web/dist
COPY hassio/rootfs/ /

RUN chmod +x /run.sh \
    && mkdir -p /share/paperloom

EXPOSE 8099
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/bin/bash", "/run.sh"]
