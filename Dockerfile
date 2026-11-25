# Vigie image, published as ghcr.io/hiteafr/vigie (linux/amd64 and linux/arm64) by
# .github/workflows/release.yml on each version tag. Local build:
#   VIGIE_IMAGE=vigie:local docker compose build      (docker-compose.yml, REVISION through VIGIE_REVISION)
#   docker build --build-arg REVISION="$(git rev-parse HEAD)" -t vigie:local .
#
# Base: Node 22 (same major as production and CI; engines >=22.13), Debian bookworm slim, pinned
# by exact version AND by digest of the multi-architecture index. Digest read on 2026-11-11 from
# the Docker Hub registry (Docker-Content-Digest header of the node:22.23.4-bookworm-slim
# manifest), equal to the sha256 of the received body and to the digest given by the
# hub.docker.com API. To change the version: change BOTH (same line, three times), never a tag
# alone (server/test/docker.test.js refuses a FROM without @sha256).
#
# Stages: client (npm ci, vite build); server dependencies (npm ci --omit=dev); runtime. The client
# stage runs on the platform of the build machine ($BUILDPLATFORM): its output (static files) is the
# same on every architecture, so a multi-platform build emulates only the two other stages.
# Lockfiles only, never npm install. Nothing from .env, config.json, data/ or .git in the context
# (.dockerignore).

# --- 1. client: Vite build ------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS client
WORKDIR /src/client
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY client/ ./
RUN npm run build

# --- 2. server: production dependencies -----------------------------------------------------------
FROM node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS server-deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# --- 3. runtime -----------------------------------------------------------------------------------
FROM node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
# openssh-client: dash-report agents over SSH; iproute2: ip neigh (Network module);
# ca-certificates: outgoing HTTPS. Nothing else (no arp-scan: separate companion, docker/net-scan)
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-client iproute2 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server
COPY --from=server-deps /app/server/node_modules ./node_modules
COPY server/ ./
COPY --from=client /src/client/dist /app/client/dist
COPY scripts/vendor-icons.mjs /app/scripts/vendor-icons.mjs
COPY docker/entrypoint.sh /usr/local/bin/vigie-entrypoint

# built commit, read by /api/healthz (REVISION file at the root of the code); empty: no file
# (commit null). A value that is not a git hash is refused
ARG REVISION=
RUN case "$REVISION" in \
      '') ;; \
      *[!0-9a-f]*) echo "REVISION: git hash expected (0-9a-f, 7 to 40 characters)" >&2; exit 1 ;; \
      *) [ ${#REVISION} -ge 7 ] && [ ${#REVISION} -le 40 ] || { echo "REVISION: 7 to 40 characters" >&2; exit 1; }; \
         printf '%s\n' "$REVISION" > /app/REVISION ;; \
    esac \
  && chmod 755 /usr/local/bin/vigie-entrypoint \
  && install -d -o node -g node -m 0750 /etc/vigie /etc/vigie/pki /var/lib/vigie
LABEL org.opencontainers.image.title="Vigie" \
      org.opencontainers.image.revision="$REVISION"

# paths of the example systemd unit (deploy/vigie.service.example). NO LISTEN_HOST: safe default
# (127.0.0.1), the listen address is chosen in config.json (listenHost)
ENV NODE_ENV=production \
    CONFIG_PATH=/etc/vigie/config.json \
    PKI_DIR=/etc/vigie/pki \
    STATE_DIRECTORY=/var/lib/vigie \
    ENV_FILE=/etc/vigie/vigie.env \
    PORT=8088

# uid 1000 of the official image; port 8088: no capability needed
USER node
EXPOSE 8088
VOLUME ["/var/lib/vigie", "/etc/vigie"]

# liveness: /api/healthz on loopback (127.0.0.1 is always an allowed host), without curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8088)+'/api/healthz',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))"]

ENTRYPOINT ["/usr/local/bin/vigie-entrypoint"]
CMD ["serve"]
